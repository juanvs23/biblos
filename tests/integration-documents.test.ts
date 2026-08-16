/**
 * Work unit 1 runtime harness: full document lifecycle against a real SQLite
 * store with the embedding router mocked at the seam - NO network required.
 * save -> hybrid search -> update (metadata + content) -> delete.
 */
import { describe, expect, it } from 'vitest';

import { createHarness } from './helpers.js';

describe('document lifecycle integration (no network)', () => {
  it('save, hybrid search, update, and delete work end to end', async () => {
    const h = createHarness();
    try {
      // 1. save two documents; embeddings come from the mocked seam
      const frogs = await h.documents.save({
        content: 'frogs are green and hop around ponds',
        author: 'alice',
        tags: ['fauna'],
        project: 'nature',
      });
      const http = await h.documents.save({
        content: 'the server parses HTTP requests',
        author: 'bob',
        tags: ['tech'],
        project: 'mcp',
      });

      // 2. hybrid search: the query shares a token with the frog doc, so it is
      //    matched by BOTH semantic and FTS, and ranks first
      const hits = await h.documents.search('frogs');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.document.id).toBe(frogs.id);
      expect(hits[0]?.matchedBy).toBe('both');
      expect(hits[0]?.score).toBeGreaterThan(0);

      // 3. metadata-only update: no re-embedding call
      const embedCalls = h.embeddings.calls.length;
      const metaUpdated = await h.documents.update(frogs.id, { tags: ['fauna', 'ponds'] });
      expect(h.embeddings.calls).toHaveLength(embedCalls);
      expect(metaUpdated.updatedAt).not.toBe(frogs.updatedAt);

      //    content update: exactly one re-embedding call
      const reembedded = await h.documents.update(http.id, { content: 'the server handles HTTP and JSON requests' });
      expect(h.embeddings.calls).toHaveLength(embedCalls + 1);
      expect(h.embeddings.calls[embedCalls]).toBe('the server handles HTTP and JSON requests');
      expect(reembedded.updatedAt).not.toBe(http.updatedAt);

      // 4. delete removes the document, its embedding, and any edges
      h.documents.delete(frogs.id);
      const after = await h.documents.search('frogs');
      expect(after.some((hit) => hit.document.id === frogs.id)).toBe(false);
      expect(() => h.documents.get(frogs.id)).toThrow('not found');

      // the other document is untouched
      expect(h.documents.get(http.id).content).toBe('the server handles HTTP and JSON requests');
    } finally {
      h.close();
    }
  });
});
