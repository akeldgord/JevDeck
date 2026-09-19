import { describe, expect, it, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, openDatabase } from '../apps/api/src/db';

const scratch = mkdtempSync(join(tmpdir(), 'jevdeck-migrations-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function makeMigrationsDir(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const [filename, sql] of Object.entries(files)) {
    writeFileSync(join(dir, filename), sql, 'utf8');
  }
  return dir;
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== null;
}

describe('Migration runner', () => {
  it('creates the schema and records every migration', () => {
    const db = openDatabase(':memory:');
    const report = applyMigrations(db);

    expect(report.applied.length).toBeGreaterThan(0);
    expect(report.alreadyApplied).toEqual([]);

    // Spot-check tables from each area of the contract set.
    for (const table of [
      'users',
      'sessions',
      'invitations',
      'documents',
      'document_versions',
      'source_blocks',
      'decks',
      'cards',
      'evidence',
      'generation_jobs',
      'provider_attempts',
      'user_card_state',
      'review_events',
      'deck_shares',
      'usage_records',
      'budget_reservations',
      'schema_migrations',
    ]) {
      expect(tableExists(db, table)).toBe(true);
    }

    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    const db = openDatabase(':memory:');

    const first = applyMigrations(db);
    const second = applyMigrations(db);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);

    db.close();
  });

  it('applies migrations in version order, not filename order', () => {
    const dir = makeMigrationsDir('ordering', {
      '10_ten.sql': 'CREATE TABLE ten (id INTEGER PRIMARY KEY);',
      '2_two.sql': 'CREATE TABLE two (id INTEGER PRIMARY KEY);',
      '01_one.sql': 'CREATE TABLE one (id INTEGER PRIMARY KEY);',
    });

    const db = openDatabase(':memory:');
    const report = applyMigrations(db, dir);

    expect(report.applied).toEqual(['01', '2', '10']);

    db.close();
  });

  it('refuses to run when an applied migration has been edited', () => {
    const dir = makeMigrationsDir('edited', {
      '0001_first.sql': 'CREATE TABLE first (id INTEGER PRIMARY KEY);',
    });

    const db = openDatabase(':memory:');
    applyMigrations(db, dir);

    // Simulate someone changing history instead of adding a migration.
    writeFileSync(
      join(dir, '0001_first.sql'),
      'CREATE TABLE first (id INTEGER PRIMARY KEY, extra TEXT);',
      'utf8'
    );

    expect(() => applyMigrations(db, dir)).toThrow(/modified after it was applied/);

    db.close();
  });

  it('reports a missing migration directory instead of silently doing nothing', () => {
    const db = openDatabase(':memory:');
    expect(() => applyMigrations(db, join(scratch, 'does-not-exist'))).toThrow(
      /Migration directory is missing/
    );
    db.close();
  });

  it('ships the real migration directory with an initial schema', () => {
    const sql = readFileSync(join(import.meta.dir, '..', 'apps/api/migrations/0001_init.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE users');
    expect(sql).toContain('CREATE TABLE sessions');
    expect(sql).toContain('CREATE TABLE invitations');
  });

  it('enforces foreign keys, so orphaned rows cannot be inserted', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    expect(() =>
      db
        .prepare('INSERT INTO decks (id, owner_id, title, coverage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('dek_orphan', 'usr_missing', 'Orphan', 'comprehensive', 'now', 'now')
    ).toThrow();

    db.close();
  });
});
