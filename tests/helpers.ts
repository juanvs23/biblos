/**
 * Shared test fixtures: temp SQLite DBs for the document domain service.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { openStore, type Store } from '../src/db/store.js';
import { DocumentsService } from '../src/domain/documents.js';

export interface TestHarness {
  store: Store;
  documents: DocumentsService;
  dbPath: string;
  close(): void;
}

export function createHarness(overrides: { minScore?: number } = {}): TestHarness {
  const dir = mkdtempSync(join(tmpdir(), 'biblos-harness-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore(dbPath);
  const documents = new DocumentsService(store, { minScore: overrides.minScore ?? 0 });
  return {
    store,
    documents,
    dbPath,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { randomUUID };
