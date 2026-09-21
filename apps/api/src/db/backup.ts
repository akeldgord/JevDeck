import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Backup and restore for a self-hosted installation.
 *
 * The database *is* the installation: accounts, sessions, documents, the retained original file
 * bytes, decks, cards, evidence, reviews and the usage ledger are all inside one SQLite file. So a
 * backup is one artifact, and nothing else needs collecting — no media directory, no object store.
 *
 * Both operations verify what they produced or read. A backup that cannot be opened, or a restore
 * from a file that is not a JevDeck database, is reported as a failure rather than written over a
 * working installation.
 *
 * Note the write-ahead log: copying the database file alone while the server is running can miss
 * committed transactions still sitting in the `-wal` file. `VACUUM INTO` writes a consistent,
 * fully-checkpointed copy, which is why it is used instead of a file copy.
 */

export interface InstallationSummary {
  documents: number;
  documentVersions: number;
  cards: number;
  users: number;
  decks: number;
  reviews: number;
  usageRows: number;
  /** Migrations recorded as applied, so a restore can be checked against the code's expectations. */
  migrations: string[];
  /** Whether any retained original file is present. Source bytes live in the database as a BLOB. */
  documentsWithSourceBytes: number;
  /**
   * Stored images — the figures, plates and scans that sit beside their version.
   *
   * Counted because a deck whose cards cite a figure is only whole when the figure survives with it:
   * a restore that dropped the media rows would leave every citation pointing at a picture the
   * installation no longer has, and the report would still have read as a success.
   */
  mediaRows: number;
  /**
   * Durable per-call results, and the retained provider attempts they were dispatched under.
   *
   * These are what makes a resumed or interrupted run stop paying twice, so they are part of the
   * installation rather than of a process: a restore that lost them would silently re-charge for
   * work the ledger already records as paid for.
   */
  savedCallResults: number;
  /** The retained attempt records, which hold the accounting evidence for each call. */
  providerAttempts: number;
  /** Runs holding recoverable progress (`generation_jobs` with a checkpoint). */
  runCheckpoints: number;
}

export interface BackupReport extends InstallationSummary {
  path: string;
  bytes: number;
  createdAt: string;
}

export interface RestoreReport extends InstallationSummary {
  path: string;
  bytes: number;
  restoredAt: string;
}

/** The tables a JevDeck installation must have. Used to refuse a file that is not one. */
const REQUIRED_TABLES = [
  'users',
  'sessions',
  'documents',
  'document_versions',
  'source_blocks',
  'sections',
  'decks',
  'cards',
  'evidence',
  'review_events',
  'user_card_state',
  'generation_jobs',
  'media',
  'provider_attempts',
  'operation_results',
  'budget_reservations',
  'usage_records',
  'schema_migrations',
];

export class BackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** Opens a database read-only, for inspection only. */
function openReadOnly(path: string): Database {
  return new Database(path, { readonly: true });
}

/** The underlying reason, kept for the operator, without leaking it as an untyped throw. */
function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function count(db: Database, sql: string): number {
  const row = db.query(sql).get() as { n: number } | null;
  return row?.n ?? 0;
}

/** Reads what an installation holds, and refuses anything that is not one. */
export function summariseInstallation(path: string): InstallationSummary {
  if (!existsSync(path)) {
    throw new BackupError('file_missing', `No database at ${path}.`);
  }

  // A file that is not a database at all fails here, and a truncated one fails on the first
  // query. Both are turned into a typed refusal: a caller restoring from a mistyped path must get
  // "that file is not a JevDeck database", not a raw SQLite error.
  let db: Database;
  try {
    db = openReadOnly(path);
  } catch (cause) {
    throw new BackupError(
      'unreadable_database',
      `That file could not be opened as a database: ${reason(cause)}.`
    );
  }

  try {
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map(row => row.name)
    );

    const missing = REQUIRED_TABLES.filter(table => !tables.has(table));
    if (missing.length > 0) {
      throw new BackupError(
        'not_a_jevdeck_database',
        `That file is not a JevDeck database: it has no ${missing.join(', ')}.`
      );
    }

    const integrity = db.query('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') {
      throw new BackupError(
        'integrity_check_failed',
        `SQLite reported a problem with that file: ${integrity.integrity_check}.`
      );
    }

    return {
      users: count(db, 'SELECT COUNT(*) AS n FROM users'),
      documents: count(db, 'SELECT COUNT(*) AS n FROM documents'),
      documentVersions: count(db, 'SELECT COUNT(*) AS n FROM document_versions'),
      decks: count(db, 'SELECT COUNT(*) AS n FROM decks'),
      cards: count(db, 'SELECT COUNT(*) AS n FROM cards'),
      reviews: count(db, 'SELECT COUNT(*) AS n FROM review_events'),
      usageRows: count(db, 'SELECT COUNT(*) AS n FROM usage_records'),
      documentsWithSourceBytes: count(
        db,
        'SELECT COUNT(*) AS n FROM document_versions WHERE source_bytes IS NOT NULL'
      ),
      mediaRows: count(db, 'SELECT COUNT(*) AS n FROM media'),
      savedCallResults: count(db, 'SELECT COUNT(*) AS n FROM operation_results'),
      providerAttempts: count(db, 'SELECT COUNT(*) AS n FROM provider_attempts'),
      runCheckpoints: count(
        db,
        'SELECT COUNT(*) AS n FROM generation_jobs WHERE checkpoint IS NOT NULL'
      ),
      migrations: (
        db.query('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{
          version: string;
        }>
      ).map(row => row.version),
    };
  } catch (cause) {
    if (cause instanceof BackupError) throw cause;
    throw new BackupError(
      'unreadable_database',
      `That file is not a readable JevDeck database: ${reason(cause)}.`
    );
  } finally {
    db.close();
  }
}

