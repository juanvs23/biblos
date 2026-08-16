# Biblos

**Biblos** is a multi-agent MCP server that gives your agents a shared, documented memory and a persistent inter-agent message bus. It is **not** a central brain: every agent keeps its own LLM and local memory. Biblos is the shared library and interconnect that lets otherwise independent agents (e.g. OpenClaw, OpenCode, Claude Code) persist knowledge in one place and hand work to each other in a verifiable way.

- **Documented vectorized memory** — every memory is a readable Markdown document plus structured metadata, searchable with hybrid semantic + keyword ranking.
- **Inter-agent bus** — a persistent request queue with recipient identity verification, so agents can ask each other for work and confirm the outcome.

Implements the [Model Context Protocol](https://modelcontextprotocol.io) over Streamable HTTP using the official `@modelcontextprotocol/sdk@1.30.0`. Persistence is a single SQLite file (`better-sqlite3` + `sqlite-vec` 768-dim vectors + FTS5 keyword index). Tested with **130 passing tests** (vitest).

---

## Features

Biblos exposes **14 MCP tools** across **5 domains**.

| Domain | Tools | What it does |
|---|---|---|
| **Memory documents** | `save_document`, `get_document`, `update_document`, `delete_document`, `list_documents`, `search_documents` | Store/read/edit/delete Markdown memories with metadata (author, tags, project, type). `search_documents` blends semantic (vector) and keyword (FTS5) hits with a configurable fusion weight. |
| **Knowledge graph** | `graph_edit`, `graph_query`, `graph_render` | Add/remove typed relations between documents, traverse the graph by type and depth, and render it as Mermaid (default) or Graphviz. |
| **Agent registry** | `register_agent` | Explicitly register agent identities (name, type, capabilities). Names are unique; registration is required before an agent can use the bus. |
| **Inter-agent bus** | `request_send`, `request_poll`, `request_respond`, `request_status` | A persistent request queue: send → poll → respond → status. The caller's identity comes from the `X-Biblos-Agent` header and is verified against the registered recipient on every hop. |
| **MCP server core** | (transport + auth + health) | The stateless Streamable HTTP endpoint, Bearer + Origin auth on every request, and registry/health behavior of the server itself. |

## Architecture

```
Clients (OpenClaw / OpenCode / Claude Code)
   │  MCP Streamable HTTP + Bearer + Origin + X-Biblos-Agent
   ▼
┌─────────────────────────────────────────────────────┐
│  src/index.ts  (Node http, stateless, no sessions) │
│   ┌─────────────────────────────────────────────┐  │
│   │  src/auth.ts                                │  │
│   │    Origin not allowlisted          → 403    │  │
│   │    Bearer key mismatch (timing-safe) → 401  │  │
│   └──────────────────┬──────────────────────────┘  │
│                      ▼                            │
│   McpServer — Streamable HTTP on /mcp (14 tools) │
│   └── domains: documents · graph · bus · registry │
└──────────┬─────────────────────────────┬──────────┘
           │                             │  HTTP (fetch)
      SQLite (single file)          embeddings/client.ts
      better-sqlite3                 → POST {ROUTER_URL}/v1/embeddings
      sqlite-vec vec0 (768d)               ▼
      FTS5 + sync triggers          llama.cpp router
```

Design principles:

- **Stateless Streamable HTTP.** The server does not use `MCP-Session-Id` sessions. Each request is handled by a fresh transport + `McpServer` instance, which makes proxying trivial and avoids session-affinity issues.
- **Auth first.** Every request passes through `src/auth.ts` before reaching any tool: an `Origin` not in `BIBLOS_ALLOWED_ORIGINS` (or missing on non-GET) is rejected with **403**; a wrong `BIBLOS_API_KEY` is rejected with **401** (compared with `crypto.timingSafeEqual`). The server refuses to start without both variables set.
- **Identity from the header, never from tool arguments.** The `X-Biblos-Agent` header fixes the caller's identity at the HTTP boundary, so callers cannot spoof the recipient checks that the bus enforces.
- **No web framework.** The Streamable HTTP transport is a single JSON-RPC endpoint, so the native `node:http` server is enough — no Express/Hono needed, one less dependency surface.
- **Explicit embed seam.** All router traffic is confined to `src/embeddings/client.ts` behind an `EmbeddingClient` interface; domain services mock at that seam in tests.

## Requirements

- **Node.js >= 22** (ESM, `NodeNext`).
- **External dependency — an embeddings router.** `save_document`, `update_document` (on content change) and `search_documents` need an OpenAI-style `/v1/embeddings` endpoint serving a 768-dim model. The default target is a llama.cpp server running in router mode at `ROUTER_URL` with `BIBLOS_EMBED_MODEL` (`nomic-embed-text-v1.5.Q8_0` by default). If the router is unreachable, embedding-dependent tools fail with an `embedding_service_unavailable` tool error (`isError: true`) and never write partial data; all other tools keep working.

## Configuration

All configuration comes from environment variables (see `.env.example`, read by `src/config.ts`).

| Variable | Default | Purpose |
|---|---|---|
| `BIBLOS_API_KEY` | — (required) | Bearer API key. The server refuses to start without it. |
| `BIBLOS_ALLOWED_ORIGINS` | — (required) | Comma-separated Origin allowlist. Requests with a missing/disallowed Origin get 403. |
| `ROUTER_URL` | `http://127.0.0.1:8085` | Base URL of the llama.cpp-compatible embeddings router. |
| `BIBLOS_EMBED_MODEL` | `nomic-embed-text-v1.5.Q8_0` | Embedding model served by the router. |
| `BIBLOS_EMBED_TIMEOUT_MS` | `10000` | Total per-attempt budget (ms) for one embedding call. |
| `BIBLOS_EMBED_CONNECT_TIMEOUT_MS` | `3000` | Fast-fail budget (ms) for the connect phase of an embedding call. |
| `BIBLOS_FUSION_WEIGHT` | `0.5` | Hybrid fusion weight `w` in `[0,1]`; `0.5` is a 50/50 blend of semantic and keyword scores. |
| `BIBLOS_MIN_SCORE` | `0` | Drop merged search hits below this score. |
| `DB_PATH` | `/opt/biblos/biblos.db` | SQLite database file path. |
| `BIBLOS_HOST` | `127.0.0.1` | HTTP bind host. |
| `BIBLOS_PORT` | `8199` | HTTP bind port. |

## Quick start (local)

```bash
npm ci
cp .env.example .env
# fill in BIBLOS_API_KEY (e.g. `openssl rand -hex 32`) and BIBLOS_ALLOWED_ORIGINS
npm run build
npm start
```

The server now listens on `http://127.0.0.1:8199/mcp`. It will start even if the embeddings router is down — only embedding-dependent tools will fail until the router is reachable.

## Connecting clients

Biblos speaks MCP Streamable HTTP and requires three things on **every** request:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <BIBLOS_API_KEY>` |
| `Origin` | one of the `BIBLOS_ALLOWED_ORIGINS` values |
| `X-Biblos-Agent` | the agent's registered name (never in tool arguments) |

See **[docs/clients.md](docs/clients.md)** for step-by-step configuration for **OpenClaw** (`streamable-http` transport), **OpenCode** (`type: remote`, Bearer header, `oauth: false`), and **Claude Code**, plus the registration-first rule and a curl smoke test.

## Development

```bash
npm run test       # vitest run — full suite (130 tests)
npm run typecheck  # tsc --noEmit
npm run build      # tsc -p tsconfig.build.json + copy src/db/schema.sql → dist/
```

Repository layout:

```
src/
  config.ts            env config loader (loadConfig)
  index.ts             node:http server + stateless Streamable HTTP transport
  auth.ts              Bearer + Origin middleware (every request)
  server/tools.ts      14 MCP tool registrations (zod schemas)
  domain/              documents, graph, bus, registry, types
  db/                  store.ts (better-sqlite3 facade), migrate.ts, schema.sql
  embeddings/client.ts EmbeddingClient — the only llama.cpp boundary
  hybrid/fusion.ts     weighted semantic + FTS5 fusion
tests/                 unit, integration (mocked router), and E2E suites
docs/clients.md        client integration guide
deploy/                systemd unit, env example, Apache vhost template
openspec/              SDD artifacts (proposal, specs, design, tasks)
```

Tests never require the embeddings router — it is always mocked at the `fetch` seam.

## License

[MIT](LICENSE) — © 2026 juanvs23.