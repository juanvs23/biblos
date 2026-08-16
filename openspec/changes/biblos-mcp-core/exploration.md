# Exploration: biblos-mcp-core

> SDD `sdd-explore` artifact — 2026-08-15. Hybrid mode (openspec + Engram, obs `sdd/biblos-mcp-core/explore`).
> All VPS facts verified live via SSH (read-only) against coltmandev.dev (62.171.164.5). SDK/Spec facts from npm registry, modelcontextprotocol.io (2025-11-25 spec), opencode.ai docs, and the OpenClaw repo docs (main).

## Executive Summary

Investigated the four open questions for the first Biblos slice. The official TypeScript MCP SDK supports Streamable HTTP on two lines (stable monolith `@modelcontextprotocol/sdk@1.30.0`; new v2 modular `@modelcontextprotocol/server|node|express@2.0.0`). Both agents can consume a remote HTTP server: OpenClaw (VPS, v2026.7.1-2) supports `transport: "streamable-http"` under `mcp.servers` (verified in its docs; an SSE remote `qbook` already exists on the VPS), and OpenCode supports `type: "remote"` + `headers` + `oauth: false`. Persistence: MongoDB 7.0.37 (docker `mongo-prod`) is the documented source of truth; it has no built-in vector search (Atlas-only), so vector index = Qdrant in Docker (ports 6333/6334 free) or in-Mongo brute-force cosine behind an interface. Security: replicate the proven Apache vhost + Let's Encrypt pattern (needs a new Cloudflare A record for `biblos.coltmandev.dev`) and enforce Bearer API-key + Origin validation in the app (MCP spec MUST). **Slice-1 recommendation: v1 SDK, stateless Streamable HTTP on `/mcp`, systemd service on 127.0.0.1, MongoDB for docs+relations, embeddings via llama router 8085.**

## Current State

- **VPS** (verified live): Ubuntu 24.04.4 LTS, 6 vCPU, 11 GiB RAM (8.2 GiB available), 191 GiB disk free, **no GPU**, load ~0.9. Node **v22.23.2**, npm 10.9.8.
- **llama.cpp ROUTER MODE** healthy: `curl 127.0.0.1:8085/health` → `{"status":"ok"}`; worker ports `45769` and `36423` also report ok. OpenClaw gateway on `127.0.0.1:18789` (systemd `openclaw.service`, version `2026.7.1-2`, `gateway.auth.mode=password`, binds loopback — do NOT modify).
- **Docker**: `mongo-prod` (mongo:7, **7.0.37**, `--auth`, admin creds in container env `MONGO_INITDB_ROOT_USERNAME/PASSWORD`, volume `mongo-data`, **published 0.0.0.0:27017**), dokploy (3001), n8n (5678), mailserver, roundcube (8082), openpencil (3002). Networks: bridge, dokploy-network, host, n8n_default, mailserver_mailnet.
- **Apache 2.4**: modules `proxy`, `proxy_http`, `proxy_wstunnel`, `ssl`, `headers`, `rewrite`, `auth_basic`, `authz_core/host/user`. Sites: 000-default, default-ssl, design.coltmandev.dev, dokploy, mail, n8n, openclaw, openship, projects.coltmandev.dev. Certbot ECDSA certs under `/etc/letsencrypt/live/`. **DNS at Cloudflare** (kenneth/tina.ns.cloudflare.com). `dig biblos.coltmandev.dev` → **no A record yet**.
- **Project**: `/mnt/1TB/IA/mcp/biblos` only has `.atl/` + openspec bootstrap (hybrid mode); no git, no package.json. Workstation `~/.config/opencode/opencode.json` already has one remote MCP (`context7`, type remote).

## Findings

### 1. Official MCP TypeScript SDK — Streamable HTTP

**Two lines available on npm (checked 2026-08-15):**

| Package | Version (latest) | Notes |
|---|---|---|
| `@modelcontextprotocol/sdk` | **1.30.0** (published 2026-07-27) | Monolith. `McpServer` from `server/mcp.js`; `StreamableHTTPServerTransport` from `server/streamableHttp.js`; Node >=18 |
| `@modelcontextprotocol/core` | 2.0.0 | v2: zod schemas / protocol constants (zod ^4.2.0) |
| `@modelcontextprotocol/server` | 2.0.0 | v2: `McpServer`, `WebStandardStreamableHTTPServerTransport`; deps zod ^4.2.0 + core; Node >=20 |
| `@modelcontextprotocol/node` | 2.0.0 | Node HTTP integration; peer: `hono ^4.11.4` + `@modelcontextprotocol/server`; dep `@hono/node-server`; `NodeStreamableHTTPServerTransport` |
| `@modelcontextprotocol/express` / `fastify` / `hono` | 2.0.0 | Framework adapters |
| `@modelcontextprotocol/client` | 2.0.0 | v2 client (`StreamableHTTPClientTransport`) |

