/**
 * The test worker process: one real run of the real pipeline, in its own process, against a
 * temporary on-disk database and the controlled loopback provider.
 *
 * Recovery cannot be tested in-process. A `try`/`finally` in the same process runs, a caught
 * exception unwinds the stack, and the interrupted state never exists — so the state a crash leaves
 * behind has to be produced by an actual crash, and read back by somebody else.
 *
 * This entry point is spawned by the parent and killed with `SIGKILL` at a point the parent
 * chooses. Nothing here is reachable from the product: it is not imported by any package, it takes
 * its whole configuration from argv, and the barriers it installs are a wrapper around the provider
 * it builds for itself. Production exposes no fault-injection endpoint and reads no test barrier.
 *
 * ```text
 * bun tests/helpers/workerChild.ts <dbPath> <providerBaseUrl> <jobId> <barrierDir> <plan> <workerId> [leaseSeconds]
 * ```
 *
 * The plans:
 *
 *   `none`                          claim the job, run it to its end, write `result.json`, exit.
 *   `before-commit`                 run it, and kill this process from *inside* the final
 *                                   publication, after its last statement and before the commit is
 *                                   issued. It is not expected to return: it never reports a result
 *                                   and the transaction it died in is rolled back.
 *   `after-commit`                  run it to completion, write the barrier and block. The parent
 *                                   kills it immediately after the commit rather than after an
 *                                   orderly shutdown.
 *   `after-dispatch:<task>:<n>`     stop inside the n-th `send()` of `<task>`, *after* the response
 *                                   has been received and *before* it is recorded: the state of a
 *                                   process that died with a paid answer in its hand.
 *   `before-call:<task>:<n>`        stop at the entry of the n-th prepared `<task>` call. Nothing of
 *                                   that operation exists yet — no durable record, no hold, no
 *                                   request — which is the state after the *previous* result (or
 *                                   checkpoint) was persisted.
 *
 * `<task>` is the provider-level task name the stub provider records: `extract_concepts`,
 * `generate_cards` (also used for a bounded repair) or `assess_claim_support`.
 *
 * A barrier writes `<barrierDir>/barrier` and then blocks the thread with `Atomics.wait`, so it
 * costs no CPU and cannot be missed by a poll. Its timeout is a failsafe: a test that never kills
 * this process fails on its own assertion instead of hanging the suite.
 */

import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createGenerationProvider,
  type GenerationProvider,
  type PreparedCall,
} from '../../packages/providers/src';
import { claimNextJob } from '../../apps/worker/src/queue';
import { runGenerationJob } from '../../apps/worker/src/pipeline';

const [dbPath, providerBaseUrl, jobId, barrierDir, plan, workerId, leaseSecondsRaw] =
  process.argv.slice(2);

if (!dbPath || !providerBaseUrl || !jobId || !barrierDir || !plan || !workerId) {
  console.error('workerChild: missing arguments');
  process.exit(2);
}

const leaseSeconds = Number(leaseSecondsRaw ?? '') || 120;

/** How long a stopped process waits to be killed before giving up and failing the test. */
const BARRIER_FAILSAFE_MS = 30_000;

// ---------------------------------------------------------------------------
// Barriers
// ---------------------------------------------------------------------------

/**
 * Writes the barrier file and blocks this thread until the parent kills the process.
 *
 * Synchronous on purpose. A `before-call` barrier fires while the pipeline is *preparing* a call,
 * which is not an `await` point, so an asynchronous wait would return and the run would carry on
 * past the point the test is trying to hold it at. `Atomics.wait` blocks the thread itself, so the
 * process stops exactly here, holding its database connection open, and the parent sees the barrier
 * file on disk.
 */
function stopAt(label: string): never {
  writeFileSync(join(barrierDir, 'barrier'), `${label} pid=${process.pid}`);

  // A timer cannot fire while the thread is blocked, so the failsafe is the wait's own timeout.
  const gate = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(gate, 0, 0, BARRIER_FAILSAFE_MS);

  console.error(`workerChild: nobody killed this process at ${label}`);
  process.exit(4);
}

/**
 * Makes this process its own kill point inside the final publication.
 *
 * The point before the commit sits inside a database transaction rather than at a call boundary, so
 * no provider wrapper can reach it. Waiting for the write lock from the parent instead cannot say
 * *which* transaction holds it: on a loaded machine an ordinary write can be seen held twice a few
 * hundred milliseconds apart, and the parent then kills the run somewhere in its last batch rather
 * than inside the publication — which is a test that reports the wrong thing rather than a test that
 * fails. So the process stops itself here, from the only place that knows the fact for certain.
 *
 * `finaliseWithPublication` runs its body through `db.transaction(...).immediate()`, so wrapping
 * that one method puts this code after the publication's last statement and before the commit it is
 * part of. Reading the job row here reads the open transaction's own writes, which no other
 * connection can see: the row says `completed` for exactly as long as the commit has not been
 * issued, and a rollback afterward leaves the run exactly as it was before the publication began.
 */
