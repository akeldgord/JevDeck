import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso, sha256Hex } from '../util';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface MigrationReport {
  applied: string[];
  alreadyApplied: string[];
}

interface MigrationFile {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

/**
 * Opens the database and puts it in a state safe for a multi-request server.
 *
 * Foreign keys are enforced (SQLite leaves them off by default, which would silently
 * allow orphaned rows), and WAL plus a busy timeout keep concurrent readers from
 * failing while a write is in flight.
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  return db;
}

function listMigrationFiles(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`Migration directory is missing or unreadable: ${dir}`);
  }

  return entries
    .filter(name => /^\d+_.+\.sql$/.test(name))
    .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]))
    .map(filename => {
      const sql = readFileSync(join(dir, filename), 'utf8');
      return {
        version: filename.split('_')[0],
        filename,
        sql,
        checksum: sha256Hex(sql),
      };
    });
}

/**
 * Applies every unapplied migration in version order, recording each in
 * `schema_migrations`.
 *
 * A migration whose checksum no longer matches the recorded one is a hard error rather
 * than a silent no-op: editing an applied migration would leave installations that have
 * already run it with a different schema from the one the code expects.
 */
export function applyMigrations(db: Database, dir: string = MIGRATIONS_DIR): MigrationReport {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      filename   TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const recorded = db
    .query('SELECT version, checksum FROM schema_migrations')
    .all() as Array<{ version: string; checksum: string }>;
  const appliedChecksums = new Map(recorded.map(row => [row.version, row.checksum]));

  const report: MigrationReport = { applied: [], alreadyApplied: [] };

  for (const migration of listMigrationFiles(dir)) {
    const previousChecksum = appliedChecksums.get(migration.version);

    if (previousChecksum !== undefined) {
      if (previousChecksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.filename} was modified after it was applied. ` +
            'Add a new migration instead of editing an applied one.'
        );
      }
      report.alreadyApplied.push(migration.version);
      continue;
    }

    const insert = db.prepare(
      'INSERT INTO schema_migrations (version, filename, checksum, applied_at) VALUES (?, ?, ?, ?)'
    );

    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, migration.filename, migration.checksum, nowIso());
    })();

    report.applied.push(migration.version);
  }

  return report;
}

/** Convenience for the server entrypoint: open the database and bring it up to date. */
export function initialiseDatabase(path: string): { db: Database; migrations: MigrationReport } {
  const db = openDatabase(path);
  const migrations = applyMigrations(db);
  return { db, migrations };
}
