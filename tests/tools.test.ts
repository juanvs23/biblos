/**
 * Tool-layer tests (tasks 7.5, REQ-001..014).
 *
 * Layer 1 (this file, transport-level): every tool is exercised through the
 * real McpServer + InMemoryTransport + SDK Client — no network. Covers tool
 * registration (14), zod validation, domain error mapping to isError results,
 * and the identity-header requirement for bus tools (a missing header is a
 * hard error in any transport).
 *
 * Layer 2 (HTTP integration, appended by the server work unit): the full
 * JSON-RPC lifecycle (initialize -> register_agent -> save_document ->
 * search_documents -> request_send -> request_poll -> request_respond ->
 * request_status) and identity enforcement (foreign poll empty, non-recipient
 * respond fails) over StreamableHTTPServerTransport on an ephemeral port.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';

import { openStore, type Store } from '../src/db/store.js';
import { createToolsServer } from '../src/server/tools.js';
import { authHeaders, postJsonRpc, startHttpServer, type RpcHeaders } from './http.js';

export const TOOL_NAMES = [
  'save_document',
  'get_document',
  'update_document',
  'delete_document',
  'search_documents',
  'list_documents',
  'graph_edit',
  'graph_query',
  'graph_render',
  'request_send',
  'request_poll',
  'request_respond',
  'request_status',
  'register_agent',
];

export interface Harness {
  store: Store;
  server: McpServer;
  client: Client;
  dir: string;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'biblos-tools-'));
  const store = openStore(join(dir, 'test.db'));
  const server = createToolsServer({ store, defaults: { minScore: 0 } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'biblos-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    store,
    server,
    client,
    dir,
    async close() {
      await client.close();
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The client's callTool returns a union; we only ever get the CallToolResult arm. */
export interface ToolResultLike {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

export function asToolResult(result: unknown): ToolResultLike {
  return result as ToolResultLike;
}

/** Parse the structured JSON text of a tool result, expecting isError=false. */
export function parseOk(result: unknown): unknown {
  const r = asToolResult(result);
  expect(r.isError).toBeFalsy();
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  return JSON.parse(text) as unknown;
}

/** Parse the structured `{ error: { code, message } }` text of an error result. */
export function parseError(result: unknown): { code: string; message: string } {
  const r = asToolResult(result);
  expect(r.isError).toBe(true);
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  const parsed = JSON.parse(text) as { error: { code: string; message: string } };
  expect(typeof parsed.error?.code).toBe('string');
  return parsed.error;
}

describe('tool registration', () => {
  it('registers exactly the 14 spec tools', async () => {
    const h = await createHarness();
    try {
      const { tools } = await h.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(tools).toHaveLength(14);
    } finally {
      await h.close();
    }
  });

  it('exposes JSON schemas that never mention the identity header', async () => {
    const h = await createHarness();
    try {
      const { tools } = await h.client.listTools();
      for (const tool of tools) {
        const raw = JSON.stringify(tool.inputSchema).toLowerCase();
        expect(raw).not.toContain('x-biblos-agent');
        expect(raw).not.toContain('identity');
      }
    } finally {
      await h.close();
    }
  });
});

describe('registry tool — register_agent (REQ-registry-register)', () => {
  it('registers a unique agent with created_at', async () => {
    const h = await createHarness();
    try {
      const result = await h.client.callTool({
        name: 'register_agent',
        arguments: { name: 'alice', type: 'orchestrator', capabilities: ['memory', 'bus'] },
      });
      const agent = parseOk(result) as { name: string; type: string; capabilities: string[]; createdAt: string };
      expect(agent.name).toBe('alice');
      expect(agent.capabilities).toEqual(['memory', 'bus']);
      expect(new Date(agent.createdAt).getTime()).not.toBeNaN();
    } finally {
      await h.close();
    }
  });

  it('fails with an identity error on a duplicate name and leaves the identity unchanged', async () => {
    const h = await createHarness();
    try {
      await h.client.callTool({
        name: 'register_agent',
        arguments: { name: 'alice', type: 'orchestrator', capabilities: ['bus'] },
      });
      const result = await h.client.callTool({
        name: 'register_agent',
        arguments: { name: 'alice', type: 'worker', capabilities: ['bus'] },
      });
      const error = parseError(result);
      expect(error.code).toBe('identity_error');
    } finally {
      await h.close();
    }
  });

  it('rejects missing required fields via zod validation (isError result)', async () => {
    const h = await createHarness();
    try {
      const result = asToolResult(
        await h.client.callTool({
          name: 'register_agent',
          arguments: { name: 'alice', capabilities: ['bus'] }, // no type
        }),
      );
      expect(result.isError).toBe(true);
      const text = result.content?.[0]?.text ?? '';
      expect(text).toMatch(/Input validation error/i);
    } finally {
      await h.close();
    }
  });
});

describe('memory tools (REQ-memory-save..list)', () => {
  it('save_document -> get_document -> update_document (metadata only) -> list -> delete', async () => {
    const h = await createHarness();
    try {
      // save
      const saved = parseOk(
        await h.client.callTool({
          name: 'save_document',
          arguments: { content: 'Alice memory about fusion search', author: 'alice', tags: ['research'], project: 'biblos' },
        }),
      ) as { id: string; content: string; author: string; tags: string[]; project: string; type: string };
      expect(saved.author).toBe('alice');
      expect(saved.tags).toEqual(['research']);
      expect(saved.project).toBe('biblos');
      expect(saved.type).toBe('note');

      // get
      const got = parseOk(await h.client.callTool({ name: 'get_document', arguments: { id: saved.id } })) as {
        id: string;
        content: string;
      };
      expect(got.id).toBe(saved.id);
      expect(got.content).toBe('Alice memory about fusion search');

      // update metadata only
      const updated = parseOk(
        await h.client.callTool({
          name: 'update_document',
          arguments: { id: saved.id, tags: ['research', 'v2'], type: 'log' },
        }),
      ) as { tags: string[]; type: string };
      expect(updated.tags).toEqual(['research', 'v2']);
      expect(updated.type).toBe('log');

      // list with filter + pagination
      const listed = parseOk(
        await h.client.callTool({ name: 'list_documents', arguments: { project: 'biblos', tags: ['research'], limit: 10, offset: 0 } }),
      ) as { count: number; documents: Array<{ id: string }> };
      expect(listed.count).toBe(1);
      expect(listed.documents[0]?.id).toBe(saved.id);

      // get unknown -> not-found isError result
      const unknown = parseError(await h.client.callTool({ name: 'get_document', arguments: { id: 'missing-id' } }));
      expect(unknown.code).toBe('not_found');

      // delete + get after delete -> not-found
      const deleted = parseOk(await h.client.callTool({ name: 'delete_document', arguments: { id: saved.id } })) as {
        deleted: boolean;
      };
      expect(deleted.deleted).toBe(true);
      const gone = parseError(await h.client.callTool({ name: 'get_document', arguments: { id: saved.id } }));
      expect(gone.code).toBe('not_found');
    } finally {
      await h.close();
    }
  });

  it('save_document with empty content is rejected and writes nothing', async () => {
    const h = await createHarness();
    try {
      const result = asToolResult(
        await h.client.callTool({
          name: 'save_document',
          arguments: { content: '   ', author: 'alice' },
        }),
      );
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('search_documents returns ranked FTS keyword hits', async () => {
    const h = await createHarness();
    try {
      await h.client.callTool({
        name: 'save_document',
        arguments: { content: 'the cat sat on the mat', author: 'alice' },
      });
      await h.client.callTool({
        name: 'save_document',
        arguments: { content: 'the dog ran in the park', author: 'bob' },
      });
      const result = parseOk(
        await h.client.callTool({ name: 'search_documents', arguments: { query: 'cat mat', limit: 5 } }),
      ) as { query: string; count: number; hits: Array<{ document: { content: string }; score: number }> };
      expect(result.query).toBe('cat mat');
      expect(result.count).toBe(1); // only the cat/mat document matches both terms
      expect(result.hits[0]?.document.content).toBe('the cat sat on the mat');
      expect(result.hits[0]?.score).toBeGreaterThan(0);
      expect(result.hits[0]?.score).toBeLessThanOrEqual(1);
      expect('matchedBy' in result.hits[0]!).toBe(false); // field removed from the payload
    } finally {
      await h.close();
    }
  });
});

describe('graph tools (REQ-graph-edit..render)', () => {
  async function seedGraph(h: Harness): Promise<{ a: string; b: string; c: string }> {
    const a = parseOk(await h.client.callTool({ name: 'save_document', arguments: { content: 'root concept', author: 'alice' } })) as { id: string };
    const b = parseOk(await h.client.callTool({ name: 'save_document', arguments: { content: 'derived concept', author: 'alice' } })) as { id: string };
    const c = parseOk(await h.client.callTool({ name: 'save_document', arguments: { content: 'leaf detail', author: 'alice' } })) as { id: string };
    return { a: a.id, b: b.id, c: c.id };
  }

  it('graph_edit add -> graph_query by depth -> graph_render (mermaid default)', async () => {
    const h = await createHarness();
    try {
      const { a, b, c } = await seedGraph(h);

      const added = parseOk(
        await h.client.callTool({
          name: 'graph_edit',
          arguments: { action: 'add', source_id: a, type: 'derives', target_id: b },
        }),
      ) as { action: string; relation: { sourceId: string; type: string; targetId: string } };
      expect(added.action).toBe('add');
      expect(added.relation).toEqual({ sourceId: a, type: 'derives', targetId: b });
      await h.client.callTool({
        name: 'graph_edit',
        arguments: { action: 'add', source_id: b, type: 'details', target_id: c },
      });

      const query = parseOk(await h.client.callTool({ name: 'graph_query', arguments: { start: a, depth: 2 } })) as {
        nodes: string[];
        edges: Array<{ sourceId: string }>;
      };
      expect(query.nodes.sort()).toEqual([a, b, c].sort());
      expect(query.edges).toHaveLength(2);

      const mermaid = parseOk(await h.client.callTool({ name: 'graph_render', arguments: { start: a, depth: 2 } })) as string;
      expect(mermaid).toMatch(/^flowchart LR\n/);
      expect(mermaid).toContain('-->|"derives"|');

      const graphviz = parseOk(
        await h.client.callTool({ name: 'graph_render', arguments: { start: a, depth: 2, format: 'graphviz' } }),
      ) as string;
      expect(graphviz).toMatch(/^digraph G \{\n/);

      // remove
      const removed = parseOk(
        await h.client.callTool({
          name: 'graph_edit',
          arguments: { action: 'remove', source_id: a, type: 'derives', target_id: b },
        }),
      ) as { action: string };
      expect(removed.action).toBe('remove');
    } finally {
      await h.close();
    }
  });

  it('graph_edit to an unknown node fails with not-found and stores nothing', async () => {
    const h = await createHarness();
    try {
      const { a } = await seedGraph(h);
      const error = parseError(
        await h.client.callTool({
          name: 'graph_edit',
          arguments: { action: 'add', source_id: a, type: 'refs', target_id: 'ghost' },
        }),
      );
      expect(error.code).toBe('not_found');
    } finally {
      await h.close();
    }
  });
});

describe('bus tools without identity header (REQ-bus-*)', () => {
  it('request_send / request_poll / request_respond fail hard when the X-Biblos-Agent header is absent', async () => {
    const h = await createHarness();
    try {
      await h.client.callTool({
        name: 'register_agent',
        arguments: { name: 'alice', type: 'orchestrator', capabilities: ['bus'] },
      });
      const send = parseError(await h.client.callTool({ name: 'request_send', arguments: { recipient: 'bob', payload: {} } }));
      expect(send.code).toBe('invalid_params');
      expect(send.message).toContain('x-biblos-agent');

      const poll = parseError(await h.client.callTool({ name: 'request_poll', arguments: {} }));
      expect(poll.code).toBe('invalid_params');

      const respond = parseError(
        await h.client.callTool({ name: 'request_respond', arguments: { id: 'x', state: 'completada', result: {} } }),
      );
      expect(respond.code).toBe('invalid_params');
    } finally {
      await h.close();
    }
  });

  it('request_status is read-only and works without an identity header', async () => {
    const h = await createHarness();
    try {
      const error = parseError(await h.client.callTool({ name: 'request_status', arguments: { id: 'missing' } }));
      expect(error.code).toBe('not_found'); // reaches the domain, no identity gate
    } finally {
      await h.close();
    }
  });
});

// --- HTTP integration: real server + StreamableHTTPServerTransport, no network ---

/** tools/call over raw HTTP; returns the CallToolResult (isError + content). */
async function callTool(
  base: string | { baseUrl: string },
  id: number,
  name: string,
  args: unknown,
  headers: RpcHeaders = {},
): Promise<unknown> {
  const baseUrl = typeof base === 'string' ? base : base.baseUrl;
  const res = await postJsonRpc(
    baseUrl,
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    headers,
  );
  expect(res.status).toBe(200);
  const body = res.body as { result?: unknown; error?: { code: number; message: string } };
  expect(body.error).toBeUndefined();
  return body.result;
}

describe('HTTP integration — full JSON-RPC lifecycle (done criteria: transport-level flow)', () => {
  it(
    'initialize -> register_agent -> save_document -> search_documents -> request_send -> request_poll -> request_respond -> request_status',
    async () => {
      const h = await startHttpServer();
      let id = 0;
      const next = (): number => ++id;
      try {
        // 1. initialize (MCP lifecycle entry)
        const init = await postJsonRpc(
          h.baseUrl,
          {
            jsonrpc: '2.0',
            id: next(),
            method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'it', version: '1.0.0' } },
          },
          authHeaders(),
        );
        expect(init.status).toBe(200);
        const initResult = init.body as { result: { protocolVersion: string; capabilities: { tools?: unknown } } };
        expect(initResult.result.protocolVersion).toBe('2025-11-25');
        expect(initResult.result.capabilities.tools).toBeDefined();

        // 2. initialized notification (id-less) -> 202
        const notif = await postJsonRpc(h.baseUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, authHeaders());
        expect(notif.status).toBe(202);

        // 3. tools/list over HTTP
        const list = await postJsonRpc(h.baseUrl, { jsonrpc: '2.0', id: next(), method: 'tools/list', params: {} }, authHeaders());
        const listResult = list.body as { result: { tools: Array<{ name: string }> } };
        expect(listResult.result.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

        // 4. register both agents (identity from the header, never arguments)
        const alice = parseOk(
          await callTool(h, next(), 'register_agent', { name: 'alice', type: 'orchestrator', capabilities: ['memory', 'bus'] }, authHeaders('alice')),
        ) as { name: string; createdAt: string };
        expect(alice.name).toBe('alice');
        expect(new Date(alice.createdAt).getTime()).not.toBeNaN();
        await callTool(h, next(), 'register_agent', { name: 'bob', type: 'worker', capabilities: ['bus'] }, authHeaders('bob'));

        // 5. save_document
        const saved = parseOk(
          await callTool(
            h,
            next(),
            'save_document',
            { content: 'meeting notes about the bus protocol', author: 'alice', tags: ['notes'], project: 'biblos' },
            authHeaders('alice'),
          ),
        ) as { id: string; content: string };
        expect(saved.content).toBe('meeting notes about the bus protocol');

        // 6. search_documents (FTS5 keyword search, no external services)
        const search = parseOk(
          await callTool(h, next(), 'search_documents', { query: 'meeting notes', limit: 5 }, authHeaders('alice')),
        ) as { query: string; count: number; hits: Array<{ document: { id: string } }> };
        expect(search.count).toBeGreaterThan(0);
        expect(search.hits.some((hit) => hit.document.id === saved.id)).toBe(true);

        // 7. request_send: alice -> bob, enqueued pendiente (sender from header)
        const sent = parseOk(
          await callTool(h, next(), 'request_send', { recipient: 'bob', payload: { task: 'summarize', topic: 'bus' } }, authHeaders('alice')),
        ) as { id: string; state: string; sender: string; recipient: string };
        expect(sent.state).toBe('pendiente');
        expect(sent.sender).toBe('alice');
        expect(sent.recipient).toBe('bob');

        // 8. request_poll as bob -> en-proceso with the payload
        const claimed = parseOk(await callTool(h, next(), 'request_poll', {}, authHeaders('bob'))) as {
          id: string;
          state: string;
          payload: unknown;
        };
        expect(claimed.id).toBe(sent.id);
        expect(claimed.state).toBe('en-proceso');
        expect(claimed.payload).toEqual({ task: 'summarize', topic: 'bus' });

        // 9. request_respond as bob -> completada with a result
        const done = parseOk(
          await callTool(h, next(), 'request_respond', { id: sent.id, state: 'completada', result: { summary: 'done' } }, authHeaders('bob')),
        ) as { state: string; result: unknown };
        expect(done.state).toBe('completada');
        expect(done.result).toEqual({ summary: 'done' });

        // 10. request_status (read-only, any caller) reflects the final state
        const status = parseOk(
          await callTool(h, next(), 'request_status', { id: sent.id }, authHeaders('alice')),
        ) as { state: string; result: unknown; sender: string };
        expect(status.state).toBe('completada');
        expect(status.result).toEqual({ summary: 'done' });
        expect(status.sender).toBe('alice');
      } finally {
        await h.close();
      }
    },
  );
});

describe('HTTP integration — identity enforcement on bus tools (REQ-registry, REQ-bus-*)', () => {
  async function register(h: { baseUrl: string }, name: string, id: number): Promise<void> {
    await callTool(h.baseUrl, id, 'register_agent', { name, type: 'worker', capabilities: ['bus'] }, authHeaders(name));
  }

  it('foreign request_poll returns empty and leaves the request pendiente', async () => {
    const h = await startHttpServer();
    let id = 0;
    const next = (): number => ++id;
    try {
      await register(h, 'alice', next());
      await register(h, 'bob', next());
      await register(h, 'mallory', next());
      const sent = parseOk(
        await callTool(h, next(), 'request_send', { recipient: 'bob', payload: 'for bob only' }, authHeaders('alice')),
      ) as { id: string };

      // mallory is registered but NOT the recipient: empty claim, state untouched
      const polled = parseOk(await callTool(h, next(), 'request_poll', {}, authHeaders('mallory')));
      expect(polled).toBeNull();
      const status = parseOk(await callTool(h, next(), 'request_status', { id: sent.id }, authHeaders('alice'))) as {
        state: string;
      };
      expect(status.state).toBe('pendiente');
    } finally {
      await h.close();
    }
  });

  it('non-recipient request_respond fails with identity_error and leaves state en-proceso', async () => {
    const h = await startHttpServer();
    let id = 0;
    const next = (): number => ++id;
    try {
      await register(h, 'alice', next());
      await register(h, 'bob', next());
      await register(h, 'mallory', next());
      const sent = parseOk(
        await callTool(h, next(), 'request_send', { recipient: 'bob', payload: 'task' }, authHeaders('alice')),
      ) as { id: string };
      const claimed = parseOk(await callTool(h, next(), 'request_poll', {}, authHeaders('bob'))) as { id: string; state: string };
      expect(claimed.state).toBe('en-proceso');

      const error = parseError(
        await callTool(h, next(), 'request_respond', { id: sent.id, state: 'completada', result: 'stolen' }, authHeaders('mallory')),
      );
      expect(error.code).toBe('identity_error');

      const status = parseOk(await callTool(h, next(), 'request_status', { id: sent.id }, authHeaders('bob'))) as {
        state: string;
      };
      expect(status.state).toBe('en-proceso'); // unchanged
    } finally {
      await h.close();
    }
  });

  it('unregistered sender is rejected by request_send with identity_error', async () => {
    const h = await startHttpServer();
    try {
      await callTool(h.baseUrl, 1, 'register_agent', { name: 'bob', type: 'worker', capabilities: ['bus'] }, authHeaders('bob'));
      const error = parseError(
        await callTool(h.baseUrl, 2, 'request_send', { recipient: 'bob', payload: 'hi' }, authHeaders('nobody')),
      );
      expect(error.code).toBe('identity_error');
      expect(error.message).toContain('nobody');
    } finally {
      await h.close();
    }
  });

  it('missing X-Biblos-Agent header on request_send returns invalid_params', async () => {
    const h = await startHttpServer();
    try {
      const error = parseError(await callTool(h.baseUrl, 1, 'request_send', { recipient: 'bob', payload: 'hi' }, authHeaders()));
      expect(error.code).toBe('invalid_params');
      expect(error.message).toContain('x-biblos-agent');
    } finally {
      await h.close();
    }
  });
});
