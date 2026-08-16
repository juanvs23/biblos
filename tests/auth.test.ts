/**
 * Auth middleware tests (tasks 7.4, REQ-core-auth).
 *
 * Unit level: `checkAuth` is exercised with stub req/res objects covering the
 * full decision matrix. The raw-HTTP variant over a live ephemeral-port server
 * lives in the same file under `describe('raw HTTP')` (requires src/index.ts,
 * added by the server work unit).
 */
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { checkAuth, type AuthConfig } from '../src/auth.js';
import { createServer } from '../src/index.js';
import { authHeaders, postJsonRpc, startHttpServer, TEST_API_KEY, TEST_ORIGIN, testConfig } from './http.js';

const VALID_KEY = 'secret-api-key-123';

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return { apiKey: VALID_KEY, allowedOrigins: ['https://app.coltmandev.dev'], ...overrides };
}

interface StubRes {
  status: number | undefined;
  headers: Record<string, string | number | string[]>;
  body: string;
}

function makeRes(): { res: ServerResponse; stub: StubRes } {
  const stub: StubRes = { status: undefined, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers: Record<string, string | number | string[]>) {
      stub.status = status;
      stub.headers = headers;
      return res;
    },
    end(body: string) {
      stub.body = body;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, stub };
}

function makeReq(partial: Partial<Pick<IncomingMessage, 'headers' | 'method'>> = {}): IncomingMessage {
  return { headers: {}, method: 'POST', ...partial } as IncomingMessage;
}

const ALLOWED = 'https://app.coltmandev.dev';
const AUTH_OK = `Bearer ${VALID_KEY}`;

describe('checkAuth — origin validation', () => {
  it('403 when the Origin is not in the allowlist', () => {
    const { res, stub } = makeRes();
    const ok = checkAuth(makeReq({ headers: { origin: 'https://evil.example', authorization: AUTH_OK } }), res, config());
    expect(ok).toBe(false);
    expect(stub.status).toBe(403);
    expect(JSON.parse(stub.body).error).toBe('forbidden');
  });

  it('403 when the Origin header is missing on a non-GET request', () => {
    const { res, stub } = makeRes();
    const ok = checkAuth(makeReq({ headers: { authorization: AUTH_OK } }), res, config());
    expect(ok).toBe(false);
    expect(stub.status).toBe(403);
    expect(JSON.parse(stub.body).error).toBe('forbidden');
  });

  it('403 when the Origin is missing on POST even with no API key (origin check runs first)', () => {
    const { res, stub } = makeRes();
    const ok = checkAuth(makeReq(), res, config());
    expect(ok).toBe(false);
    expect(stub.status).toBe(403); // NOT 401: origin failure precedes bearer failure
  });

  it('GET without Origin is not rejected by the origin rule (reaches bearer check)', () => {
    const { res, stub } = makeRes();
    const ok = checkAuth(makeReq({ method: 'GET', headers: { authorization: AUTH_OK } }), res, config());
    expect(ok).toBe(true);
    expect(stub.status).toBeUndefined();
  });
});

describe('checkAuth — bearer validation', () => {
  it('401 when no Authorization header is present', () => {
    const { res, stub } = makeRes();
    const ok = checkAuth(makeReq({ headers: { origin: ALLOWED } }), res, config());
    expect(ok).toBe(false);
    expect(stub.status).toBe(401);
    expect(stub.headers['WWW-Authenticate']).toBe('Bearer');
    expect(JSON.parse(stub.body).error).toBe('unauthorized');
  });

  it('401 when the Authorization scheme is not Bearer', () => {
    const { res, stub } = makeRes();
    const ok = checkAuth(
      makeReq({ headers: { origin: ALLOWED, authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } }),
      res,
      config(),
    );
    expect(ok).toBe(false);
    expect(stub.status).toBe(401);
  });

  it('401 when the Bearer key is wrong', () => {
    const { res, stub } = makeRes();
    const ok = checkAuth(makeReq({ headers: { origin: ALLOWED, authorization: 'Bearer nope' } }), res, config());
    expect(ok).toBe(false);
    expect(stub.status).toBe(401);
  });

  it('401 when the Bearer token is empty', () => {
    const { res, stub } = makeRes();
    const ok = checkAuth(makeReq({ headers: { origin: ALLOWED, authorization: 'Bearer   ' } }), res, config());
    expect(ok).toBe(false);
    expect(stub.status).toBe(401);
  });
});

