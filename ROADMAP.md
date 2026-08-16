# Biblos MCP — Roadmap de lo faltante

> Estado: 2026-08-15 (cierre de sesión)
> Proyecto: /mnt/1TB/IA/mcp/biblos · VPS: coltmandev.dev (el IP público del servidor)

## Estado actual

SDD change `biblos-mcp-core` — modo hybrid (openspec + engram), interactivo, ask-on-risk, PRs encadenados local (stacked-to-main).

| Fase | Estado |
|---|---|
| Exploración | ✅ `openspec/changes/biblos-mcp-core/exploration.md` |
| Propuesta | ✅ `proposal.md` (5 capacidades, 17 REQ) |
| Specs | ✅ `openspec/specs/{memory-documents,knowledge-graph,agent-bus,agent-registry,mcp-server-core}/spec.md` |
| Diseño | ✅ `design.md` (D1–D7) |
| Tareas | ✅ `tasks.md` (37 tareas, 9 fases) |
| Apply WU1 (DB+embeddings+documents) | ✅ rama `wu1-*` mergeada a master — 44 tests |
| Apply WU2 (graph+registry+bus) | ✅ rama `wu2-*` mergeada a master — 90 tests |
| Apply WU3 (auth+tools+server) | ✅ rama `wu3-auth-tools-server` (5 commits, SIN mergear) — 127 tests |
| Verify | ⏳ pendiente |
| Archive | ⏳ pendiente |

## Siguientes pasos (orden)

### 1. Cerrar WU3 (5 min)
- Mergear `wu3-auth-tools-server` a `master` (stacked-to-main local):
  `git checkout master && git merge --no-ff wu3-auth-tools-server -m "merge(wu3): auth + tools + server"`

### 2. WU4 — E2E + Deploy (próxima sesión)
- Fase 8: E2E — bus roundtrip sobre `dist/index.js`, búsqueda híbrida por HTTP, suite REQ completa vía cliente MCP.
- Fase 9: Deploy en VPS:
  1. Copiar código a VPS (`/opt/biblos/`) — `rsync` o git clone.
  2. `npm ci && npm run build` en el VPS (Node 22 — **verificar ABI de better-sqlite3/sqlite-vec prebuilds**).
  3. Verificar `curl 127.0.0.1:8085/v1/embeddings` (shape OpenAI-compatible) — open question del diseño.
  4. Crear unit systemd `biblos.service` (Restart=always, 127.0.0.1:8199, env con BIBLOS_API_KEY, ROUTER_URL=127.0.0.1:8085, DB_PATH=/opt/biblos/biblos.db).
  5. Apache vhost `biblos.coltmandev.dev` (el A record en Cloudflare ya lo creó el usuario) + certbot.
  6. `docs/clients.md` — cómo conectar OpenClaw (streamable-http) y OpenCode (remote + oauth:false).

### 3. sdd-verify
- Validar implementación contra specs (REQ-001…017), reportar CRITICAL/WARNING/SUGGESTION.
- Correr la suite completa y el flujo real contra el router del VPS (sin mock).

### 4. sdd-archive
- Archivar el change en `openspec/changes/archive/` + Engram.

### 5. Post-archive (mejoras futuras, fuera de slice 1)
- Activar integración real de clientes (OpenClaw mcp.servers.biblos, OpenCode mcp.biblos).
- Ranking híbrido: calibrar peso con corpus real.
- Graph: auto-relaciones (v2 — requiere LLM en servidor, decisión pendiente).
- Reranker Qwen3 para búsquedas finas.
- Actualizar `sdd-init` para `strict_tdd: true` (ya hay vitest).

## Riesgos abiertos
- **sqlite-vec ABI en VPS (Node 22)**: prebuilds linux-x64 verificados en local (Node 24); re-verificar en VPS. Mitigación: node-gyp fallback / pin de versión.
- **Shape del endpoint `/v1/embeddings` del router**: implementado como OpenAI-compatible; confirmar con curl en deploy.
- **FIFO del bus no determinista** si dos envíos comparten el mismo ms (tie-break UUID aleatorio) — aceptable según diseño.
- **MongoDB 27017 expuesto** a internet (0.0.0.0) — de OTROS proyectos; no es nuestro para resolver, pero conviene que el usuario lo cierre.
- **Origin de clientes CLI**: OpenCode/OpenClaw sin header Origin → 403 por defecto; allowlist explícita al activar clientes.

## Comandos útiles
```bash
# Verificar suite local
cd /mnt/1TB/IA/mcp/biblos && npx vitest run && npm run build
# Router VPS (ya corriendo)
ssh coltmandev.dev "curl -s http://127.0.0.1:8085/health"
# Modelos del router
ssh coltmandev.dev "curl -s http://127.0.0.1:8085/v1/models"
```
