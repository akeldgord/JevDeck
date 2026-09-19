import { Database } from 'bun:sqlite';
import type { GenerationProvider } from '@jevdeck/providers';
import {
  claimNextJob,
  failJob,
  LEASE_SECONDS,
  toContractJob,
  type GenerationJobRow,
} from './queue';
import { runGenerationJob, type RunOutcome } from './pipeline';

/**
 * The worker loop.
 *
 * It owns no queue of its own: it asks the database for a claimable job, and the database decides
 * whether that job is really available. Two workers can therefore run against the same file, and a
 * worker that dies leaves its job reclaimable once the lease expires rather than losing it.
 */

export type WorkerEventType = 'claimed' | 'completed' | 'failed' | 'retrying' | 'idle' | 'error';

export interface WorkerEvent {
  type: WorkerEventType;
  jobId?: string;
  message?: string;
  outcome?: RunOutcome;
}

export interface WorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  onEvent?: (event: WorkerEvent) => void;
}

export const DEFAULT_POLL_INTERVAL_MS = 1500;

export class GenerationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping polls; one worker runs one job at a time. */
  private ticking = false;

  readonly workerId: string;

  constructor(
    private readonly db: Database,
    private readonly provider: GenerationProvider,
    private readonly options: WorkerOptions = {}
  ) {
    this.workerId = options.workerId ?? `wrk_${crypto.randomUUID()}`;
  }

  private emit(event: WorkerEvent): void {
    this.options.onEvent?.(event);
  }

  /**
   * Claims and runs at most one job.
   *
   * Returns `null` when there was nothing to do, which is the normal state of an idle worker.
   */
  async runOnce(): Promise<RunOutcome | null> {
    const job = claimNextJob(this.db, {
      workerId: this.workerId,
      leaseSeconds: this.options.leaseSeconds ?? LEASE_SECONDS,
    });

    if (!job) {
      this.emit({ type: 'idle' });
      return null;
    }

    return this.runJob(job);
  }

  /** Runs a specific job that has already been claimed. */
  async runJob(job: GenerationJobRow): Promise<RunOutcome> {
    this.emit({ type: 'claimed', jobId: job.id });

    try {
      const outcome = await runGenerationJob(this.db, this.provider, job, {
        workerId: this.workerId,
        leaseSeconds: this.options.leaseSeconds ?? LEASE_SECONDS,
      });

      if (outcome.state === 'completed') {
        this.emit({ type: 'completed', jobId: job.id, outcome });
      } else if (outcome.state === 'pending') {
        this.emit({ type: 'retrying', jobId: job.id, outcome });
      } else {
        this.emit({ type: 'failed', jobId: job.id, outcome });
      }

      return outcome;
    } catch (cause) {
      // A bug in the pipeline must not leave the job leased forever.
      const message = cause instanceof Error ? cause.message : String(cause);
      const state = failJob(this.db, job.id, {
        code: 'pipeline_error',
        message,
        retryable: true,
      });
      this.emit({ type: state === 'pending' ? 'retrying' : 'failed', jobId: job.id, message });

      return { state, conceptCount: 0, cardCount: 0, errorCode: 'pipeline_error', message };
    }
  }

  /** Starts polling. Returns immediately; call `stop()` to end it. */
  start(): void {
    if (this.timer) return;

    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    const tick = async (): Promise<void> => {
      if (this.ticking) return;
      this.ticking = true;
      try {
        await this.runOnce();
      } catch (cause) {
        this.emit({
          type: 'error',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        this.ticking = false;
      }
    };

    this.timer = setInterval(() => {
      void tick();
    }, interval);

    // Do not hold the process open for the poll timer alone.
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }

    void tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** True while a job is being processed. */
  get busy(): boolean {
    return this.ticking;
  }

  /** Wire shape of one job, for tests and diagnostics. */
  jobState(jobId: string): unknown {
    const row = this.db.query('SELECT * FROM generation_jobs WHERE id = ?').get(jobId) as
      | GenerationJobRow
      | null;
    return row ? toContractJob(row) : null;
  }
}