describe('checkAuth — accepted requests', () => {
  it('passes with the exact allowed Origin and valid key (POST)', () => {
    const { res, stub } = makeRes();
    const ok = checkAuth(makeReq({ headers: { origin: ALLOWED, authorization: AUTH_OK } }), res, config());
    expect(ok).toBe(true);
    expect(stub.status).toBeUndefined();
    expect(stub.body).toBe('');
  });

  it('passes with any configured Origin and valid key', () => {
    const cfg = config({ allowedOrigins: ['https://one.example', 'https://two.example'] });
    const { res } = makeRes();
    expect(
      checkAuth(makeReq({ headers: { origin: 'https://two.example', authorization: AUTH_OK } }), res, cfg),
    ).toBe(true);
  });

  it('trims whitespace around the Bearer token', () => {
    const { res } = makeRes();
    expect(checkAuth(makeReq({ headers: { origin: ALLOWED, authorization: `  Bearer ${VALID_KEY}  ` } }), res, config())).toBe(
      true,
    );
  });
});

// Keep a stub for tests that build a res manually (used by later raw-HTTP
// describes when they share helper expectations).
export { makeRes, makeReq };

describe('raw HTTP — auth matrix (REQ-core-auth, MCP 2025-11-25)', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
  };

  it('401 without an API key (valid Origin)', async () => {
    const h = await startHttpServer();
    try {
      const { status, body } = await postJsonRpc(h.baseUrl, initialize, { origin: TEST_ORIGIN });
      expect(status).toBe(401);
      expect((body as { error: string }).error).toBe('unauthorized');
    } finally {
      await h.close();
    }
  });

  it('401 with a wrong API key (valid Origin)', async () => {
    const h = await startHttpServer();
    try {
      const { status } = await postJsonRpc(h.baseUrl, initialize, {
        authorization: 'Bearer wrong-key',
        origin: TEST_ORIGIN,
      });
      expect(status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('403 with a disallowed Origin (valid API key)', async () => {
    const h = await startHttpServer();
    try {
      const { status, body } = await postJsonRpc(h.baseUrl, initialize, {
        authorization: `Bearer ${TEST_API_KEY}`,
        origin: 'https://evil.example',
      });
      expect(status).toBe(403);
      expect((body as { error: string }).error).toBe('forbidden');
    } finally {
      await h.close();
    }
  });

  it('403 with a missing Origin on POST (valid API key)', async () => {
    const h = await startHttpServer();
    try {
      const { status } = await postJsonRpc(h.baseUrl, initialize, {
        authorization: `Bearer ${TEST_API_KEY}`,
      });
      expect(status).toBe(403);
    } finally {
      await h.close();
    }
  });

  it('403 wins over 401 when BOTH origin and key are invalid (origin check runs first)', async () => {
    const h = await startHttpServer();
    try {
      const { status } = await postJsonRpc(h.baseUrl, initialize, {
        authorization: 'Bearer nope',
        origin: 'https://evil.example',
      });
      expect(status).toBe(403);
    } finally {
      await h.close();
    }
  });

  it('200 with valid API key + allowed Origin completes an initialize handshake', async () => {
    const h = await startHttpServer();
    try {
      const { status, body } = await postJsonRpc(h.baseUrl, initialize, authHeaders());
      expect(status).toBe(200);
      const result = body as { result: { protocolVersion: string; capabilities: { tools?: unknown } } };
      expect(result.result.protocolVersion).toBe('2025-11-25');
      expect(result.result.capabilities.tools).toBeDefined();
    } finally {
      await h.close();
    }
  });

  it('405 for non-POST on /mcp (after passing auth)', async () => {
    const h = await startHttpServer();
    try {
      const res = await fetch(`${h.baseUrl}/mcp`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${TEST_API_KEY}`, Origin: TEST_ORIGIN },
      });
      expect(res.status).toBe(405);
    } finally {
      await h.close();
    }
  });

  it('404 for unknown paths (auth still applies first)', async () => {
    const h = await startHttpServer();
    try {
      // unknown path WITH valid auth -> 404
      const authed = await fetch(`${h.baseUrl}/nope`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          Origin: TEST_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      expect(authed.status).toBe(404);
      // unknown path WITHOUT auth -> 401 (auth on every request, REQ-core-auth).
      // A valid Origin is sent so the missing key is the only failure (origin
      // check runs first and would otherwise return 403 for missing Origin).
      const unauthed = await fetch(`${h.baseUrl}/nope`, {
        method: 'POST',
        headers: { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(unauthed.status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('refuses to start without BIBLOS_API_KEY or BIBLOS_ALLOWED_ORIGINS', async () => {
    const h = await startHttpServer();
    try {
      await expect(
        createServer(testConfig(h.dbPath, { apiKey: undefined, allowedOrigins: undefined })),
      ).rejects.toThrow(/BIBLOS_API_KEY/);
      await expect(createServer(testConfig(h.dbPath, { apiKey: 'k', allowedOrigins: [] }))).rejects.toThrow(
        /BIBLOS_ALLOWED_ORIGINS/,
      );
    } finally {
      await h.close();
    }
  });
});
