/**
 * Work unit 2 runtime harness: cross-service integration against a real
 * temp-file SQLite store — NO network.
 *
 * Demonstrates the WU2 done criteria end to end:
 *  - register -> send -> poll (correct identity) -> respond -> status
 *  - poll with an incorrect identity is rejected (empty claim, state untouched)
 *  - send to an unregistered destination is rejected
 *  - graph_edit + graph_query with depth + graph_render (Mermaid)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openStore, type Store } from '../src/db/store.js';
import { AgentBusService } from '../src/domain/bus.js';
import { GraphService } from '../src/domain/graph.js';
import { AgentRegistryService } from '../src/domain/registry.js';
import type { DocumentRecord } from '../src/domain/types.js';

/** 768-dim zero vector fixture — graph integration never touches vectors. */
const VEC = new Array(768).fill(0);

function makeDoc(content: string): DocumentRecord {
  const now = new Date().toISOString();
  return { id: randomUUID(), content, author: 'alice', createdAt: now, updatedAt: now, tags: [], type: 'note' };
}

function createDomain(dbPath: string): {
  store: Store;
  registry: AgentRegistryService;
  bus: AgentBusService;
  graph: GraphService;
} {
  const store = openStore(dbPath);
  const registry = new AgentRegistryService(store);
  const bus = new AgentBusService(store, registry);
  const graph = new GraphService(store);
  return { store, registry, bus, graph };
}

describe('agent bus roundtrip (no network)', () => {
  it('register -> send -> poll (correct identity) -> respond -> status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biblos-integration-bus-'));
    const { store, registry, bus } = createDomain(join(dir, 'test.db'));
    try {
      // 1. explicit, mandatory registration of both identities
      registry.register({ name: 'alice', type: 'orchestrator', capabilities: ['memory', 'bus'] });
      registry.register({ name: 'bob', type: 'worker', capabilities: ['bus'] });

      // 2. send: alice -> bob, enqueued as pendiente
      const sent = bus.send('alice', { recipient: 'bob', payload: { task: 'summarize', topic: 'graph' } });
      expect(sent.state).toBe('pendiente');
      expect(bus.status(sent.id).state).toBe('pendiente');

      // 3. poll with the CORRECT identity: bob claims it -> en-proceso
      const claimed = bus.poll('bob');
      expect(claimed?.id).toBe(sent.id);
      expect(claimed?.state).toBe('en-proceso');
      expect(claimed?.payload).toEqual({ task: 'summarize', topic: 'graph' });

      // 4. respond with the recipient identity -> completada with result
      const done = bus.respond('bob', { id: sent.id, state: 'completada', result: { summary: 'ok' } });
      expect(done.state).toBe('completada');

      // 5. status shows the final state and result
      const status = bus.status(sent.id);
      expect(status.state).toBe('completada');
      expect(status.result).toEqual({ summary: 'ok' });
      expect(status.sender).toBe('alice');
      expect(status.recipient).toBe('bob');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('poll with an incorrect identity is rejected and the request stays pendiente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biblos-integration-foreign-'));
    const { store, registry, bus } = createDomain(join(dir, 'test.db'));
    try {
      registry.register({ name: 'alice', type: 'orchestrator', capabilities: ['bus'] });
      registry.register({ name: 'bob', type: 'worker', capabilities: ['bus'] });
      registry.register({ name: 'mallory', type: 'worker', capabilities: ['bus'] });

      const sent = bus.send('alice', { recipient: 'bob', payload: 'for bob only' });

      // mallory (registered, but NOT the recipient) polls: claim rejected, empty result
      expect(bus.poll('mallory')).toBeNull();
      expect(bus.status(sent.id).state).toBe('pendiente'); // state untouched

      // an unregistered caller gets a hard identity error
      expect(() => bus.poll('nobody')).toThrowError(expect.objectContaining({ code: 'identity_error' }));

      // the rightful recipient still claims it
      const claimed = bus.poll('bob');
      expect(claimed?.id).toBe(sent.id);
      expect(claimed?.payload).toBe('for bob only');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('send to an unregistered destination is rejected and nothing is enqueued', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biblos-integration-reject-'));
    const { store, registry, bus } = createDomain(join(dir, 'test.db'));
    try {
      registry.register({ name: 'alice', type: 'orchestrator', capabilities: ['bus'] });

      expect(() => bus.send('alice', { recipient: 'ghost', payload: 'hi' })).toThrowError(
        expect.objectContaining({ code: 'identity_error' }),
      );
      expect(bus.poll('alice')).toBeNull(); // nothing pending anywhere
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('knowledge graph flow (no network)', () => {
  it('graph_edit -> graph_query with depth -> graph_render (Mermaid default)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biblos-integration-graph-'));
    const { store, graph } = createDomain(join(dir, 'test.db'));
    try {
      const a = makeDoc('root concept');
      const b = makeDoc('derived concept');
      const c = makeDoc('leaf detail');
      const d = makeDoc('unrelated');
      [a, b, c, d].forEach((doc) => store.insertDocument(doc, VEC));

      // graph_edit: add typed relations source -> type -> target
      graph.addRelation({ sourceId: a.id, type: 'derives', targetId: b.id });
      graph.addRelation({ sourceId: b.id, type: 'details', targetId: c.id });
      expect(store.listRelations()).toHaveLength(2);

      // graph_query with depth: reachable within depth 2 from a
      const depth1 = graph.query(a.id, { depth: 1 });
      expect(depth1.nodes.sort()).toEqual([a.id, b.id].sort());
      const depth2 = graph.query(a.id, { depth: 2 });
      expect(depth2.nodes.sort()).toEqual([a.id, b.id, c.id].sort());
      expect(depth2.edges).toHaveLength(2);

      // graph_render: Mermaid by default, valid flow-diagram syntax
      const mermaid = graph.render({ start: a.id, depth: 2 });
      expect(mermaid).toMatch(/^flowchart LR\n/);
      expect(mermaid).toContain(`n0["${a.id}"]`);
      expect(mermaid).toContain('-->|"derives"|');
      expect(mermaid).toContain('-->|"details"|');

      // unrelated node is not part of the subgraph
      expect(mermaid).not.toContain(d.id);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
