import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ftsScore, openStore, type Store } from '../src/db/store.js';
import type { AgentRecord, BusRequest, DocumentRecord, Relation } from '../src/domain/types.js';

function makeDoc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    content: 'default content',
    author: 'alice',
    createdAt: now,
    updatedAt: now,
    tags: [],
    type: 'note',
    ...overrides,
  };
}

function makeAgent(name: string): AgentRecord {
  return { name, type: 'agent', capabilities: ['search'], createdAt: new Date().toISOString() };
}

function makeRequest(id: string, sender: string, recipient: string, payload: unknown): BusRequest {
  return { id, sender, recipient, payload, state: 'pendiente', createdAt: new Date().toISOString() };
}

describe('ftsScore', () => {
  it('normalizes bm25 into (0, 1] with golden values', () => {
    expect(ftsScore(0)).toBe(1);
    expect(ftsScore(-1)).toBe(0.5);
    expect(ftsScore(-3)).toBe(0.25);
    expect(ftsScore(-0.5)).toBeCloseTo(2 / 3);
  });

  it('is monotonic in bm25: better (more negative) matches score lower', () => {
    expect(ftsScore(-5)).toBeLessThan(ftsScore(-1));
    expect(ftsScore(-1)).toBeLessThan(ftsScore(-0.1));
  });
});