- **v1 stable** — one package, maximal example surface, session-aware transport. Recommended for slice 1.
- **v2 modular** — forward-looking; SSE transport was removed in v2 (legacy via `@modelcontextprotocol/server-legacy/sse`); Node HTTP integration is Hono-based (`@hono/node-server`); official Host/Origin validation helpers (`localhostHostValidation`, `localhostOriginValidation`). Newest releases (2.0.0), smaller community surface.

**Spec authority (2025-11-25, modelcontextprotocol.io/specification/2025-11-25/basic/transports):**
- Streamable HTTP = single MCP endpoint supporting **POST** (JSON-RPC; Accept `application/json` + `text/event-stream`; 202 for notifications/responses; JSON or SSE responses) and **GET** (optional SSE stream, else 405).
- Sessions optional via `MCP-Session-Id` header; `MCP-Protocol-Version` header; 404 → client restarts session; DELETE terminates.
- Security **MUSTs**: validate `Origin` → 403 (DNS-rebinding), authenticate all connections, bind localhost when local.

### 2. Client integration (OpenClaw + OpenCode)

**OpenClaw** (VPS config `/root/.openclaw/openclaw.json`, verified; docs `docs/tools/mcp.md` on main):
- Remote servers live under `mcp.servers.<name>`; the VPS already runs one remote server this way (`qbook` with `transport: "sse"`).
- Schema (from docs):
```json5
{ mcp: { servers: { biblos: {
  url: "https://biblos.coltmandev.dev/mcp",
  transport: "streamable-http",   // "streamable-http" | "sse" | "stdio"
  enabled: true,
  connectionTimeoutMs: 5000,
  requestTimeoutMs: 20000,
  toolFilter: { include: ["documents_*"] }
} } } }
```
- CLI: `openclaw mcp add biblos --url <url> --transport streamable-http [--include '...']`; verify `openclaw mcp doctor biblos --probe`; apply `openclaw mcp reload`. OAuth HTTP servers: `auth: "oauth"` + `openclaw mcp login`. Sensitive headers must use OpenClaw secret mechanisms, not config literals.
- Constraint: gateway binds loopback and has `gateway.auth` (password/token) — **do not modify**; gateway restart can disrupt WhatsApp channels.

**OpenCode** (docs opencode.ai/docs/mcp-servers; local opencode.json uses the remote pattern for context7):
```json
{ "mcp": { "biblos": {
  "type": "remote",
  "url": "https://biblos.coltmandev.dev/mcp",
  "enabled": true,
  "headers": { "Authorization": "Bearer {env:BIBLOS_API_KEY}" },
  "oauth": false
} } }
```
- **`oauth: false` is mandatory** for API-key servers: OpenCode auto-detects a 401 and starts an OAuth flow (RFC 7591 dynamic registration).
- `{env:VAR}` substitution supported; remote tool-list fetch timeout defaults to 5000 ms; tools are namespaced `<server>_*`.

### 3. Persistence options on the VPS

- **MongoDB** `mongo-prod`: 7.0.37, admin via `MONGO_INITDB_ROOT_USERNAME/PASSWORD` env, `--auth`, volume `mongo-data`, reachable at `127.0.0.1:27017` (and, today, from the internet — see Risks). Node driver `mongodb@7.5.0` (mongoose 9.9.2 if preferred). Self-managed MongoDB has **no vector search** (Atlas-only) → vectors stored as arrays, similarity computed in-app.
- **Vector index options:**

| Option | Fit | Notes |
|---|---|---|
| **Qdrant in Docker** | Best for designated vector store | Ports **6333/6334 free**; HNSW; REST + gRPC; ~50–100 MB RAM idle; official image; per-collection 768-dim config |
| Chroma in Docker | Workable | Default port **8000 occupied** by local `workspace-mcp` (127.0.0.1:8000) → must remap (e.g. 8001); heavier footprint |
| In-Mongo brute-force cosine | Slice-1 friendly | Zero new infra; fine up to ~10–50k docs × 768 dims; O(n) per query |
| In-process HNSW (`hnswlib-node`) | Alternative | In-memory, resets on restart unless persisted |

- Resources: 8.2 GiB RAM available, 191 GiB disk, 6 vCPU, load ~0.9 — any option fits comfortably.

### 4. Security / exposing biblos.coltmandev.dev

- **Apache pattern (verified, copy it)**: per-site vhost in `/etc/apache2/sites-enabled/`; `<VirtualHost *:80>` redirect → `<VirtualHost *:443>` with `ProxyPreserveHost On`, `ProxyPass / http://127.0.0.1:<port>/`, `SSLCertificateFile /etc/letsencrypt/live/<domain>/...`, HSTS header. Basic-auth example exists (design site, `.htpasswd-openpencil`) — but for `/mcp` prefer **in-app Bearer auth** (Basic challenges break JSON-RPC clients).
- **Step order for the new endpoint**: (1) Cloudflare **A record** `biblos.coltmandev.dev` → 62.171.164.5 (currently absent); (2) `certbot --apache -d biblos.coltmandev.dev`; (3) vhost + ProxyPass to the app port; if SSE streams are used, disable proxy buffering (`SetEnv proxy-sendchunked 1`) — the existing `openclaw.conf` already proxies SSE/websocket fine.
- **App-level auth** (spec MUST): Bearer API-key middleware + Origin allowlist → 403. Both clients can send the header (OpenClaw via secret store, OpenCode via `headers`).
- **Firewall**: restrict MongoDB `27017` to loopback/private via ufw (currently 0.0.0.0 with auth). OpenClaw gateway is loopback-bound (good).

