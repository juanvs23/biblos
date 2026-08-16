/**
 * Knowledge graph domain service tests (design: tests/graph.test.ts, tasks 5.2).
 * Runs against a real temp-file SQLite store — no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Store } from '../src/db/store.js';
import { DomainError } from '../src/domain/errors.js';
import { GraphService } from '../src/domain/graph.js';
import type { DocumentRecord, Relation } from '../src/domain/types.js';

function makeDoc(content: string): DocumentRecord {
  const now = new Date().toISOString();
  return { id: randomUUID(), content, author: 'alice', createdAt: now, updatedAt: now, tags: [], type: 'note' };
}

/** 768-dim zero vector fixture — graph tests never touch vectors. */
const VEC = new Array(768).fill(0);

describe('GraphService', () => {
  let dir: string;
  let store: Store;
  let graph: GraphService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biblos-graph-'));
    store = openStore(join(dir, 'test.db'));
    graph = new GraphService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seeds one document per content and returns them as a tuple (non-undefined under noUncheckedIndexedAccess). */
  function seedDocs<const T extends readonly string[]>(...contents: T): { [K in keyof T]: DocumentRecord } {
    return contents.map((content) => {
      const doc = makeDoc(content);
      store.insertDocument(doc, VEC);
      return doc;
    }) as { [K in keyof T]: DocumentRecord };
  }

  it('adds and persists a typed relation between existing documents (REQ-graph-edit)', () => {
    const [a, b] = seedDocs('a', 'b');

    const added = graph.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });

    expect(added).toEqual({ sourceId: a.id, type: 'related', targetId: b.id });
    expect(store.listRelations()).toEqual([added]);
  });

  it('rejects a relation with an unknown source and stores nothing (REQ-graph-edit)', () => {
    const [, b] = seedDocs('a', 'b');

    expect(() => graph.addRelation({ sourceId: 'missing', type: 'related', targetId: b.id })).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    );
    expect(store.listRelations()).toHaveLength(0);
  });

  it('rejects a relation with an unknown target and stores nothing (REQ-graph-edit)', () => {
    const [a] = seedDocs('a');

    expect(() => graph.addRelation({ sourceId: a.id, type: 'related', targetId: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    );
    expect(store.listRelations()).toHaveLength(0);
  });

  it('is idempotent when adding an existing relation', () => {
    const [a, b] = seedDocs('a', 'b');
    const rel: Relation = { sourceId: a.id, type: 'related', targetId: b.id };

    graph.addRelation(rel);
    graph.addRelation(rel);

    expect(store.listRelations()).toHaveLength(1);
  });

  it('removes a relation and tolerates removing an absent one', () => {
    const [a, b, c] = seedDocs('a', 'b', 'c');
    graph.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });
    graph.addRelation({ sourceId: a.id, type: 'related', targetId: c.id });

    graph.removeRelation({ sourceId: a.id, type: 'related', targetId: b.id });
    expect(store.listRelations()).toHaveLength(1);

    graph.removeRelation({ sourceId: a.id, type: 'related', targetId: b.id }); // no-op
    expect(store.listRelations()).toHaveLength(1);
  });

  it('rejects removal referencing an unknown node', () => {
    const [a] = seedDocs('a');
    expect(() => graph.removeRelation({ sourceId: a.id, type: 'related', targetId: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('validates relation inputs (missing ids / empty type)', () => {
    const [a, b] = seedDocs('a', 'b');
    expect(() => graph.addRelation({ sourceId: '', type: 'x', targetId: b.id })).toThrowError(
      expect.objectContaining({ code: 'invalid_document' }),
    );
    expect(() => graph.addRelation({ sourceId: a.id, type: '  ', targetId: b.id })).toThrowError(
      expect.objectContaining({ code: 'invalid_document' }),
    );
  });

  it('traverses breadth-first up to the requested depth (REQ-graph-query)', () => {
    const [a, b, c, d] = seedDocs('a', 'b', 'c', 'd');
    graph.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });
    graph.addRelation({ sourceId: b.id, type: 'related', targetId: c.id });
    graph.addRelation({ sourceId: c.id, type: 'related', targetId: d.id });

    const depth1 = graph.query(a.id, { depth: 1 });
    expect(depth1.nodes.sort()).toEqual([a.id, b.id].sort());
    expect(depth1.edges).toHaveLength(1);

    const depth2 = graph.query(a.id, { depth: 2 });
    expect(depth2.nodes.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(depth2.edges).toHaveLength(2);
  });

  it('filters traversal by relation type (REQ-graph-query)', () => {
    const [a, b, c] = seedDocs('a', 'b', 'c');
    graph.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });
    graph.addRelation({ sourceId: a.id, type: 'supersedes', targetId: c.id });

    const filtered = graph.query(a.id, { type: 'supersedes', depth: 1 });
    expect(filtered.nodes.sort()).toEqual([a.id, c.id].sort());
    expect(filtered.edges).toEqual([{ sourceId: a.id, type: 'supersedes', targetId: c.id }]);
  });

  it('rejects an unknown start node (REQ-graph-query)', () => {
    expect(() => graph.query('missing')).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  it('returns only the start node at depth 0', () => {
    const [a] = seedDocs('a');
    const result = graph.query(a.id, { depth: 0 });
    expect(result.nodes).toEqual([a.id]);
    expect(result.edges).toHaveLength(0);
  });

  it('rejects a negative or fractional depth', () => {
    const [a] = seedDocs('a');
    expect(() => graph.query(a.id, { depth: -1 })).toThrowError(expect.objectContaining({ code: 'invalid_document' }));
    expect(() => graph.query(a.id, { depth: 1.5 })).toThrowError(expect.objectContaining({ code: 'invalid_document' }));
  });

  it('renders Mermaid syntax by default (REQ-graph-render)', () => {
    const [a, b] = seedDocs('a', 'b');
    graph.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });

    const out = graph.render({ start: a.id, depth: 1 });

    expect(out).toMatch(/^flowchart LR\n/);
    expect(out).toContain(`n0["${a.id}"]`);
    expect(out).toContain(`n1["${b.id}"]`);
    expect(out).toContain(`n0 -->|"related"| n1`);
  });

  it('renders Graphviz when that format is requested (REQ-graph-render)', () => {
    const [a, b] = seedDocs('a', 'b');
    graph.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });

    const out = graph.render({ start: a.id, depth: 1, format: 'graphviz' });

    expect(out).toMatch(/^digraph G \{\n/);
    expect(out).toContain(`"${a.id}" -> "${b.id}" [label="related"];`);
    expect(out).toMatch(/\n\}\n$/);
  });

  it('renders a valid minimal Mermaid graph when empty (REQ-graph-render)', () => {
    expect(graph.render()).toBe('flowchart LR\n');
    expect(graph.render({ format: 'graphviz' })).toBe('digraph G {\n}\n');
  });

  it('renders the whole graph when no start node is given', () => {
    const [a, b] = seedDocs('a', 'b');
    graph.addRelation({ sourceId: a.id, type: 'related', targetId: b.id });

    const out = graph.render();

    expect(out).toContain(`n0 -->|"related"| n1`);
  });

  it('rejects an unsupported format', () => {
    const [a] = seedDocs('a');
    expect(() => graph.render({ start: a.id, format: 'dot' as never })).toThrowError(
      expect.objectContaining({ code: 'invalid_document' }),
    );
  });

  it('escapes quotes in types and labels so output stays valid', () => {
    const [a, b] = seedDocs('a', 'b');
    graph.addRelation({ sourceId: a.id, type: 'refs "note"', targetId: b.id });

    expect(graph.render({ start: a.id })).toContain('refs #quot;note#quot;');
    expect(graph.render({ start: a.id, format: 'graphviz' })).toContain('refs \\"note\\"');
  });
});
