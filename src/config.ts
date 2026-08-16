/**
 * Central environment configuration for Biblos.
 * Values map to the env table in the design (openspec/changes/biblos-mcp-core/design.md).
 * Env names are read verbatim so tests can override process.env before loadConfig().
 */

export interface Config {
  /** Bearer API key required by the HTTP server (server work unit). Optional here; enforced at the server boundary. */
  apiKey?: string;
  /** Allowed Origin values (server work unit). Optional here; enforced at the server boundary. */
  allowedOrigins?: string[];
  /** Base URL of the llama.cpp router. */
  routerUrl: string;
  /** Embedding model served by the router. */
  embedModel: string;
  /** Total per-attempt budget in ms for one embedding call. */
  embedTimeoutMs: number;
  /** Fast-fail budget for the connect phase of an embedding call, in ms. */
  embedConnectTimeoutMs: number;
  /** Hybrid fusion weight w in [0,1]; 0.5 is a 50/50 blend. */
  fusionWeight: number;
  /** Drop merged search hits below this score. */
  minScore: number;
  /** SQLite database file path. */
  dbPath: string;
  /** HTTP bind host. */
  host: string;
  /** HTTP bind port. */
  port: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiKey: env.BIBLOS_API_KEY || undefined,
    allowedOrigins: env.BIBLOS_ALLOWED_ORIGINS
      ? env.BIBLOS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    routerUrl: env.ROUTER_URL ?? 'http://127.0.0.1:8085',
    embedModel: env.BIBLOS_EMBED_MODEL ?? 'nomic-embed-text-v1.5.Q8_0',
    embedTimeoutMs: num(env.BIBLOS_EMBED_TIMEOUT_MS, 10_000),
    embedConnectTimeoutMs: num(env.BIBLOS_EMBED_CONNECT_TIMEOUT_MS, 3_000),
    fusionWeight: num(env.BIBLOS_FUSION_WEIGHT, 0.5),
    minScore: num(env.BIBLOS_MIN_SCORE, 0),
    dbPath: env.DB_PATH ?? '/opt/biblos/biblos.db',
    host: env.BIBLOS_HOST ?? '127.0.0.1',
    port: num(env.BIBLOS_PORT, 8199),
  };
}
