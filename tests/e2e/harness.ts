/**
 * E2E harness (tasks 8.1-8.3, design "Testing Strategy" E2E rows).
 *
 * Spawns the REAL built server (`dist/index.js`) as a child process with a temp
 * DB file and a free loopback port, then drives it through the official MCP SDK
 * `Client` over `StreamableHTTPClientTransport` — the same path a real client
 * (OpenClaw/OpenCode) uses. The server has no external dependencies, so no
 * stubs or routers are needed.
 *
 * The SDK client transport handles our stateless JSON server: POST replies are
 * parsed as `application/json`, and the GET SSE probe gets a 405 which the SDK
 * explicitly treats as "server does not offer an SSE stream" (not an error).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect } from 'vitest';

import { TEST_API_KEY, TEST_ORIGIN } from '../http.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- free port ---

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// --- spawned built server ---

export interface SpawnBiblosOptions {
  /** Reuse an existing DB file (restart-persistence test); default: fresh temp file. */
  dbPath?: string;
  /** Reuse an existing temp dir; default: fresh temp dir. */
  dir?: string;
  /** BIBLOS_MIN_SCORE for the child (default 0). */
  minScore?: number;
}

export interface SpawnedBiblos {
  url: string;
  dbPath: string;
  dir: string;
  child: ChildProcess;
  /** Kill the child process (idempotent); files are kept. */
  stop(): Promise<void>;
  /** stop() + remove the temp dir (idempotent). */
  remove(): Promise<void>;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    sleep(3_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

/**
 * Wait until the spawned server answers an authenticated initialize POST. Any
 * HTTP status counts as "ready" — a network error means it is not listening yet.
 */
async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${TEST_API_KEY}`,
          Origin: TEST_ORIGIN,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e-warmup', version: '1.0.0' } },
        }),
      });
      if (typeof res.status === 'number') return;
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(`biblos server did not become ready on ${url} (last error: ${String(lastError)})`);
}

/** Spawn `node dist/index.js` with a clean test environment. */
export async function spawnBiblos(options: SpawnBiblosOptions): Promise<SpawnedBiblos> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'biblos-e2e-'));
  const dbPath = options.dbPath ?? join(dir, 'biblos.db');
  const port = await getFreePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BIBLOS_API_KEY: TEST_API_KEY,
    BIBLOS_ALLOWED_ORIGINS: TEST_ORIGIN,
    DB_PATH: dbPath,
    BIBLOS_HOST: '127.0.0.1',
    BIBLOS_PORT: String(port),
    BIBLOS_MIN_SCORE: String(options.minScore ?? 0),
  };
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(url);
  } catch (err) {
    await stopChild(child);
    throw new Error(`spawned server failed to start. stderr:\n${stderr}\n${String(err)}`);
  }
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopChild(child);
  };
  const remove = async (): Promise<void> => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { url, dbPath, dir, child, stop, remove };
}

// --- MCP client (SDK Client over Streamable HTTP, per-agent identity) ---

export interface AgentClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  close(): Promise<void>;
}

/**
 * Connect an SDK Client to the built server with the given agent identity.
 * The identity travels as the `X-Biblos-Agent` header on EVERY request, exactly
 * like a production client (design D4 — never in tool arguments).
 */
export async function connectAgent(url: string, agent: string): Promise<AgentClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        Origin: TEST_ORIGIN,
        'X-Biblos-Agent': agent,
      },
    },
  });
  const client = new Client({ name: `e2e-${agent}`, version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    close: () => client.close(),
  };
}

// --- result parsing (same contract as tests/tools.test.ts) ---

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

/** Register an agent (registration-first rule) and assert success. */
export async function registerAgent(session: AgentClient, name: string): Promise<void> {
  const result = await session.client.callTool({
    name: 'register_agent',
    arguments: { name, type: 'worker', capabilities: ['memory', 'bus'] },
  });
  const agent = parseOk(result) as { name: string; createdAt: string };
  expect(agent.name).toBe(name);
  expect(new Date(agent.createdAt).getTime()).not.toBeNaN();
}
