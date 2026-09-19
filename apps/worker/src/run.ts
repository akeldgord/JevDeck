import { Database } from 'bun:sqlite';
import {
  createGenerationProvider,
  describeProviderConfig,
  resolveProviderConfig,
  type ProviderConfig,
} from '@jevdeck/providers';
import { GenerationWorker } from './worker';

/**
 * Standalone worker process.
 *
 * The API already runs the worker in-process, which is the simplest arrangement for a
 * self-hosted installation. This entry point exists for the other one: scale the API and the
 * generation separately, or keep a long provider call off the request-serving process. The queue
 * lives in the database and claiming is atomic, so both arrangements work against the same file,
 * and either can be restarted without losing a job.
 *
 * The API owns the schema. Start it once before pointing this at a fresh database.
 */

const DEFAULT_DB_PATH = './data/jevdeck.sqlite';
/** How long to wait between polls when the queue is empty. */
const DEFAULT_POLL_MS = 1_500;

function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

export interface StandaloneWorkerOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the resolved provider, for tests. */
  provider?: ReturnType<typeof createGenerationProvider>;
}

/** Starts polling and returns the worker, so a caller can stop it. */
export function startStandaloneWorker(options: StandaloneWorkerOptions = {}): {
  worker: GenerationWorker;
  db: Database;
} {
  const env = options.env ?? process.env;

  const provider = options.provider ?? (() => {
    const providerConfig: ProviderConfig | null = resolveProviderConfig(env);
    if (!providerConfig) {
      throw new Error(
        'No generation provider is configured. Set JEVDECK_PROVIDER_API_KEY (or OPENAI_API_KEY / ' +
          'ANTHROPIC_API_KEY), and JEVDECK_PROVIDER_BASE_URL for a self-hosted endpoint.'
      );
    }
    return createGenerationProvider(providerConfig);
  })();

  const db = openDatabase(env.JEVDECK_DB_PATH ?? DEFAULT_DB_PATH);

  const worker = new GenerationWorker(db, provider, {
    workerId: env.JEVDECK_WORKER_ID ?? `wrk_${crypto.randomUUID()}`,
    pollIntervalMs: Number(env.JEVDECK_WORKER_POLL_MS ?? DEFAULT_POLL_MS) || DEFAULT_POLL_MS,
    onEvent: event => {
      if (event.type === 'idle') return;
      console.log(
        `[jevdeck-worker] ${event.type}${event.jobId ? ` ${event.jobId}` : ''}`,
        event.message ?? ''
      );
    },
  });

  return { worker, db };
}

if (import.meta.main) {
  const providerConfig = resolveProviderConfig(process.env);

  if (!providerConfig) {
    console.error(
      '[jevdeck-worker] no generation provider is configured, so there is nothing to run. ' +
        'Set JEVDECK_PROVIDER_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY).'
    );
    process.exit(1);
  }

  const description = describeProviderConfig(providerConfig);
  const { worker, db } = startStandaloneWorker({ provider: createGenerationProvider(providerConfig) });

  worker.start();

  console.log(
    `[jevdeck-worker] started as ${worker.workerId} · provider ${description.kind} ` +
      `(${description.model}, decisions via ${description.decisionModel})`
  );
  console.log(`[jevdeck-worker] database: ${process.env.JEVDECK_DB_PATH ?? DEFAULT_DB_PATH}`);

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[jevdeck-worker] ${signal} received, shutting down`);
    worker.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
