import { describe, expect, it } from 'vitest';

import { DocumentsService } from '../src/domain/documents.js';
import { DomainError } from '../src/domain/errors.js';
import { EmbeddingError } from '../src/embeddings/client.js';
import { bagOfWordsEmbedding, createHarness, mockEmbeddings } from './helpers.js';

describe('DocumentsService', () => {
  it('saves a document with generated id, metadata defaults, and embedding', async () => {
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
      expect(h.embeddings.calls).toHaveLength(1);
      expect(h.embeddings.calls[0]).toBe('# Note\n\nbody');
      expect(h.store.getDocument(doc.id)).toEqual(doc);
      // embedding persisted -> vector search finds it
      const hits = h.store.vectorSearch(bagOfWordsEmbedding('# Note\n\nbody'), 10);
      expect(hits.map((x) => h.store.getDocumentByRowid(x.rowid)?.id)).toContain(doc.id);
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
      expect(h.embeddings.calls).toHaveLength(0);
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

  it('metadata-only update refreshes updated_at without re-embedding (REQ-memory-update)', async () => {
    const h = createHarness();
    try {
      const doc = await h.documents.save({ content: 'stable content', author: 'alice', tags: ['a'] });
      const embedCalls = h.embeddings.calls.length;

      const updated = await h.documents.update(doc.id, { author: 'bob', tags: ['a', 'b'], project: 'p2' });

      expect(h.embeddings.calls).toHaveLength(embedCalls); // no new embed call
      expect(updated.author).toBe('bob');
      expect(updated.tags).toEqual(['a', 'b']);
      expect(updated.project).toBe('p2');
      expect(updated.content).toBe('stable content');
      expect(updated.updatedAt).not.toBe(doc.updatedAt);
    } finally {
      h.close();
    }
  });

  it('content change regenerates the embedding (REQ-memory-update)', async () => {
    const h = createHarness();
    try {
      const doc = await h.documents.save({ content: 'old content', author: 'alice' });
      const embedCalls = h.embeddings.calls.length;

      const updated = await h.documents.update(doc.id, { content: 'brand new content' });

      expect(h.embeddings.calls).toHaveLength(embedCalls + 1);
      expect(h.embeddings.calls[embedCalls]).toBe('brand new content');
      expect(updated.content).toBe('brand new content');
      expect(updated.updatedAt).not.toBe(doc.updatedAt);
    } finally {
      h.close();
    }
  });

  it('delete removes the document, its embedding, and relation edges atomically (REQ-memory-delete)', async () => {
    const h = createHarness();
    try {
      const a = await h.documents.save({ content: 'node a', author: 'alice' });
      const b = await h.documents.save({ content: 'node b', author: 'alice' });
      h.store.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });

      h.documents.delete(a.id);

      expect(() => h.documents.get(a.id)).toThrow('not found');
      expect(h.store.queryGraph(a.id, undefined, 2).edges).toHaveLength(0);
      const leftover = h.store.vectorSearch(bagOfWordsEmbedding('node a'), 10);
      expect(leftover.map((x) => h.store.getDocumentByRowid(x.rowid)?.id)).not.toContain(a.id);
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

  it('router failure during save surfaces the error and writes nothing (REQ-core-embeddings)', async () => {
    const h = createHarness();
    try {
      const failing = mockEmbeddings(() => {
        throw new EmbeddingError('embedding_service_unavailable', 'router down');
      });
      const service = new DocumentsService(h.store, failing, { fusionWeight: 0.5, minScore: 0 });

      await expect(service.save({ content: 'x', author: 'alice' })).rejects.toMatchObject({
        code: 'embedding_service_unavailable',
      });
      expect(h.store.listDocuments({ limit: 10, offset: 0 })).toHaveLength(0);
      expect(h.store.vectorSearch(bagOfWordsEmbedding('x'), 10)).toHaveLength(0);
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

  it('searches with hybrid fusion returning ranked hits (REQ-memory-search)', async () => {
    const h = createHarness();
    try {
      await h.documents.save({ content: 'frogs are green and hop around ponds', author: 'a', tags: ['fauna'] });
      await h.documents.save({ content: 'the server parses HTTP requests', author: 'a', tags: ['tech'] });

      const hits = await h.documents.search('frogs', { limit: 5 });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.document.content).toContain('frogs');
      expect(hits[0]?.score).toBeGreaterThan(0);
      expect(hits[0]?.matchedBy).toBeDefined();
      // scores strictly descending
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
      }
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
