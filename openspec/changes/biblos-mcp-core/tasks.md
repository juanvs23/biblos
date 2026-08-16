# Tasks: Biblos MCP Core

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2,400–3,000 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 → PR 4 (work units below) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

```
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High
```

Scope note: one change, one slice (memory + bus together, per user). Work units are PR grouping only, not change division. Threat matrix is all `N/A` — no RED shell tasks.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Scaffold + DB store + embeddings + fusion + documents | PR 1 | `npx vitest run tests/store.test.ts tests/fusion.test.ts tests/documents.test.ts tests/embeddings.test.ts` | Temp-file SQLite; router mocked at fetch seam (no network needed) | Delete `src/db/ src/embeddings/ src/hybrid/ src/domain/documents.ts` + tests |
| 2 | Graph + registry + bus domains | PR 2 | `npx vitest run tests/graph.test.ts tests/registry.test.ts tests/bus.test.ts` | Temp-file SQLite (in-memory domain logic) | Delete `src/domain/{graph,registry,bus}.ts` + tests |
| 3 | Auth + tools + server wiring | PR 3 | `npx vitest run tests/auth.test.ts tests/tools.test.ts` | Ephemeral-port server, raw HTTP POSTs with/without Bearer/Origin | Revert `src/auth.ts src/server/ src/index.ts` |
| 4 | E2E + deploy + client docs | PR 4 | `npm run build && npx vitest run tests/e2e` | Spawn `dist/index.js` (temp env); VPS smoke `curl 127.0.0.1:8199` | Revert `deploy/ docs/ tests/e2e/` |

## Phase 1: Scaffold & Foundation

- [x] 1.1 Create `package.json` (engines node>=22; deps @modelcontextprotocol/sdk@1.30.0, better-sqlite3, sqlite-vec; dev typescript, vitest, @types/node, @types/better-sqlite3) + `npm install` — done: install exits 0 — ~25 ln
- [x] 1.2 Create `tsconfig.json` (ES2022, NodeNext) + `vitest.config.ts` — done: `tsc --noEmit` passes smoke — ~25 ln
- [x] 1.3 Create `.env.example` (BIBLOS_API_KEY, BIBLOS_ALLOWED_ORIGINS, ROUTER_URL, DB_PATH, BIBLOS_HOST/PORT, BIBLOS_EMBED_MODEL, BIBLOS_FUSION_WEIGHT, BIBLOS_EMBED_TIMEOUT_MS) + `.gitignore` — done: keys match design table — ~30 ln
- [x] 1.4 Create `tests/smoke.test.ts` — vitest runner green (unblocks strict_tdd) — done: `npx vitest run` passes — ~10 ln
- [x] 1.5 `git init` + baseline commit (repo base for PRs) — done: `git log` shows baseline — ~1 ln

## Phase 2: Persistence Core (REQ-017)

- [x] 2.1 Create `src/db/schema.sql` — documents, documents_fts + sync triggers, document_embeddings vec0(768), relations, agents, requests + indexes; PRAGMA WAL/foreign_keys/busy_timeout — done: applies clean on temp DB; FTS+vec tables exist — ~60 ln
- [x] 2.2 Create `src/db/migrate.ts` — idempotent boot migration — done: runs twice, no error — ~40 ln
- [x] 2.3 Create `src/domain/types.ts` — DocumentRecord, Relation, RequestState, BusRequest, AgentRecord, SearchHit — done: `tsc --noEmit` — ~40 ln
- [x] 2.4 Create `src/db/store.ts` — sync Store facade: doc CRUD, vectorSearch, ftsSearch, relations, registry, bus ops; every multi-statement op in txn with rollback; SQLITE_BUSY surfaced (REQ-017) — done: store tests green — ~220 ln
- [x] 2.5 Create `tests/store.test.ts` — temp DB: CRUD, cascade delete, FTS trigger sync, data survives reopen (REQ-017, REQ-bus-status restart) — done: vitest green — ~120 ln

## Phase 3: Embeddings Client (REQ-016)

- [x] 3.1 Create `src/embeddings/client.ts` — EmbeddingClient: POST `{ROUTER_URL}/v1/embeddings` (model nomic-embed-text-v1.5.Q8_0), L2-normalize 768d, timeout 3s/10s via AbortSignal, 1 retry, typed error — done: unit tests green — ~90 ln
- [x] 3.2 Create `tests/embeddings.test.ts` — mock fetch: healthy → normalized 768d; unreachable/timeout → surfaced error, no partial write (REQ-core-embeddings) — done: vitest green — ~80 ln

## Phase 4: Memory Documents Domain (REQ-001..006)

- [x] 4.1 Create `src/hybrid/fusion.ts` — semantic=max(0,1−d²/2), fts=1/(1+|bm25|), merged=w·sem+(1−w)·fts, union k=50, min-score filter (REQ-005) — done: golden tests — ~50 ln
- [x] 4.2 Create `src/domain/documents.ts` — save (embed-then-txn, D6), get, update (re-embed only on content change), delete (atomic docs+fts+vec+edges), list (json_each tag filter + pagination) (REQ-001..006) — done: documents+store tests — ~130 ln
- [x] 4.3 Create `tests/fusion.test.ts` — golden scores, weight clamp, empty→[] (REQ-005) — done: vitest green — ~60 ln
- [x] 4.4 Create `tests/documents.test.ts` — invalid save → no partial row; get unknown → not-found; metadata-only update → no re-embed; delete removes edges (REQ-001..004) — done: vitest green — ~130 ln

## Phase 5: Knowledge Graph Domain (REQ-007..009)

