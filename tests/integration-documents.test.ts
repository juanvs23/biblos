/**
 * Work unit 1 runtime harness: full document lifecycle against a real SQLite
 * store — no network required.
 * save -> keyword search -> update (metadata + content) -> delete.
 */
import { describe, expect, it } from 'vitest';

import { createHarness } from './helpers.js';

describe('document lifecycle integration (no network)', () => {
  it('save, keyword search, update, and delete work end to end', async () => {
    const h = createHarness();
    try {
      // 1. save two documents
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

      // 2. keyword search: only the frog document contains the term, so it is
      //    the single FTS hit and ranks first
      const hits = await h.documents.search('frogs');
      expect(hits).toHaveLength(1);
      expect(hits[0]?.document.id).toBe(frogs.id);
      expect(hits[0]?.score).toBeGreaterThan(0);
      expect('matchedBy' in hits[0]!).toBe(false);

      // 3. metadata-only update: content and index untouched, updated_at refreshed
      //    (3ms tick: updatedAt has ISO ms resolution and no embed step separates
      //    the writes since the embedding layer was removed)
      await new Promise((r) => setTimeout(r, 3));
      const metaUpdated = await h.documents.update(frogs.id, { tags: ['fauna', 'ponds'] });
      expect(metaUpdated.updatedAt).not.toBe(frogs.updatedAt);
      expect(await h.documents.search('frogs')).toHaveLength(1);

      //    content update: the FTS index follows the new content
      await new Promise((r) => setTimeout(r, 3));
      const reupdated = await h.documents.update(http.id, { content: 'the server handles HTTP and JSON requests' });
      expect(reupdated.updatedAt).not.toBe(http.updatedAt);
      expect(await h.documents.search('parses')).toHaveLength(0);
      expect(await h.documents.search('JSON')).toHaveLength(1);

      // 4. delete removes the document and any edges
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
