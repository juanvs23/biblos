import { describe, expect, it } from 'vitest';

import { createHarness } from './helpers.js';

describe('DocumentsService', () => {
  it('saves a document with generated id and metadata defaults', async () => {
    const h = createHarness();
    try {
      const doc = await h.documents.save({
        content: '# Note\n\nbody',
        author: 'alice',
        tags: ['x'],
        project: 'p1',
        type: 'doc',
      });
      expect(doc.id).toBeTruthy();
      expect(doc.type).toBe('doc');
      expect(doc.tags).toEqual(['x']);
      expect(doc.project).toBe('p1');
      expect(h.store.getDocument(doc.id)).toEqual(doc);
      // the saved document is full-text searchable
      expect(h.store.ftsSearch('body', 10).map((x) => h.store.getDocumentByRowid(x.rowid)?.id)).toContain(doc.id);
    } finally {
      h.close();
    }
  });

  it('rejects empty content and missing author with no partial row (REQ-memory-save)', async () => {
    const h = createHarness();
    try {
      await expect(h.documents.save({ content: '   ', author: 'alice' })).rejects.toMatchObject({
        code: 'invalid_document',
      });
      await expect(h.documents.save({ content: 'ok', author: '' })).rejects.toMatchObject({
        code: 'invalid_document',
      });
      expect(h.store.listDocuments({ limit: 10, offset: 0 })).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('get on an unknown id throws not-found (REQ-memory-get)', async () => {
    const h = createHarness();
    try {
      expect(() => h.documents.get('missing-id')).toThrow('not found');
    } finally {
      h.close();
    }
  });

  it('metadata-only update refreshes updated_at (REQ-memory-update)', async () => {
    const h = createHarness();
    try {
      const doc = await h.documents.save({ content: 'stable content', author: 'alice', tags: ['a'] });

      // updatedAt has ISO millisecond resolution; guarantee a tick so the
      // same-millisecond save→update pair cannot collide (with the embedding
      // layer gone, no network call separates the two writes anymore).
      await new Promise((r) => setTimeout(r, 3));

      const updated = await h.documents.update(doc.id, { author: 'bob', tags: ['a', 'b'], project: 'p2' });

      expect(updated.author).toBe('bob');
      expect(updated.tags).toEqual(['a', 'b']);
      expect(updated.project).toBe('p2');
      expect(updated.content).toBe('stable content');
      expect(updated.updatedAt).not.toBe(doc.updatedAt);
    } finally {
      h.close();
    }
  });

  it('content update changes the content and refreshes updated_at (REQ-memory-update)', async () => {
    const h = createHarness();
    try {
      const doc = await h.documents.save({ content: 'old content', author: 'alice' });

      // Same-millisecond guard as above (ISO ms-resolution timestamps).
      await new Promise((r) => setTimeout(r, 3));

      const updated = await h.documents.update(doc.id, { content: 'brand new content' });

      expect(updated.content).toBe('brand new content');
      expect(updated.updatedAt).not.toBe(doc.updatedAt);
      // the FTS index follows the content change (trigger-synced)
      expect(h.store.ftsSearch('brand', 10)).toHaveLength(1);
      expect(h.store.ftsSearch('old', 10)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('delete removes the document and relation edges atomically (REQ-memory-delete)', async () => {
    const h = createHarness();
    try {
      const a = await h.documents.save({ content: 'node a', author: 'alice' });
      const b = await h.documents.save({ content: 'node b', author: 'alice' });
      h.store.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });

      h.documents.delete(a.id);

      expect(() => h.documents.get(a.id)).toThrow('not found');
      expect(h.store.queryGraph(a.id, undefined, 2).edges).toHaveLength(0);
      expect(h.documents.get(b.id).id).toBe(b.id);
    } finally {
      h.close();
    }
  });

  it('delete on unknown id throws not-found and modifies nothing (REQ-memory-delete)', async () => {
    const h = createHarness();
    try {
      expect(() => h.documents.delete('missing')).toThrow('not found');
      expect(h.store.listDocuments({ limit: 10, offset: 0 })).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('lists documents filtered by project and tags (REQ-memory-list)', async () => {
    const h = createHarness();
    try {
      await h.documents.save({ content: 'one', author: 'a', project: 'p1', tags: ['x'] });
      await h.documents.save({ content: 'two', author: 'a', project: 'p1', tags: ['x', 'y'] });
      await h.documents.save({ content: 'three', author: 'a', project: 'p2', tags: ['y'] });

      const p1x = h.documents.list({ project: 'p1', tags: ['x'] });
      expect(p1x).toHaveLength(2);

      const p1y = h.documents.list({ project: 'p1', tags: ['y'] });
      expect(p1y).toHaveLength(1);

      const page2 = h.documents.list({ project: 'p1', limit: 1, offset: 1 });
      expect(page2).toHaveLength(1);
      const empty = h.documents.list({ project: 'p1', limit: 1, offset: 10 });
      expect(empty).toEqual([]); // empty page without error
    } finally {
      h.close();
    }
  });

  it('searches by keyword returning ranked FTS hits (REQ-memory-search)', async () => {
    const h = createHarness();
    try {
      await h.documents.save({ content: 'frogs are green and hop around ponds', author: 'a', tags: ['fauna'] });
      await h.documents.save({ content: 'the server parses HTTP requests', author: 'a', tags: ['tech'] });

      const hits = await h.documents.search('frogs', { limit: 5 });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.document.content).toContain('frogs');
      expect(hits[0]?.score).toBeGreaterThan(0);
      expect(hits[0]?.score).toBeLessThanOrEqual(1);
      expect('matchedBy' in hits[0]!).toBe(false); // field removed from the payload
    } finally {
      h.close();
    }
  });

  it('drops every hit when minScore is above all scores (BIBLOS_MIN_SCORE)', async () => {
    const h = createHarness({ minScore: 1 });
    try {
      await h.documents.save({ content: 'frogs are green and hop around ponds', author: 'a' });
      expect(await h.documents.search('frogs')).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('returns no matches when the corpus is empty', async () => {
    const h = createHarness();
    try {
      expect(await h.documents.search('anything')).toEqual([]);
    } finally {
      h.close();
    }
  });
});