function publicationKillPoint(db: Database, jobId: string): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'transaction') {
        return (body: () => unknown) =>
          target.transaction(() => {
            const result = body();

            const row = target
              .query('SELECT state FROM generation_jobs WHERE id = ?')
              .get(jobId) as { state: string } | null;

            if (row?.state === 'completed') {
              writeFileSync(join(barrierDir, 'barrier'), `before-commit pid=${process.pid}`);
              // Immediate and not catchable: nothing after this line runs, no `finally` runs, and
              // the transaction this process died inside is never committed.
              process.kill(process.pid, 'SIGKILL');
            }

            return result;
          });
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database;
}

type Stop =
  | { kind: 'after-dispatch' | 'before-call'; task: string; occurrence: number }
  | null;

function parsePlan(value: string): Stop {
  for (const kind of ['after-dispatch', 'before-call'] as const) {
    if (!value.startsWith(`${kind}:`)) continue;
    const [, task, occurrence] = value.split(':');
    const n = Number(occurrence);
    if (!task || !Number.isInteger(n) || n < 1) break;
    return { kind, task, occurrence: n };
  }
  return null;
}

/**
 * Wraps the provider so the parent can stop this process at a call boundary.
 *
 * The wrapper counts *prepared* calls and *sent* calls separately, because the two barriers are
 * about different moments: `before-call` fires on preparation, where the pipeline has not written
 * anything about the operation yet, and `after-dispatch` fires once the response has come back,
 * where the durable record still says `dispatched` and the response does not exist as a reusable
 * result. Only the three `prepare*` methods the pipeline actually uses are counted; the convenience
 * wrappers are built on top of them so they cannot bypass a barrier.
 */
function barrierProvider(raw: GenerationProvider, stop: Stop): GenerationProvider {
  const prepared = new Map<string, number>();
  const sent = new Map<string, number>();

  function around<T>(task: string, make: () => PreparedCall<T>): PreparedCall<T> {
    const preparedNow = (prepared.get(task) ?? 0) + 1;
    prepared.set(task, preparedNow);

    if (stop?.kind === 'before-call' && stop.task === task && stop.occurrence === preparedNow) {
      stopAt(`before-call:${task}:${preparedNow}`);
    }

    const call = make();

    return {
      ...call,
      async send() {
        const response = await call.send();
        const sentNow = (sent.get(task) ?? 0) + 1;
        sent.set(task, sentNow);

        if (
          stop?.kind === 'after-dispatch' &&
          stop.task === task &&
          stop.occurrence === sentNow
        ) {
          stopAt(`after-dispatch:${task}:${sentNow}`);
        }

        return response;
      },
    };
  }

  // Spread rather than rebuilt field by field: everything the provider carries that a wrapper does
  // not deliberately replace — `info`, and the prompt versions and hashes its answers were produced
  // under — has to travel with it, because the pipeline records those in the fingerprint a run's
  // saved progress is keyed to. A wrapper that dropped them would give this process a *different*
  // fingerprint from the one that wrote the records, and the run would silently re-pay for work it
  // had already bought — which is the bug this test entry point exists to catch, not to have.
  return {
    ...raw,
    prepareConceptExtraction: request =>
      around('extract_concepts', () => raw.prepareConceptExtraction(request)),
    prepareCardGeneration: request =>
      around('generate_cards', () => raw.prepareCardGeneration(request)),
    prepareClaimSupport: request =>
      around('assess_claim_support', () => raw.prepareClaimSupport(request)),
    async extractConcepts(request) {
      const call = this.prepareConceptExtraction(request);
      return call.parse(await call.send());
    },
    async generateCards(request) {
      const call = this.prepareCardGeneration(request);
      return call.parse(await call.send());
    },
    async assessClaimSupport(request) {
      const call = this.prepareClaimSupport(request);
      return call.parse(await call.send());
    },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const db = new Database(dbPath);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');

const provider = barrierProvider(
  createGenerationProvider({
    kind: 'openai-compatible',
    apiKey: 'test-provider-key-not-a-secret',
    model: 'stub-model',
    decisionModel: 'stub-model',
    baseUrl: providerBaseUrl,
    timeoutMs: 5_000,
    temperature: 0.2,
    jsonMode: true,
  }),
  parsePlan(plan)
);

const job = claimNextJob(db, { workerId });

if (!job || job.id !== jobId) {
  console.error(`workerChild: claimed ${job?.id ?? 'nothing'} instead of ${jobId}`);
  process.exit(3);
}

// Only the publication plan needs the wrapped connection: the others stop at a provider call, which
// is where a wrapper is the right kind of barrier.
const runDb = plan === 'before-commit' ? publicationKillPoint(db, jobId) : db;

const outcome = await runGenerationJob(runDb, provider, job, { workerId, leaseSeconds });

// The outcome as this process saw it, for the parent to assert against what the database says. A
// worker process that claims a job and runs it is the thing under test; the parent reads this
// rather than re-deriving it.
writeFileSync(
  join(barrierDir, 'result.json'),
  JSON.stringify({ workerId, jobId, ...outcome }, null, 2)
);

if (plan === 'after-commit') {
  stopAt('after-commit');
}

process.exit(0);
