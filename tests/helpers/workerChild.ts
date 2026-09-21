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
 *   `before-commit`                 run it; the parent has installed a deliberately slow trigger on
 *                                   the last statement of the publication, so this process sits
 *                                   inside an open, uncommitted transaction. It is not expected to
 *                                   return: the parent kills it while the transaction is open.
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

const outcome = await runGenerationJob(db, provider, job, { workerId, leaseSeconds });

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