- [x] 5.1 Create `src/domain/graph.ts` — add/remove relation (reject unknown node), BFS query by type/depth, Mermaid default + Graphviz render — done: graph tests — ~110 ln
- [x] 5.2 Create `tests/graph.test.ts` — add; unknown node rejected; depth-2 traverse; unknown start → not-found; mermaid/graphviz/empty output (REQ-007..009) — done: vitest green — ~90 ln

## Phase 6: Agent Registry + Bus (REQ-010..014)

- [x] 6.1 Create `src/domain/registry.ts` — register (unique name, created_at, required fields), assertAgent → identity error — done: registry tests — ~40 ln
- [x] 6.2 Create `src/domain/bus.ts` — send (reject unregistered recipient, state pendiente), poll (oldest pendiente → en-proceso, filtered by recipient identity), respond (verify recipient + state), status (REQ-010..013) — done: bus tests — ~120 ln
- [x] 6.3 Create `tests/registry.test.ts` — unique/duplicate/missing fields; unregistered bus use → identity error (REQ-014) — done: vitest green — ~50 ln
- [x] 6.4 Create `tests/bus.test.ts` — state machine, foreign poll → empty + state untouched, non-recipient respond fails, wrong-state fails, unknown id → not-found (REQ-010..013) — done: vitest green — ~110 ln

## Phase 7: Security + MCP Server (REQ-015)

- [x] 7.1 Create `src/auth.ts` — middleware: Origin allowlist → 403 (missing origin on non-GET → 403); Bearer timingSafeEqual → 401; every request (REQ-015) — done: 20 auth tests green (unit matrix + raw HTTP) — ~95 ln
- [x] 7.2 Create `src/server/tools.ts` — 14 zod schemas + McpServer registration; identity from X-Biblos-Agent header, never arguments (REQ-001..014) — done: 17 tools tests green; SDK 1.30.0 maps tool errors to isError results (2025-11-25) — ~430 ln
- [x] 7.3 Create `src/index.ts` — Node http + StreamableHTTPServerTransport on `/mcp` (stateless), auth first, 405 non-POST, 404 unknown; bind BIBLOS_HOST:PORT (REQ-015, REQ-017) — done: fresh transport+McpServer per request (SDK stateless pattern); smoke 401/403/200/405/404 on built dist — ~150 ln
- [x] 7.4 Create `tests/auth.test.ts` — raw HTTP: valid key+origin → 200, bad key → 401, disallowed/missing Origin → 403 (REQ-core-auth) — done: vitest green — ~150 ln
- [x] 7.5 Create `tests/tools.test.ts` — 14 tools via transport, temp DB, mocked router fetch; header enforcement (foreign poll empty, non-recipient respond fails); full JSON-RPC lifecycle over StreamableHTTPServerTransport — done: vitest green — ~380 ln

## Phase 8: E2E Verification

- [x] 8.1 Create `tests/e2e/bus-roundtrip.test.ts` — spawn dist/index.js temp env; two-agent send→poll→respond→status; restart persistence (REQ-010..013, REQ-017) — done: `npx vitest run tests/e2e/bus-roundtrip.test.ts` → 2 passed (roundtrip incl. registration-first rule + empty poll; restart keeps pendiente/completada states and bus usable) — ~230 ln
- [x] 8.2 Create `tests/e2e/search.test.ts` — hybrid returns semantic + keyword hits with fixed mock vectors (REQ-005) — done: `npx vitest run tests/e2e/search.test.ts` → 1 passed (mat→'both' doc1, mat↔into bucket-352 'semantic' doc2, unrelated dropped at minScore 0.1) — ~90 ln
- [x] 8.3 Run `npm run build && npx vitest run` — all 17+1 REQs green via MCP test client — done: build exits 0; `npx vitest run` → 15 files / 130 tests passed (127 prior + 3 new E2E) — 0 ln

## Phase 9: Deploy (VPS)

- [x] 9.1 Create `deploy/biblos.service` (User=biblos, ProtectSystem=strict, ReadWritePaths=/opt/biblos, PrivateTmp, NoNewPrivileges, CapabilityBoundingSet=, RestrictAddressFamilies=AF_INET AF_UNIX, EnvironmentFile=/etc/biblos/biblos.env, Restart=always) + `deploy/biblos.env.example` — done: unit renders ExecStart=/usr/bin/node /opt/biblos/dist/index.js with the full hardening set; env example VPS-shaped (DB_PATH=/opt/biblos/biblos.db, loopback bind, router URL) with empty key/origins + install comments — ~45 ln
- [x] 9.2 Create `deploy/apache-vhost.conf` — biblos.coltmandev.dev, ProxyPreserveHost On, ProxyPass / → http://127.0.0.1:8199/ — done: vhost with ProxyPass/ProxyPassReverse to loopback-only upstream + a2enmod/a2ensite/certbot install notes — ~25 ln
- [ ] 9.3 VPS: verify sqlite-vec prebuild for Node 22 ABI 115 linux-x64; fallback node-gyp (build-essential+python3); create /opt/biblos + biblos user; install + build dist — ~20 ln
- [ ] 9.4 VPS: `systemctl enable --now biblos`; loopback smoke `curl -H "Authorization: Bearer $KEY" 127.0.0.1:8199/mcp` → expected 401/200 — ~10 ln
- [ ] 9.5 DNS+TLS: Cloudflare A record → el IP público del servidor; `certbot --apache -d biblos.coltmandev.dev`; enable vhost + `apachectl reload` — ~10 ln
- [x] 9.6 Create `docs/clients.md` — OpenClaw (streamable-http) + OpenCode (remote, Bearer, oauth:false) integration steps (REQ-core-client-docs) — done: doc covers shared 3-header auth model (Authorization/Origin/X-Biblos-Agent), registration-first rule, OpenCode remote config, OpenClaw streamable-http + secret-store key, Claude Code CLI, curl smoke — ~110 ln
