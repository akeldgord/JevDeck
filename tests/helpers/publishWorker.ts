/**
 * A worker process that can be killed at a chosen point of a run's finalisation.
 *
 * Recovery from a crash cannot be tested in-process: a `try`/`finally` in the same process runs, so
 * the interrupted state never exists. This entry point is spawned as a child, driven against the
 * same on-disk database and the same loopback provider every other test uses, and killed with
 * `SIGKILL` at a barrier the parent chooses. Nothing here is reachable from the product's own
 * configuration or requests: the before-commit barrier is a trigger the parent installs in the
 * database, and the after-commit barrier is simply where this process stops.
 *
 * Usage:
 *   bun tests/helpers/publishWorker.ts <dbPath> <providerBaseUrl> <jobId> <barrierDir> \
 *     <before-commit|after-commit> <workerId>
 *
 * `before-commit`: the parent has installed a deliberately slow trigger on the last statement of
 * the publication, so this process sits inside an open, uncommitted transaction for seconds. It is
 * not expected to return; the parent kills it while the transaction is open.
 *
 * `after-commit`: the run finishes, this process writes `<barrierDir>/after-commit` and blocks, so
 * the parent kills it immediately after the commit rather than after an orderly shutdown.
 */

import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGenerationProvider } from '../../packages/providers/src';
import { claimNextJob } from '../../apps/worker/src/queue';
import { runGenerationJob } from '../../apps/worker/src/pipeline';

const [dbPath, providerBaseUrl, jobId, barrierDir, killPoint, workerId] = process.argv.slice(2);

if (!dbPath || !providerBaseUrl || !jobId || !barrierDir || !killPoint || !workerId) {
  console.error('publishWorker: missing arguments');
  process.exit(2);
}

const db = new Database(dbPath);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');

const provider = createGenerationProvider({
  kind: 'openai-compatible',
  apiKey: 'test-provider-key-not-a-secret',
  model: 'stub-model',
  decisionModel: 'stub-model',
  baseUrl: providerBaseUrl,
  timeoutMs: 5_000,
  temperature: 0.2,
  jsonMode: true,
});

const job = claimNextJob(db, { workerId });

if (!job || job.id !== jobId) {
  console.error(`publishWorker: claimed ${job?.id ?? 'nothing'} instead of ${jobId}`);
  process.exit(3);
}

await runGenerationJob(db, provider, job, { workerId, leaseSeconds: 120 });

if (killPoint === 'after-commit') {
  writeFileSync(join(barrierDir, 'after-commit'), String(process.pid));

  // A bounded spin rather than an await: the process must be alive, with its connection open, when
  // the parent kills it. The bound is a failsafe so a broken test fails rather than hangs.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) process.exit(0);
  }
}

process.exit(0);