## Affected Areas

- `openspec/changes/biblos-mcp-core/exploration.md` — this artifact (created).
- VPS `/etc/apache2/sites-enabled/biblos.coltmandev.dev.conf` — to create (pattern: openclaw.conf).
- VPS `/root/.openclaw/openclaw.json` → `mcp.servers.biblos` — additive, via `openclaw mcp add`; avoid gateway restarts mid-day.
- `~/.config/opencode/opencode.json` → `mcp.biblos` — client entry (later slice).
- `mongo-prod` — new `biblos` database + scoped app user; ufw rule for 27017.
- New biblos app: TypeScript package (package.json, tsconfig), systemd unit, optional Qdrant container.

## Approaches

1. **Server: v1 SDK monolith** (`@modelcontextprotocol/sdk@1.30.0`) — `McpServer` + `StreamableHTTPServerTransport`.
   - Pros: battle-tested, one dependency, session-aware, abundant examples; compatible with Apache proxy and both clients.
   - Cons: not the new modular v2 line; future migration needed.
   - Effort: Low.
2. **Server: v2 modular SDK** (`@modelcontextprotocol/server` + `@modelcontextprotocol/node` or `@modelcontextprotocol/express`, 2.0.0).
   - Pros: forward-looking, framework adapters, official Origin/Host validation helpers.
   - Cons: newest releases, smaller example surface, Hono-based Node layer, zod v4 — more moving parts for slice 1.
   - Effort: Medium.
3. **Vector index**: in-Mongo brute-force cosine now behind a `VectorStore` interface → Qdrant (docker, 6333/6334) as documented drop-in. Chroma not preferred (port conflict + heavier).
   - Effort: Low (Mongo) / Low (Qdrant when added).
4. **Deploy**: systemd unit (`node dist/index.js`, bind 127.0.0.1:8199) behind Apache — consistent with `openclaw.service`; docker-on-bridge is the alternative (reaches `mongo-prod` by name).
   - Effort: Low.

## Recommendation

Slice 1 **"biblos-mcp-core"**: Node 22 LTS (align with VPS) + TypeScript + `@modelcontextprotocol/sdk@1.30.0`. Single `McpServer` on `/mcp`, **stateless** Streamable HTTP (no session IDs → trivial Apache proxying); Bearer API-key middleware + Origin allowlist (403); tools: health + minimal document write/read + relationship write/read. Persistence: `mongodb@7.5.0` → `biblos` DB (collections `documents`, `relations`); embeddings via llama router `127.0.0.1:8085` (nomic 768d); vector search = brute-force cosine behind `VectorStore` interface with Qdrant as the documented drop-in. Deploy: systemd unit bound `127.0.0.1:8199`; Apache vhost `biblos.coltmandev.dev`. Agent wiring (OpenClaw/OpenCode client entries) deferred to a later slice but fully specified above.

## Risks

- **MongoDB 27017 exposed to the internet today** (0.0.0.0, --auth, admin creds in docker env). Add ufw rule before launch.
- **Node version drift**: dev bootstrap says v24.19.0 vs VPS v22.23.2. Both satisfy SDK engines (>=18/20); pin engines and use a project-local Node (nvm/asdf — asdf tarballs already in /root) on the VPS.
- **SDK line choice**: v2.0.0 is newest with a smaller community surface; v1 recommended for slice 1 to keep risk low.
- **No A record** for `biblos.coltmandev.dev` — must be created in Cloudflare before certbot can issue the cert.
- **OpenClaw**: gateway restart can disrupt WhatsApp channels; use `openclaw mcp add`/`reload` and never touch `gateway.auth`.
- **Stale llama-cpp provider**: openclaw `models.providers.llama-cpp` still points to `127.0.0.1:8080` (not listening); biblos must target the router at `8085` (embedding endpoint shape to confirm in design).
- **SSE through Apache**: reuse the proven openclaw.conf pattern; stateless single-instance server avoids session-affinity issues.
- **Secrets**: API key must live in OpenClaw's secret store / environment, never in config literals.

## Ready for Proposal

**Yes.** The orchestrator should tell the user: (1) decide SDK v1 vs v2 (recommend v1 for slice 1); (2) approve adding the Cloudflare A record + ufw rule for MongoDB 27017; (3) confirm slice-1 scope excludes the inter-agent bus (deferred to slice 2).
