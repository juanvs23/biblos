import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/**
 * Connection-level pragmas. WAL persists on disk; foreign_keys and busy_timeout
 * are per-connection and MUST be set on every open (design: schema.sql header).
 */
export function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

/**
 * Idempotent boot migration: applies connection pragmas, then executes
 * schema.sql (CREATE ... IF NOT EXISTS, so running twice is a no-op).
 * Safe to call on every boot.
 */
export function migrate(db: Database.Database): void {
  applyPragmas(db);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
}
