import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyPragmas, migrate } from '../src/db/migrate.js';

const TABLES = ['documents', 'documents_fts', 'relations', 'agents', 'requests'];

describe('migrate', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biblos-migrate-'));
    dbPath = join(dir, 'test.db');
    db = new Database(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function listTables(): string[] {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
    ).map((r) => r.name);
  }

  it('creates every core table including the FTS5 virtual table, without the removed vec0 table', () => {
    migrate(db);
    const names = listTables();
    for (const t of TABLES) {
      expect(names, `expected ${t} to exist`).toContain(t);
    }
    // The removed embedding table must never come back.
    expect(names).not.toContain('document_embeddings');
    // fts5 (documents_fts) is a virtual table; sqlite_master reports type='table'
    // for it, so detect via the SQL text.
    const ddl = new Map(
      (db.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('documents_fts')").all() as Array<{ name: string; sql: string }>).map((r) => [r.name, r.sql]),
    );
    expect(ddl.get('documents_fts')).toMatch(/^CREATE VIRTUAL TABLE/);
  });

  it('is idempotent: running migration twice does not error', () => {
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare('SELECT count(*) AS c FROM documents').get()).toEqual({ c: 0 });
  });

  it('applies connection pragmas', () => {
    migrate(db);
    expect(applyPragmas(db)).toBeUndefined();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
});
