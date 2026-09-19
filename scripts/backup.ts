import { createBackup, describeSummary } from '../apps/api/src/db/backup';

/**
 * Writes a backup of the installation.
 *
 *   bun scripts/backup.ts [target-path]
 *
 * Default target: `backups/jevdeck-<timestamp>.sqlite`. Point `JEVDECK_DB_PATH` at the database if
 * it is not in the default location. The copy is verified by opening it before the path is
 * reported, so a successful exit means the backup is readable.
 *
 * In a container, run it against the mounted volume:
 *   docker compose exec api bun scripts/backup.ts /data/backups/jevdeck.sqlite
 */

const databasePath = process.env.JEVDECK_DB_PATH ?? './data/jevdeck.sqlite';
const target =
  process.argv[2] ??
  `backups/jevdeck-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;

try {
  const report = createBackup({ databasePath, targetPath: target });
  console.log(describeSummary('backup', report));
} catch (error) {
  console.error(
    `[jevdeck] backup failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}