describe('Store', () => {
  let dir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biblos-store-'));
    dbPath = join(dir, 'test.db');
    store = openStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts and reads a document back with parsed metadata', () => {
    const doc = makeDoc({ content: '# Hello\n\nMarkdown body', tags: ['notes', 'scratch'], project: 'biblos', type: 'note' });
    store.insertDocument(doc);

    const loaded = store.getDocument(doc.id);
    expect(loaded).toEqual(doc);
  });

  it('keeps FTS index in sync via triggers across insert, update, delete', () => {
    const doc = makeDoc({ content: 'alpha beta gamma' });
    store.insertDocument(doc);

    expect(store.ftsSearch('alpha', 10)).toHaveLength(1);

    // find by rowid: the FTS rowid equals the documents rowid
    const byId = store.getDocument(doc.id);
    expect(byId).not.toBeNull();
    const docsByRowid = store.ftsSearch('alpha', 10).map((h) => store.getDocumentByRowid(h.rowid));
    expect(docsByRowid.map((d) => d?.id)).toContain(doc.id);

    // update content -> old term gone, new term present
    store.updateDocument(doc.id, { content: 'delta epsilon' });
    expect(store.ftsSearch('alpha', 10)).toHaveLength(0);
    expect(store.ftsSearch('delta', 10)).toHaveLength(1);

    // delete -> no FTS hits
    store.deleteDocument(doc.id);
    expect(store.ftsSearch('delta', 10)).toHaveLength(0);
    expect(store.getDocument(doc.id)).toBeNull();
  });

  it('handles punctuation in FTS queries without syntax errors', () => {
    store.insertDocument(makeDoc({ content: 'frogs: are green (mostly)' }));
    expect(store.ftsSearch('green', 10)).toHaveLength(1);
    // colon + mixed tokens must be sanitized into valid MATCH syntax, not throw
    expect(store.ftsSearch('frogs: are green', 10)).toHaveLength(1);
    expect(store.ftsSearch('nope zzz', 10)).toHaveLength(0);
  });

  it('deletes a document atomically: relations cascade', () => {
    const a = makeDoc({ content: 'node a' });
    const b = makeDoc({ content: 'node b' });
    store.insertDocument(a);
    store.insertDocument(b);
    const rel: Relation = { sourceId: a.id, type: 'related', targetId: b.id };
    store.addRelation(rel);
    expect(store.queryGraph(a.id, undefined, 1).edges).toHaveLength(1);
    expect(store.queryGraph(a.id, undefined, 1).edges[0]).toEqual(rel); // edges map to Relation (camelCase)

    expect(store.deleteDocument(a.id)).toBe(true);

    expect(store.getDocument(a.id)).toBeNull();
    expect(store.queryGraph(a.id, undefined, 1).edges).toHaveLength(0);
    expect(store.getDocument(b.id)).not.toBeNull();
    // FTS row removed with the document -> no keyword hits remain
    expect(store.ftsSearch('node', 10).map((h) => store.getDocumentByRowid(h.rowid)?.id)).not.toContain(a.id);
  });

  it('returns false when deleting an unknown document', () => {
    expect(store.deleteDocument(randomUUID())).toBe(false);
  });

  it('lists documents filtered by project and tags with pagination', () => {
    const docs = [
      makeDoc({ content: 'one', project: 'p1', tags: ['x'] }),
      makeDoc({ content: 'two', project: 'p1', tags: ['x', 'y'] }),
      makeDoc({ content: 'three', project: 'p2', tags: ['y'] }),
    ];
    docs.forEach((d) => store.insertDocument(d));

    const p1x = store.listDocuments({ project: 'p1', tags: ['x'], limit: 10, offset: 0 });
    expect(p1x.map((d) => d.id).sort()).toEqual([docs[0]!.id, docs[1]!.id].sort());

    const p1 = store.listDocuments({ project: 'p1', limit: 1, offset: 0 });
    expect(p1).toHaveLength(1);
    const p1page2 = store.listDocuments({ project: 'p1', limit: 1, offset: 1 });
    expect(p1page2).toHaveLength(1);
    const p1page3 = store.listDocuments({ project: 'p1', limit: 1, offset: 2 });
    expect(p1page3).toHaveLength(0); // empty page, no error
  });

  it('persists documents and bus requests across reopen (REQ-017, REQ-bus-status restart)', () => {
    store.registerAgent(makeAgent('alice'));
    store.registerAgent(makeAgent('bob'));
    const doc = makeDoc({ content: 'persisted note' });
    store.insertDocument(doc);
    store.enqueue(makeRequest('req-1', 'alice', 'bob', { task: 'ping' }));

    store.close();
    store = openStore(dbPath);

    expect(store.getDocument(doc.id)?.content).toBe('persisted note');
    expect(store.ftsSearch('persisted', 10)).toHaveLength(1); // FTS index persisted too
    const status = store.status('req-1');
    expect(status?.state).toBe('pendiente');
    expect(status?.payload).toEqual({ task: 'ping' });
  });

  it('claims the oldest pendiente request for a recipient', () => {
    store.registerAgent(makeAgent('alice'));
    store.registerAgent(makeAgent('bob'));
    store.enqueue(makeRequest('r1', 'alice', 'bob', 1));
    store.enqueue(makeRequest('r2', 'alice', 'bob', 2));

    const claimed = store.claim('bob');
    expect(claimed?.id).toBe('r1');
    expect(claimed?.state).toBe('en-proceso');
    expect(store.status('r1')?.state).toBe('en-proceso');
    expect(store.claim('bob')?.id).toBe('r2');
    expect(store.claim('bob')).toBeNull(); // nothing left
  });

  it('respond only succeeds for the claimed request and matching recipient', () => {
    store.registerAgent(makeAgent('alice'));
    store.registerAgent(makeAgent('bob'));
    store.enqueue(makeRequest('r1', 'alice', 'bob', 1));
    store.claim('bob');

    expect(store.respond('r1', { state: 'completada', result: { ok: true } }, 'mallory')).toBe(false);
    expect(store.respond('r1', { state: 'completada', result: { ok: true } }, 'bob')).toBe(true);
    expect(store.status('r1')?.state).toBe('completada');
    expect(store.respond('r1', { state: 'fallida', result: 'x' }, 'bob')).toBe(false); // already completed
  });

  it('assertAgent reflects registrations', () => {
    expect(store.assertAgent('alice')).toBe(false);
    store.registerAgent(makeAgent('alice'));
    expect(store.assertAgent('alice')).toBe(true);
  });

  it('reads agents back with parsed capabilities and persisted created_at', () => {
    const agent = makeAgent('alice');
    store.registerAgent(agent);

    const loaded = store.getAgent('alice');
    expect(loaded).toEqual(agent);
    expect(loaded?.createdAt).toBe(agent.createdAt); // domain-provided timestamp persisted, not DB default
    expect(store.getAgent('nobody')).toBeNull();
  });

  it('lists all agents sorted by name', () => {
    store.registerAgent(makeAgent('bob'));
    store.registerAgent(makeAgent('alice'));

    expect(store.listAgents().map((a) => a.name)).toEqual(['alice', 'bob']);
  });

  it('lists all relations in insertion order for full-graph render', () => {
    const a = makeDoc({ content: 'a' });
    const b = makeDoc({ content: 'b' });
    const c = makeDoc({ content: 'c' });
    [a, b, c].forEach((d) => store.insertDocument(d));

    store.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });
    store.addRelation({ sourceId: b.id, type: 'related', targetId: c.id });

    expect(store.listRelations()).toEqual([
      { sourceId: a.id, type: 'related', targetId: b.id },
      { sourceId: b.id, type: 'related', targetId: c.id },
    ]);
  });
});
