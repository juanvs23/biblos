/**
 * Shared test fixtures: temp SQLite DBs and a deterministic, network-free
 * embedding mock (hashing-trick bag of words, L2-normalized) that behaves
 * semantically for words shared between texts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { openStore, type Store } from '../src/db/store.js';
import { DocumentsService } from '../src/domain/documents.js';
import type { EmbeddingClient } from '../src/embeddings/client.js';
import { l2Normalize } from '../src/embeddings/client.js';

export const EMBED_DIM = 768;

function hashWord(word: string): number {
  let h = 0;
  for (const ch of word) {
    h = (h * 31 + ch.charCodeAt(0)) | 0;
  }
  return Math.abs(h);
}

/** Deterministic bag-of-words embedding: shared words produce overlapping vectors. */
export function bagOfWordsEmbedding(text: string, dim = EMBED_DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    vector[hashWord(word) % dim] = (vector[hashWord(word) % dim] ?? 0) + 1;
  }
  return l2Normalize(vector);
}

export interface EmbeddingSpy extends EmbeddingClient {
  calls: string[];
}

export function mockEmbeddings(embedFn?: (text: string) => number[]): EmbeddingSpy {
  const fn = embedFn ?? bagOfWordsEmbedding;
  return {
    calls: [],
    async embed(text: string): Promise<number[]> {
      this.calls.push(text);
      return fn(text);
    },
  };
}

export interface TestHarness {
  store: Store;
  documents: DocumentsService;
  embeddings: EmbeddingSpy;
  dbPath: string;
  close(): void;
}

export function createHarness(overrides: { fusionWeight?: number; minScore?: number } = {}): TestHarness {
  const dir = mkdtempSync(join(tmpdir(), 'biblos-harness-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore(dbPath);
  const embeddings = mockEmbeddings();
  const documents = new DocumentsService(store, embeddings, {
    fusionWeight: overrides.fusionWeight ?? 0.5,
    minScore: overrides.minScore ?? 0,
  });
  return {
    store,
    documents,
    embeddings,
    dbPath,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { randomUUID };