export interface BackupOptions {
  /** The live database, e.g. `JEVDECK_DB_PATH`. */
  databasePath: string;
  /** Where the copy should be written. Overwritten if it already exists. */
  targetPath: string;
  now?: Date;
}

/** Writes a consistent copy of the installation, then verifies it by opening it again. */
export function createBackup(options: BackupOptions): BackupReport {
  const { databasePath, targetPath } = options;
  const createdAt = (options.now ?? new Date()).toISOString();

  if (!existsSync(databasePath)) {
    throw new BackupError('file_missing', `No database at ${databasePath}.`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  rmSync(targetPath, { force: true });
  // A stale write-ahead log beside the target would be read in preference to the copy's header.
  rmSync(`${targetPath}-wal`, { force: true });
  rmSync(`${targetPath}-shm`, { force: true });

  // Opened read-write so the checkpoint can run: it folds committed-but-unflushed pages from the
  // `-wal` file into the database before the copy is taken.
  const source = new Database(databasePath);
  try {
    source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    // Consistent, compacted, and safe while other connections are reading.
    source.run('VACUUM INTO ?', [targetPath]);
  } finally {
    source.close();
  }

  // Opening the copy is the check that it is usable: an unreadable backup is not a backup.
  const summary = summariseInstallation(targetPath);

  return {
    ...summary,
    path: targetPath,
    bytes: statSync(targetPath).size,
    createdAt,
  };
}

export interface RestoreOptions {
  /** The backup to restore from. */
  backupPath: string;
  /** The installation to write to. */
  databasePath: string;
  /** Replace an existing database. Without it, restoring over one is refused. */
  force?: boolean;
}

/**
 * Restores a backup into an installation.
 *
 * The backup is opened and checked *before* anything is overwritten, and an existing installation
 * is only replaced when the caller says so explicitly. The stale `-wal` and `-shm` files beside the
 * destination are removed, because a log belonging to the replaced database must not be replayed
 * into the restored one.
 */
export function restoreBackup(options: RestoreOptions): RestoreReport {
  const { backupPath, databasePath } = options;
  const restoredAt = new Date().toISOString();

  if (!existsSync(backupPath)) {
    throw new BackupError('file_missing', `No backup at ${backupPath}.`);
  }

  const summary = summariseInstallation(backupPath);

  if (existsSync(databasePath) && !options.force) {
    throw new BackupError(
      'destination_exists',
      `${databasePath} already exists. Pass force to replace it.`
    );
  }

  mkdirSync(dirname(databasePath), { recursive: true });
  copyFileSync(backupPath, databasePath);
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });

  // Verify what was written, not what was read. The restored file is the one the installation
  // will actually run from, so it is opened, integrity-checked and compared against the backup's
  // summary — and the report describes it rather than the source of the copy.
  const restored = summariseInstallation(databasePath);

  if (!sameContents(summary, restored)) {
    throw new BackupError(
      'restore_verification_failed',
      `The restored database at ${databasePath} does not hold what the backup recorded. ` +
        'Nothing was deleted, but do not run this installation until it is restored again.'
    );
  }

  return {
    ...restored,
    path: databasePath,
    bytes: statSync(databasePath).size,
    restoredAt,
  };
}

/** Whether two summaries describe the same installation. Used to check a copy, not to compare files. */
function sameContents(a: InstallationSummary, b: InstallationSummary): boolean {
  return (
    a.users === b.users &&
    a.documents === b.documents &&
    a.documentVersions === b.documentVersions &&
    a.decks === b.decks &&
    a.cards === b.cards &&
    a.reviews === b.reviews &&
    a.usageRows === b.usageRows &&
    a.documentsWithSourceBytes === b.documentsWithSourceBytes &&
    a.mediaRows === b.mediaRows &&
    a.savedCallResults === b.savedCallResults &&
    a.providerAttempts === b.providerAttempts &&
    a.runCheckpoints === b.runCheckpoints &&
    a.migrations.join(',') === b.migrations.join(',')
  );
}

/** A one-line description of what was backed up or restored, for a script to print. */
export function describeSummary(
  action: 'backup' | 'restore',
  report: BackupReport | RestoreReport
): string {
  const when = 'createdAt' in report ? report.createdAt : report.restoredAt;

  return (
    `[jevdeck] ${action} ${report.path} (${report.bytes} bytes, ${when}): ` +
    `${report.users} user(s), ${report.documents} document(s) ` +
    `(${report.documentsWithSourceBytes} with retained source), ${report.decks} deck(s), ` +
    `${report.cards} card(s), ${report.reviews} review(s), ${report.usageRows} usage row(s), ` +
    `${report.mediaRows} image(s), ${report.savedCallResults} saved call result(s) ` +
    `(${report.providerAttempts} attempt(s)), ${report.runCheckpoints} run(s) with progress, ` +
    `migrations ${report.migrations.join(', ') || 'none'}`
  );
}
