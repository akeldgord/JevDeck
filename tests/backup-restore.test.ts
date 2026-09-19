import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';
import {
  BackupError,
  createBackup,
  restoreBackup,
  summariseInstallation,
} from '../apps/api/src/db/backup';

/**
 * Backup and restore verification.
 *
 * The requirement is not that a copy routine exists but that a restore reproduces the
 * installation: accounts, documents with their retained original bytes, decks, cards, evidence,
 * per-user schedules, review events and the usage ledger. So the fixture holds one row of every
 * kind that would be lost, the round trip runs against real files, and the restored database is
 * reopened through the same `openDatabase` the server uses.
 */

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-backup-'));
const now = '2026-09-19T12:00:00.000Z';

/** The original bytes of an "uploaded" document. Compared byte-for-byte after the round trip. */
const SOURCE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff]);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A real migrated database holding one row of every kind a backup must preserve.
 *
 * Written with direct inserts rather than through the API so the fixture is independent of the
 * request layer: this test is about the database file surviving a copy.
 */
function seed(path: string): void {
  const db = openDatabase(path);
  applyMigrations(db);

  db.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, status, monthly_spend_limit_minor, created_at)
     VALUES ('usr_1', 'admin@jevdeck.test', 'Ada', 'admin', 'argon2id$hash', 'active', 2500, ?)`
  ).run(now);

  db.prepare(
    `INSERT INTO documents (id, owner_id, name, content_hash, byte_size, page_count, created_at)
     VALUES ('doc_1', 'usr_1', 'Textbook.pdf', 'sha256-doc', ?, 2, ?)`
  ).run(SOURCE_BYTES.byteLength, now);

  db.prepare(
    `INSERT INTO document_versions (id, document_id, version, content_hash, source_bytes, created_at)
     VALUES ('dv_1', 'doc_1', 1, 'sha256-doc', ?, ?)`
  ).run(SOURCE_BYTES, now);

  db.prepare(
    `INSERT INTO source_blocks
       (id, document_version_id, page_index, page_label, ordinal, kind, raw_text, normalized_text)
     VALUES ('sb_1', 'dv_1', 1, 'i', 0, 'text', 'Line one\nLine two', 'Line one Line two')`
  ).run();

  db.prepare(
    `INSERT INTO sections
       (id, document_version_id, parent_id, depth, title, page_start, page_end, ordinal)
     VALUES ('sec_1', 'dv_1', NULL, 1, 'Chapter 1', 1, 2, 0)`
  ).run();

  db.prepare(
    `INSERT INTO decks (id, owner_id, document_id, document_version_id, title, description, coverage, card_count, created_at, updated_at)
     VALUES ('dck_1', 'usr_1', 'doc_1', 'dv_1', 'Cardiology', '', 'comprehensive', 1, ?, ?)`
  ).run(now, now);

  db.prepare(
    `INSERT INTO cards (id, deck_id, owner_id, document_version_id, section_id, format, question, answer, tags, validation_result, created_at, updated_at)
     VALUES ('crd_1', 'dck_1', 'usr_1', 'dv_1', 'sec_1', 'qa', 'What is X?', 'X is Y.', '["cardio"]', '{"codes":[]}', ?, ?)`
  ).run(now, now);

  db.prepare(
    `INSERT INTO evidence (id, card_id, document_version_id, source_block_id, page_index, span_start, span_end, excerpt)
     VALUES ('evd_1', 'crd_1', 'dv_1', 'sb_1', 1, 0, 8, 'Line one')`
  ).run();

  db.prepare(
    `INSERT INTO user_card_state (id, user_id, card_id, repetition, interval_days, ease_factor, due_at, suspended, updated_at)
     VALUES ('ucs_1', 'usr_1', 'crd_1', 2, 6, 2.5, ?, 0, ?)`
  ).run('2026-10-01T00:00:00.000Z', now);

  db.prepare(
    `INSERT INTO review_events (id, user_id, card_id, mode, schedule_modified, rating, reviewed_at)
     VALUES ('rev_1', 'usr_1', 'crd_1', 'normal', 1, 4, ?)`
  ).run(now);

  db.prepare(
    `INSERT INTO usage_records (id, user_id, period_key, amount_minor, currency, source, price_version, recorded_at)
     VALUES ('use_1', 'usr_1', '2026-09', 12, 'USD', 'provider_reported', 'v1', ?)`
  ).run(now);

  db.close();
}

function seedPath(name: string): string {
  const path = join(scratch, name);
  seed(path);
  return path;
}

describe('Backup and restore of a real installation', () => {
  it('writes a copy that opens and reports what the installation holds', () => {
    const live = seedPath('live.sqlite');
    const backup = join(scratch, 'backups', 'first.sqlite');

    const report = createBackup({ databasePath: live, targetPath: backup, now: new Date(now) });

    expect(report.path).toBe(backup);
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.users).toBe(1);
    expect(report.documents).toBe(1);
    expect(report.documentVersions).toBe(1);
    expect(report.decks).toBe(1);
    expect(report.cards).toBe(1);
    expect(report.reviews).toBe(1);
    expect(report.usageRows).toBe(1);
    expect(report.documentsWithSourceBytes).toBe(1);
    expect(report.migrations.length).toBeGreaterThan(0);

    // The backup is the artifact that was reported, not a file that merely exists.
    expect(summariseInstallation(backup).cards).toBe(1);
  });

  it('reproduces every row and the retained original bytes', () => {
    const live = seedPath('live-2.sqlite');
    const backup = join(scratch, 'backups', 'second.sqlite');
    const restored = join(scratch, 'restored.sqlite');

    createBackup({ databasePath: live, targetPath: backup });
    const report = restoreBackup({ backupPath: backup, databasePath: restored });

    // The report describes the file that was written, not the one that was read: a restore is only
    // useful if what is now on disk is what the report says.
    expect(report.path).toBe(restored);
    expect(report.bytes).toBe(statSync(restored).size);
    expect(report.cards).toBe(1);
    expect(report.reviews).toBe(1);
    expect(report.documentsWithSourceBytes).toBe(1);

    // Reopened the way the server opens it, so the restored file is usable rather than merely
    // present: migrations are recorded, foreign keys hold and the rows are queryable.
    const db = openDatabase(restored);
    try {
      const again = applyMigrations(db);
      expect(again.applied).toEqual([]);

      expect((db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
      expect((db.query('SELECT COUNT(*) AS n FROM review_events').get() as { n: number }).n).toBe(1);
      expect((db.query('SELECT COUNT(*) AS n FROM usage_records').get() as { n: number }).n).toBe(1);

      const card = db.query('SELECT question, answer FROM cards WHERE id = ?').get('crd_1') as {
        question: string;
        answer: string;
      };
      expect(card.question).toBe('What is X?');
      expect(card.answer).toBe('X is Y.');

      // Parentage and page labels survive, so the restored source is the source.
      const section = db
        .query('SELECT title, depth FROM sections WHERE id = ?')
        .get('sec_1') as { title: string; depth: number };
      expect(section.title).toBe('Chapter 1');

      const block = db
        .query('SELECT kind, page_label, raw_text, normalized_text FROM source_blocks WHERE id = ?')
        .get('sb_1') as {
        kind: string;
        page_label: string | null;
        raw_text: string;
        normalized_text: string;
      };
      expect(block.page_label).toBe('i');
      expect(block.raw_text).toBe('Line one\nLine two');
      expect(block.normalized_text).toBe('Line one Line two');
      expect(block.raw_text).not.toBe(block.normalized_text);

      const bytes = db
        .query('SELECT source_bytes FROM document_versions WHERE id = ?')
        .get('dv_1') as { source_bytes: Uint8Array };
      expect(Array.from(bytes.source_bytes)).toEqual(Array.from(SOURCE_BYTES));
    } finally {
      db.close();
    }
  });

  it('refuses a file that is not a JevDeck database', () => {
    const notAJevDeck = join(scratch, 'other.sqlite');
    const db = openDatabase(notAJevDeck);
    db.exec('CREATE TABLE unrelated (id TEXT)');
    db.close();

    expect(() => summariseInstallation(notAJevDeck)).toThrow(BackupError);
    expect(() => restoreBackup({ backupPath: notAJevDeck, databasePath: join(scratch, 'x.sqlite') }))
      .toThrow(/not a JevDeck database/);
  });

  it('will not overwrite a working installation without being told to', () => {
    const live = seedPath('live-3.sqlite');
    const backup = join(scratch, 'backups', 'third.sqlite');
    createBackup({ databasePath: live, targetPath: backup });

    let code = '';
    try {
      restoreBackup({ backupPath: backup, databasePath: live });
    } catch (error) {
      code = error instanceof BackupError ? error.code : 'unexpected';
    }
    expect(code).toBe('destination_exists');

    // The live installation is untouched by the refused restore.
    expect(summariseInstallation(live).cards).toBe(1);

    const replaced = restoreBackup({ backupPath: backup, databasePath: live, force: true });
    expect(replaced.cards).toBe(1);
  });

  it('reports a missing database or backup instead of writing an empty one', () => {
    let code = '';
    try {
      createBackup({ databasePath: join(scratch, 'absent.sqlite'), targetPath: join(scratch, 'b.sqlite') });
    } catch (error) {
      code = error instanceof BackupError ? error.code : 'unexpected';
    }
    expect(code).toBe('file_missing');

    code = '';
    try {
      restoreBackup({ backupPath: join(scratch, 'absent.sqlite'), databasePath: join(scratch, 'r.sqlite') });
    } catch (error) {
      code = error instanceof BackupError ? error.code : 'unexpected';
    }
    expect(code).toBe('file_missing');
  });

  it('refuses a corrupt file rather than restoring it', () => {
    const corrupt = join(scratch, 'corrupt.sqlite');
    writeFileSync(corrupt, 'this is not a database');

    let thrown: BackupError | null = null;
    try {
      summariseInstallation(corrupt);
    } catch (error) {
      thrown = error instanceof BackupError ? error : null;
    }

    // Whatever SQLite says about the bytes, the outcome is a typed refusal, not a restore.
    expect(thrown).not.toBeNull();
    expect(thrown!.code).toBe('unreadable_database');
  });
});
