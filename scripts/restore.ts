import { describeSummary, restoreBackup } from '../apps/api/src/db/backup';

/**
 * Restores an installation from a backup.
 *
 *   bun scripts/restore.ts <backup-path> [target-path] [--force]
 *
 * Default target: `JEVDECK_DB_PATH`, or `./data/jevdeck.sqlite`. The backup is opened, checked for
 * the tables a JevDeck installation must have and for SQLite's own integrity check *before*
 * anything is overwritten, and an existing database is only replaced when `--force` is passed —
 * losing a working installation to a mistyped path is not a recoverable mistake.
 *
 * In a container, run it against the mounted volume:
 *   docker compose exec api bun scripts/restore.ts /data/backups/jevdeck.sqlite --force
 */

const args = process.argv.slice(2).filter(argument => argument !== '--force');
const force = process.argv.includes('--force');

const backupPath = args[0];
const databasePath = args[1] ?? process.env.JEVDECK_DB_PATH ?? './data/jevdeck.sqlite';

if (!backupPath) {
  console.error(
    'Usage: bun scripts/restore.ts <backup-path> [target-path] [--force]\n' +
      'Without --force an existing database at the target path is left untouched.'
  );
  process.exit(2);
}

try {
  const report = restoreBackup({ backupPath, databasePath, force });
  console.log(describeSummary('restore', report));
} catch (error) {
  console.error(
    `[jevdeck] restore failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}
