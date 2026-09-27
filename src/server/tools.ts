/**
 * MCP tool layer — a THIN adapter over the domain services (design: src/server/tools.ts, tasks 7.2).
 *
 * No business logic lives here: each tool validates its zod arguments, reads the
 * caller's agent identity from the `X-Biblos-Agent` HTTP header (never from
 * `arguments` — design D4), and forwards to the domain service.
 *
 * Error mapping (SDK 1.30.0 wraps every thrown tool error into an isError:true
 * tool result, per the 2025-11-25 spec — JSON-RPC error codes never surface
 * from tools/call):
 *   - DomainError -> isError result with `{ error: { code, message } }` in the
 *     text payload.
 *   - Missing X-Biblos-Agent header on an identity-required tool -> isError
 *     result with code `invalid_params`.
 *   - Anything unexpected -> isError result with code `internal_error`.
 *   - zod argument validation (SDK-side) -> isError result with a descriptive
 *     "Input validation error..." text.
 *
 * Tools (14, per the specs):
 *   memory: save_document, get_document, update_document, delete_document,
 *           search_documents, list_documents        (REQ-memory-save..list)
 *   graph:  graph_edit, graph_query, graph_render   (REQ-graph-edit..render)
 *   bus:    request_send, request_poll, request_respond, request_status
 *                                                    (REQ-bus-send..status)
 *   registry: register_agent                        (REQ-registry-register)
 *
 * Bus tools that need an identity (send/poll/respond) enforce the
 * X-Biblos-Agent header; memory/graph tools and request_status are read-only
 * and require only the API key (design open question default).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { Store } from '../db/store.js';
import { AgentBusService } from '../domain/bus.js';
import { DocumentsService } from '../domain/documents.js';
import { DomainError } from '../domain/errors.js';
import { GraphService } from '../domain/graph.js';
import { AgentRegistryService } from '../domain/registry.js';

/** The identity header that carries the calling agent (design D4). */
export const AGENT_IDENTITY_HEADER = 'x-biblos-agent';

/** Structural subset of the SDK's RequestHandlerExtra we rely on. */
export interface ToolRequestExtra {
  requestInfo?: { headers: Record<string, string | string[] | undefined> };
}

export interface ToolDeps {
  store: Store;
  defaults: { minScore: number };
}

// --- result helpers ---

function okResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
}

function errorResult(code: string, message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }, null, 2) }], isError: true };
}

/** Domain failures -> isError result; unexpected -> internal_error result. No throw escapes. */
function toErrorResult(err: unknown): CallToolResult {
  if (err instanceof DomainError) {
    return errorResult(err.code, err.message);
  }
  if (err instanceof McpError) {
    return errorResult('invalid_params', err.message);
  }
  return errorResult('internal_error', err instanceof Error ? err.message : String(err));
}

function call<T>(fn: () => T): CallToolResult {
  try {
    return okResult(fn());
  } catch (err) {
    return toErrorResult(err);
  }
}

function callAsync<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  return Promise.resolve()
    .then(fn)
    .then((value) => okResult(value))
    .catch((err: unknown) => toErrorResult(err));
}

// --- agent identity from the HTTP header (design D4) ---

export function agentIdentity(extra: ToolRequestExtra): string | undefined {
  const raw = extra.requestInfo?.headers[AGENT_IDENTITY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Bus tools require a caller identity; a missing header is a protocol error (-32602). */
function requireIdentity(extra: ToolRequestExtra): string {
  const identity = agentIdentity(extra);
  if (identity === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `${AGENT_IDENTITY_HEADER} header is required for this tool`);
  }
  return identity;
}

// --- schemas (snake_case params per design tool signatures) ---

const saveDocumentSchema = {
  content: z.string().min(1),
  author: z.string().min(1),
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  type: z.string().optional(),
};

const getDocumentSchema = { id: z.string().min(1) };

const updateDocumentSchema = {
  id: z.string().min(1),
  content: z.string().min(1).optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  project: z.string().nullable().optional(),
  type: z.string().optional(),
};

const searchDocumentsSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
};

const listDocumentsSchema = {
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
};

const graphEditSchema = {
  action: z.enum(['add', 'remove']),
  source_id: z.string().min(1),
  type: z.string().min(1),
  target_id: z.string().min(1),
};

const graphQuerySchema = {
  start: z.string().min(1),
  type: z.string().optional(),
  depth: z.number().int().min(0).optional(),
};

const graphRenderSchema = {
  start: z.string().optional(),
  type: z.string().optional(),
  depth: z.number().int().min(0).optional(),
  format: z.enum(['mermaid', 'graphviz']).optional(),
};

const requestSendSchema = {
  recipient: z.string().min(1),
  payload: z.unknown().optional(),
};

const requestRespondSchema = {
  id: z.string().min(1),
  state: z.enum(['completada', 'fallida']),
  result: z.unknown().optional(),
};

const requestStatusSchema = { id: z.string().min(1) };

const registerAgentSchema = {
  name: z.string().min(1),
  type: z.string().min(1),
  capabilities: z.array(z.string()),
};

/**
 * Build the Biblos McpServer with all 14 tools registered over the domain
 * services. Callers own the Store lifecycle.
 */
