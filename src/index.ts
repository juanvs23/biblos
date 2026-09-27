/**
 * HTTP server entry point (design: src/index.ts, tasks 7.3, REQ-015).
 *
 * Node http server exposing the stateless MCP Streamable HTTP endpoint:
 *
 *   POST /mcp   -> StreamableHTTPServerTransport (stateless, JSON responses)
 *   non-POST    -> 405
 *   other paths -> 404
 *
 * Auth runs first on EVERY request (REQ-core-auth): Origin allowlist -> 403,
 * Bearer key -> 401. The server refuses to start without BIBLOS_API_KEY and
 * BIBLOS_ALLOWED_ORIGINS.
 *
 * Stateless mode (design D3): no MCP-Session-Id, so the SDK requires a fresh
 * transport — and per the SDK's own stateless example a fresh McpServer too —
 * per request. Domain services wrap the shared Store, so the per-request cost
 * is only protocol wiring. The agent identity header (X-Biblos-Agent) reaches
 * tool callbacks via `extra.requestInfo.headers`.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { checkAuth, type AuthConfig } from './auth.js';
import { loadConfig, type Config } from './config.js';
import { openStore, type Store } from './db/store.js';
import { createToolsServer } from './server/tools.js';

export interface ServerDeps {
  /** Inject a store (tests use a temp file); defaults to openStore(config.dbPath). */
  store?: Store;
}

export interface CreatedServer {
  server: http.Server;
  store: Store;
}

/**
 * Build the HTTP server (not yet listening). Requires an API key and an Origin
 * allowlist; both are mandatory auth configuration (REQ-core-auth).
 */
export async function createServer(config: Config, deps: ServerDeps = {}): Promise<CreatedServer> {
  const apiKey = config.apiKey;
  const allowedOrigins = config.allowedOrigins ?? [];
  if (!apiKey || apiKey.length === 0) {
    throw new Error('BIBLOS_API_KEY must be set to start the server');
  }
  if (allowedOrigins.length === 0) {
    throw new Error('BIBLOS_ALLOWED_ORIGINS must be set to start the server');
  }
  const authConfig: AuthConfig = { apiKey, allowedOrigins };

  const store = deps.store ?? openStore(config.dbPath);
  const defaults = { minScore: config.minScore };
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, authConfig, store, defaults);
  });

  return { server, store };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authConfig: AuthConfig,
  store: Store,
  defaults: { minScore: number },
): Promise<void> {
  try {
    // 1. Auth first, every request (REQ-core-auth): Origin -> 403, Bearer -> 401.
    if (!checkAuth(req, res, authConfig)) return;

    // 2. Routing (design): 404 unknown path, 405 non-POST.
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path !== '/mcp' && path !== '/mcp/') {
      writeJson(res, 404, { error: 'not_found', message: `unknown path ${path}` });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed', message: 'only POST /mcp is supported' }));
      return;
    }

    // 3. Stateless Streamable HTTP: fresh transport + McpServer per request
    // (SDK stateless pattern — a stateless transport cannot be reused).
    const mcpServer = createToolsServer({ store, defaults });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless (D3): no MCP-Session-Id
      enableJsonResponse: true, // plain JSON replies (design reply shape)
    });
    await mcpServer.connect(transport);
    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[biblos] request error:', err);
    if (!res.headersSent) {
      writeJson(res, 500, { error: 'internal_error', message: err instanceof Error ? err.message : String(err) });
    }
  }
}

function writeJson(res: http.ServerResponse, status: number, body: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Start the server from the environment. Exported for `npm start`-style runners and E2E. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const { server, store } = await createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`[biblos] MCP server listening on http://${config.host}:${config.port}/mcp`);
  });
  const shutdown = (): void => {
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error('[biblos] failed to start:', err);
    process.exit(1);
  });
}
