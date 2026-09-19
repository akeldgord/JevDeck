import { createGenerationProvider, describeProviderConfig } from '@jevdeck/providers';
import { GenerationWorker } from '@jevdeck/worker';
import { loadConfig } from './config';
import { initialiseDatabase } from './db';
import { bootstrapStatus } from './auth/bootstrap';
import { startServer } from './server';

/**
 * JevDeck API entrypoint.
 *
 * Opens (and migrates) the database, then serves HTTP. Startup is fatal on a migration failure:
 * running against a schema the code does not match is worse than not starting.
 *
 * The generation worker runs in this process so a self-hosted installation needs one thing
 * running. Jobs are durable rows, not in-memory work, so this is a convenience rather than a
 * requirement — claimNextJob is atomic, and a second worker can be pointed at the same file.
 */
const config = loadConfig();
const { db, migrations } = initialiseDatabase(config.databasePath);

if (migrations.applied.length > 0) {
  console.log(`[jevdeck-api] applied migrations: ${migrations.applied.join(', ')}`);
}

const server = startServer(db, config);
const status = bootstrapStatus(db, Boolean(config.bootstrapToken));

console.log(`[jevdeck-api] listening on http://${server.hostname}:${server.port}`);
console.log(`[jevdeck-api] database: ${config.databasePath}`);
console.log(`[jevdeck-api] app origin: ${config.appOrigin ?? '(from each request)'}`);
console.log(`[jevdeck-api] allowed origins: ${config.allowedOrigins.join(', ')}`);
if (status.required) {
  console.log('[jevdeck-api] no accounts exist yet — create the first administrator at /api/bootstrap');
}

let worker: GenerationWorker | null = null;

if (config.provider && config.generationAvailable && config.workerEnabled) {
  try {
    const provider = createGenerationProvider(config.provider);
    const description = describeProviderConfig(config.provider);

    worker = new GenerationWorker(db, provider, {
      onEvent: event => {
        if (event.type === 'idle') return;
        console.log(
          `[jevdeck-api] worker ${event.type}${event.jobId ? ` ${event.jobId}` : ''}`,
          event.message ?? ''
        );
      },
    });
    worker.start();

    console.log(
      `[jevdeck-api] generation provider: ${description.kind} (${description.model}, decisions via ${description.decisionModel})`
    );
    console.log('[jevdeck-api] generation worker: started');
  } catch (error) {
    // A missing or unreadable prompt is a configuration fault, not something to paper over with a
    // built-in default: the recorded prompt version would then be wrong for every job.
    console.error(
      '[jevdeck-api] could not start the generation worker:',
      error instanceof Error ? error.message : error
    );
    server.stop(true);
    db.close();
    process.exit(1);
  }
} else {
  console.log(
    `[jevdeck-api] generation provider: NOT configured${
      config.provider ? '' : ' (set JEVDECK_PROVIDER_API_KEY or OPENAI_API_KEY)'
    }`
  );
  console.log('[jevdeck-api] generation worker: not started');
}

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[jevdeck-api] ${signal} received, shutting down`);
  worker?.stop();
  server.stop(true);
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
