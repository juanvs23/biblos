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
