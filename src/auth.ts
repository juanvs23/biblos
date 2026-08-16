/**
 * HTTP request authentication middleware (design: src/auth.ts, tasks 7.1).
 *
 * Enforcement order, per design Security section and REQ-core-auth
 * (MCP 2025-11-25):
 *
 *   1. Origin allowlist -> 403. A present Origin that is not in
 *      BIBLOS_ALLOWED_ORIGINS is rejected; a MISSING Origin on any non-GET
 *      request is also rejected (the MCP protocol requires the Origin header;
 *      GET is exempted so plain health probes are not blocked).
 *   2. Bearer API key -> 401. The key is compared with
 *      `crypto.timingSafeEqual` so timing does not leak the token.
 *
 * Applies to every request, including unknown paths and non-POST methods
 * (REQ-core-auth "on every request").
 */
import { timingSafeEqual } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AuthConfig {
  /** Bearer API key that every request must present (from BIBLOS_API_KEY). */
  apiKey: string;
  /** Exact Origin header values that are allowed (from BIBLOS_ALLOWED_ORIGINS). */
  allowedOrigins: string[];
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function reject(res: ServerResponse, status: number, body: Record<string, string>, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...JSON_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

/**
 * Authenticate a request. On success returns true and the caller continues to
 * routing; on failure writes the HTTP error response and returns false.
 */
export function checkAuth(req: IncomingMessage, res: ServerResponse, config: AuthConfig): boolean {
  const method = req.method ?? 'GET';
  const origin = req.headers.origin;

  // 1. Origin validation (403, per MCP 2025-11-25 disallowed/missing Origin).
  if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
    reject(res, 403, { error: 'forbidden', message: `origin "${origin}" is not allowed` });
    return false;
  }
  if (origin === undefined && method !== 'GET') {
    reject(res, 403, { error: 'forbidden', message: 'missing Origin header is not allowed on this method' });
    return false;
  }

  // 2. Bearer key validation (401).
  const authorization = (req.headers.authorization ?? '').trim();
  if (authorization.length === 0 || !authorization.startsWith('Bearer ')) {
    reject(res, 401, { error: 'unauthorized', message: 'missing or malformed Authorization header' }, {
      'WWW-Authenticate': 'Bearer',
    });
    return false;
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (token.length === 0 || !safeEqual(token, config.apiKey)) {
    reject(res, 401, { error: 'unauthorized', message: 'invalid API key' }, { 'WWW-Authenticate': 'Bearer' });
    return false;
  }

  return true;
}

/** Constant-time string comparison; unequal lengths fail fast (length is not secret here). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
