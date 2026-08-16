/**
 * HTTP-level test harness: starts the real server (createServer from
 * src/index.ts) on an ephemeral loopback port with a temp SQLite DB and the
 * mocked embedding seam — no external network. Used by the auth matrix
 * (tests/auth.test.ts) and the tools HTTP integration (tests/tools.test.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../src/config.js';
import { openStore, type Store } from '../src/db/store.js';
import { createServer } from '../src/index.js';
import { mockEmbeddings } from './helpers.js';

export interface HttpHarness {
  baseUrl: string;
  store: Store;
  dbPath: string;
  close(): Promise<void>;
}

export const TEST_API_KEY = 'test-api-key-123';
export const TEST_ORIGIN = 'https://app.coltmandev.dev';

export function testConfig(dbPath: string, overrides: Partial<Config> = {}): Config {
  return {
    apiKey: TEST_API_KEY,
    allowedOrigins: [TEST_ORIGIN],
    routerUrl: 'http://127.0.0.1:8085',
    embedModel: 'nomic-embed-text-v1.5.Q8_0',
    embedTimeoutMs: 10_000,
    embedConnectTimeoutMs: 3_000,
    fusionWeight: 0.5,
    minScore: 0,
    dbPath,
    host: '127.0.0.1',
    port: 0,
    ...overrides,
  };
}

export async function startHttpServer(overrides: Partial<Config> = {}): Promise<HttpHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'biblos-http-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore(dbPath);
  const { server } = await createServer(testConfig(dbPath, overrides), { store, embeddings: mockEmbeddings() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    dbPath,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface JsonRpcResult {
  status: number;
  /** Parsed JSON body, or null for empty bodies. */
  body: unknown;
}

export interface RpcHeaders {
  authorization?: string;
  origin?: string;
  agent?: string;
  protocolVersion?: string;
}

/**
 * POST a raw JSON-RPC message to /mcp. Default headers mimic a real MCP client
 * (Accept and Content-Type per the Streamable HTTP spec); override with the
 * given header values (pass an explicit undefined to drop a header).
 */
export async function postJsonRpc(
  baseUrl: string,
  message: unknown,
  headers: RpcHeaders = {},
): Promise<JsonRpcResult> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(headers.authorization !== undefined ? { Authorization: headers.authorization } : {}),
      ...(headers.origin !== undefined ? { Origin: headers.origin } : {}),
      ...(headers.agent !== undefined ? { 'X-Biblos-Agent': headers.agent } : {}),
      ...(headers.protocolVersion !== undefined ? { 'MCP-Protocol-Version': headers.protocolVersion } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
}

export function authHeaders(agent?: string): RpcHeaders {
  return { authorization: `Bearer ${TEST_API_KEY}`, origin: TEST_ORIGIN, agent };
}
