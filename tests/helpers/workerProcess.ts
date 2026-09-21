/**
 * Driving a worker *process* from a test: spawn it, wait for its barrier, kill it, read what it left.
 *
 * Every recovery test in this repository needs the same three things and they are all here, once:
 * a way to start `workerChild.ts` against the shared database, a way to know it has reached the
 * point the test means to interrupt, and a way to stop it with `SIGKILL` so that nothing it would
 * have done afterwards — no `finally`, no orderly shutdown, no second flush — ever happens.
 *
 * The barrier is a file the child writes, so the parent waits on a fact rather than on a duration.
 * Most points then block until the parent kills them (`Atomics.wait`). The one inside the publication
 * is different: it writes the same file and then kills itself, because the parent can only observe
 * *that* the write lock is held, never *which* transaction holds it — and a test that kills the run
 * somewhere else while reporting success is worse than one that fails. See `workerChild.ts`.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PROJECT_ROOT = join(import.meta.dir, '..', '..');

/** A directory for one process's barrier file and result, beside the test's own scratch space. */
export function barrierDirFor(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `jevdeck-${prefix}-`));
}

export interface WorkerResult {
  workerId: string;
  jobId: string;
  state: string;
  conceptCount: number;
  cardCount: number;
  errorCode?: string;
  message?: string;
}

export interface WorkerProcessOutcome {
  /** `null` when a signal ended the process, which is what a kill does. */
  exitCode: number | null;
  signal: string | null;
  /** Whether the child reached its barrier. */
  barrierReached: boolean;
  /** What the child reported about its own run, when it finished one. */
  result: WorkerResult | null;
  stderr: string;
}

/**
 * Runs one worker process against the shared database.
 *
 * `plan: 'none'` starts a fresh worker that runs the job to its end — which is what the recovery
 * half of a recovery test is: not the interrupted process somehow continuing, but a new process
 * picking the job up from what the interrupted one committed.
 */
export async function runWorkerProcess(options: {
  dbPath: string;
  providerUrl: string;
  jobId: string;
  workerId: string;
  /** A `workerChild.ts` plan: `none`, `before-commit`, `after-commit`, or a call barrier. */
  plan?: string;
  /** Where the child writes its barrier and its result. Created by the caller. */
  barrierDir?: string;
  /** Kill the child once it has reached its barrier, rather than letting it finish. */
  killAtBarrier?: boolean;
  /** The barrier to wait for: the child's file, or nothing when the caller only wants the result. */
  barrier?: 'file' | 'none';
  leaseSeconds?: number;
  timeoutMs?: number;
}): Promise<WorkerProcessOutcome> {
  const plan = options.plan ?? 'none';
  const barrierDir = options.barrierDir ?? '';
  const barrierPath = barrierDir ? join(barrierDir, 'barrier') : '';
  const resultPath = barrierDir ? join(barrierDir, 'result.json') : '';
  const timeoutMs = options.timeoutMs ?? 60_000;

  const child = Bun.spawn(
    [
      'bun',
      'tests/helpers/workerChild.ts',
      options.dbPath,
      options.providerUrl,
      options.jobId,
      barrierDir,
      plan,
      options.workerId,
      String(options.leaseSeconds ?? 120),
    ],
    { cwd: PROJECT_ROOT, stdout: 'pipe', stderr: 'pipe' }
  );

  const barrier = options.barrier ?? (plan === 'none' ? 'none' : 'file');
  const deadline = Date.now() + timeoutMs;
  let barrierReached = false;

  if (barrier !== 'none') {
    while (Date.now() < deadline) {
      // A child that has exited can never reach a barrier: failing here rather than waiting out the
      // whole timeout is what keeps a broken barrier a readable test failure.
      if (child.exitCode !== null) break;

      if (existsSync(barrierPath)) {
        barrierReached = true;
        break;
      }

      await Bun.sleep(10);
    }
  }

  if (options.killAtBarrier && barrierReached) {
    child.kill(9);
  }

  // Bounded either way: a child that never reaches its barrier, or never finishes, fails the test
  // rather than hanging the suite.
  const finished = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(Math.max(1, deadline - Date.now())).then(() => false),
  ]);

  if (!finished) child.kill(9);

  const exitCode = await child.exited;
  const stderr = await new Response(child.stderr as ReadableStream).text();

  let result: WorkerResult | null = null;
  if (resultPath && existsSync(resultPath)) {
    try {
      result = JSON.parse(readFileSync(resultPath, 'utf8')) as WorkerResult;
    } catch {
      result = null;
    }
  }

  return {
    exitCode,
    signal: child.signalCode ?? null,
    barrierReached,
    result,
    stderr,
  };
}
