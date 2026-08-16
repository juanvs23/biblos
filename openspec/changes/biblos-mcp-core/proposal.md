# Proposal: Biblos MCP Core

## Intent

MCP server on the VPS giving agents (OpenClaw, OpenCode, Claude Code) two capabilities in one slice: (1) **documented vectorized memory** — readable Markdown + metadata (author, date, tags, project), hybrid semantic+FTS5 search; (2) **inter-agent bus** — persistent request queue (pendiente/en-proceso/completada/fallida). Biblos = common library + bus, not a central brain.

## Scope

### In Scope
- MCP server: TypeScript + `@modelcontextprotocol/sdk@1.30.0`, Streamable HTTP `/mcp`
- Tools: save/get/update/delete/search/list_documents; graph_query/render/edit; request_send/poll/respond/status
- Agent registration (name, type, capabilities)
- SQLite `/opt/biblos/biblos.db`: documents, relations, requests, FTS5, sqlite-vec
- Bearer API-key + Origin auth; embeddings via llama router 8085 (768d)
- Deploy: systemd 127.0.0.1:8199 behind Apache biblos.coltmandev.dev (Let's Encrypt)
- Clients: OpenClaw (streamable-http), OpenCode (remote, Bearer, oauth:false), Claude Code (documented)

### Out of Scope
Central brain; chat via router (v1 app logic only); OpenCode/Claude Code wiring beyond docs; Qdrant; MongoDB (other projects).

## Context / Background

Verified: Ubuntu 24.04, Node 22, llama router healthy (qwen35-4b chat; nomic-embed-text-v1.5 768d POC-validated). SDK v1 + stateless Streamable HTTP (simple Apache proxy); spec 2025-11-25 mandates Origin validation + auth. A record pending; cert after DNS.

## Capabilities

### New Capabilities
- `memory-documents`: doc CRUD + metadata; hybrid search
- `knowledge-graph`: typed relations (source→type→target)
- `agent-bus`: persistent request queue with lifecycle states
- `agent-registry`: agent identity (name, type, capabilities)
- `mcp-server-core`: HTTP server, Bearer+Origin security, embedding client

### Modified Capabilities
None (greenfield)

## Approach

Stateless `McpServer` on `/mcp`; better-sqlite3 + sqlite-vec + FTS5 single file; embedding client (normalized 768d) on write/search; hybrid merges vector ∪ FTS5 by score; Bearer+Origin middleware; systemd → Apache.

## Initial Requirements (REQ)

| ID | Requirement |
|----|-------------|
| REQ-001 | save_document: Markdown + author/date/tags/project; embed 768d |
| REQ-002 | get_document: content + metadata by ID |
| REQ-003 | update_document: edit; re-embed |
| REQ-004 | delete_document: removes embedding + edges |
| REQ-005 | search_documents: hybrid semantic+FTS5, merged ranking |
| REQ-006 | list_documents: filter project/tags, paginated |
| REQ-007 | graph_edit: add/remove relations |
| REQ-008 | graph_query: traverse by node/type/depth |
| REQ-009 | graph_render: Mermaid/Graphviz |
| REQ-010 | request_send: MUST reject unregistered destination |
| REQ-011 | request_poll: claim pending → en-proceso |
| REQ-012 | request_respond: completada/fallida + payload |
| REQ-013 | request_status; queue persists |
| REQ-014 | agent register (name, type, capabilities); unique identity |
| REQ-015 | Bearer API key; 403 on invalid Origin |
| REQ-016 | normalized 768d embeddings via 127.0.0.1:8085 |
| REQ-017 | all data in single SQLite /opt/biblos/biblos.db |

## Affected Areas

| Area | Impact |
|------|--------|
| `/mnt/1TB/IA/mcp/biblos/` | New — package, src/, vitest |
| `/opt/biblos/biblos.db` | New — SQLite file |
| Apache vhost + systemd unit | New — proxy + service |
| `/root/.openclaw/openclaw.json` | Modified — mcp.servers.biblos |
| `~/.config/opencode/opencode.json` | Modified — mcp.biblos (docs) |
| Cloudflare DNS | Modified — A record |

## Risks

| Risk | L | Mitigation |
|------|---|---|
| DNS/cert not ready | Med | Loopback first; certbot after A record |
| Hybrid ranking quality | Med | Thresholds + real-corpus tests |
| sqlite-vec native build | Low | Node 22 match; prebuild |
| Router embedding latency | Med | Timeouts; surfaced errors |

## Rollback Plan

`systemctl stop biblos` (tools down, data intact); DB file copy-restore; drop vhost + `mcp.servers.biblos`, `apachectl reload`.

## Dependencies

- `@modelcontextprotocol/sdk@1.30.0`, better-sqlite3, sqlite-vec, vitest
- llama router 127.0.0.1:8085; Cloudflare A record + Let's Encrypt; Node 22

## Success Criteria

- [ ] 17 REQs pass via MCP test client
- [ ] Two agents complete bus request end-to-end
- [ ] Hybrid search returns semantic + keyword hits
- [ ] Endpoint reachable; Bearer+Origin enforced
- [ ] Data survives restart
