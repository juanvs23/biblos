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
  /** Drop search hits below this normalized score. */
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
    minScore: num(env.BIBLOS_MIN_SCORE, 0),
    dbPath: env.DB_PATH ?? '/opt/biblos/biblos.db',
    host: env.BIBLOS_HOST ?? '127.0.0.1',
    port: num(env.BIBLOS_PORT, 8199),
  };
}