export function createToolsServer(deps: ToolDeps): McpServer {
  const documents = new DocumentsService(deps.store, deps.defaults);
  const graph = new GraphService(deps.store);
  const registry = new AgentRegistryService(deps.store);
  const bus = new AgentBusService(deps.store, registry);

  const server = new McpServer({ name: 'biblos', version: '0.1.0' }, { capabilities: { tools: {} } });

  // --- memory documents (REQ-memory-save..list) ---

  server.registerTool(
    'save_document',
    {
      title: 'Save document',
      description:
        'Store a Markdown document with metadata (author, tags, project, type). ' +
        'Returns the document with a unique id.',
      inputSchema: saveDocumentSchema,
    },
    (args) => callAsync(() => documents.save(args)),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get document',
      description: 'Return the full content and metadata of a document by id.',
      inputSchema: getDocumentSchema,
    },
    (args) => call(() => documents.get(args.id)),
  );

  server.registerTool(
    'update_document',
    {
      title: 'Update document',
      description:
        'Update document content and/or metadata. The full-text index is kept ' +
        'in sync automatically.',
      inputSchema: updateDocumentSchema,
    },
    (args) => callAsync(() => documents.update(args.id, args)),
  );

  server.registerTool(
    'delete_document',
    {
      title: 'Delete document',
      description: 'Atomically remove a document and its graph edges.',
      inputSchema: getDocumentSchema,
    },
    (args) => call(() => {
      documents.delete(args.id);
      return { id: args.id, deleted: true };
    }),
  );

  server.registerTool(
    'search_documents',
    {
      title: 'Search documents',
      description:
        'Keyword (FTS5) search over document content and tags, ranked by bm25 relevance. ' +
        'Hits below the configured BIBLOS_MIN_SCORE threshold are dropped.',
      inputSchema: searchDocumentsSchema,
    },
    (args) =>
      callAsync(async () => {
        const hits = await documents.search(args.query, { limit: args.limit });
        return { query: args.query, count: hits.length, hits };
      }),
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description: 'List documents filtered by project and/or tags, with pagination.',
      inputSchema: listDocumentsSchema,
    },
    (args) =>
      call(() => {
        const documentsList = documents.list({
          project: args.project,
          tags: args.tags,
          limit: args.limit,
          offset: args.offset,
        });
        return { count: documentsList.length, documents: documentsList };
      }),
  );

  // --- knowledge graph (REQ-graph-edit..render) ---

  server.registerTool(
    'graph_edit',
    {
      title: 'Edit graph relations',
      description: 'Add or remove a typed relation (source -> type -> target); unknown documents are rejected.',
      inputSchema: graphEditSchema,
    },
    (args) =>
      call(() => {
        const relation = { sourceId: args.source_id, type: args.type, targetId: args.target_id };
        if (args.action === 'add') {
          graph.addRelation(relation);
          return { action: 'add', relation };
        }
        graph.removeRelation(relation);
        return { action: 'remove', relation };
      }),
  );

  server.registerTool(
    'graph_query',
    {
      title: 'Query graph',
      description: 'Traverse the graph from a start document by relation type and depth; returns reachable nodes and edges.',
      inputSchema: graphQuerySchema,
    },
    (args) => call(() => graph.query(args.start, { type: args.type, depth: args.depth })),
  );

  server.registerTool(
    'graph_render',
    {
      title: 'Render graph',
      description: 'Render the graph (whole or from a start node) as Mermaid by default, or Graphviz when requested.',
      inputSchema: graphRenderSchema,
    },
    (args) =>
      call(() =>
        graph.render({
          start: args.start,
          type: args.type,
          depth: args.depth,
          format: args.format,
        }),
      ),
  );

  // --- agent bus (REQ-bus-send..status) ---

  server.registerTool(
    'request_send',
    {
      title: 'Send bus request',
      description:
        'Enqueue a request for a registered recipient agent in state pendiente. ' +
        'Requires the X-Biblos-Agent header; the sender must be registered.',
      inputSchema: requestSendSchema,
    },
    (args, extra) =>
      call(() => {
        const caller = requireIdentity(extra);
        return bus.send(caller, { recipient: args.recipient, payload: args.payload });
      }),
  );

  server.registerTool(
    'request_poll',
    {
      title: 'Poll bus request',
      description:
        'Claim the oldest pendiente request addressed to the calling agent (X-Biblos-Agent header) and transition it to en-proceso.',
      inputSchema: {},
    },
    (_args, extra) =>
      call(() => {
        const caller = requireIdentity(extra);
        return bus.poll(caller);
      }),
  );

  server.registerTool(
    'request_respond',
    {
      title: 'Respond to bus request',
      description:
        'Set a claimed request to completada (with a result) or fallida (with an error). ' +
        'The calling agent must be the registered recipient.',
      inputSchema: requestRespondSchema,
    },
    (args, extra) =>
      call(() => {
        const caller = requireIdentity(extra);
        return bus.respond(caller, { id: args.id, state: args.state, result: args.result });
      }),
  );

  server.registerTool(
    'request_status',
    {
      title: 'Bus request status',
      description: 'Return the current state and payload of a request by id. Read-only; API key auth only.',
      inputSchema: requestStatusSchema,
    },
    (args) => call(() => bus.status(args.id)),
  );

  // --- agent registry (REQ-registry-register) ---

  server.registerTool(
    'register_agent',
    {
      title: 'Register agent',
      description:
        'Explicitly register an agent identity (name, type, capabilities). Names are unique; ' +
        'agents must be registered before using bus tools.',
      inputSchema: registerAgentSchema,
    },
    (args) => call(() => registry.register(args)),
  );

  return server;
}
