# Biblos MCP — Roadmap de lo faltante

> Estado: 2026-08-16 (deploy VPS completado, publicación open-source)
> Proyecto: /mnt/1TB/IA/mcp/biblos · VPS: coltmandev.dev
> Repo público: https://github.com/juanvs23/biblos (MIT)

## Estado actual

SDD change `biblos-mcp-core` — modo hybrid (openspec + engram), interactivo, ask-on-risk, PRs encadenados (stacked-to-main), 4 WU + 1 open-source.

| Fase | Estado |
|---|---|
| Exploración | ✅ `openspec/changes/biblos-mcp-core/exploration.md` |
| Propuesta | ✅ `proposal.md` (5 capacidades, 17 REQ) |
| Specs | ✅ `openspec/specs/{memory-documents,knowledge-graph,agent-bus,agent-registry,mcp-server-core}/spec.md` |
| Diseño | ✅ `design.md` (D1–D7) |
| Tareas | ✅ `tasks.md` (36 tareas, 9 fases) |
| Apply WU1 (DB+embeddings+documents) | ✅ mergeado a master — 44 tests |
| Apply WU2 (graph+registry+bus) | ✅ mergeado a master — 90 tests |
| Apply WU3 (auth+tools+server) | ✅ mergeado a master — 127 tests |
| Apply WU4 (E2E + deploy repo) | ✅ mergeado a master — 130 tests |
| Apply WU5 (open-source readiness) | ✅ mergeado a master — LICENSE MIT, README, metadata saneada |
| Deploy VPS (9.3–9.5) | ✅ **EN PRODUCCIÓN** https://biblos.coltmandev.dev (systemd + Apache + certbot + Cloudflare) |
| Verify | ⏳ pendiente |
| Archive | ⏳ pendiente |

## Siguientes pasos (orden)

### 1. sdd-verify
- Validar implementación contra specs (REQ-001…017), reportar CRITICAL/WARNING/SUGGESTION.
- Correr la suite completa y el flujo real contra el router del VPS (sin mock) — el server ya está en producción.

### 2. sdd-archive
- Archivar el change en `openspec/changes/archive/` + Engram.

### 3. Post-archive (mejoras futuras, fuera de slice 1)
- Activar integración real de clientes (OpenClaw mcp.servers.biblos, OpenCode mcp.biblos) — requiere definir Origin de cada cliente en `BIBLOS_ALLOWED_ORIGINS`.
- Ecosistema open-source: CI GitHub Actions, badges, CONTRIBUTING, `.github/` templates.
- Ranking híbrido: calibrar peso con corpus real.
- Graph: auto-relaciones (v2 — requiere LLM en servidor, decisión pendiente).
- Reranker Qwen3 para búsquedas finas.
- Convertir el router llama.cpp a systemd (hoy corre con nohup).
- Arreglar el MCP github de opencode (wrapper con el token falla: "Authentication Failed").

## Riesgos abiertos
- **MongoDB 27017 expuesto** a internet (0.0.0.0) — de OTROS proyectos; no es nuestro para resolver, pero conviene que el usuario lo cierre.
- **Origin de clientes CLI**: OpenCode/OpenClaw sin header Origin → 403 por defecto; allowlist explícita al activar clientes (`BIBLOS_ALLOWED_ORIGINS=https://biblos.coltmandev.dev` hoy).
- **Cloudflare proxied**: el dominio está detrás del proxy (solo se ve IPv6 de Cloudflare); el A record debe apuntar al VPS para que el proxy reenvíe. Verificado funcionando (certbot OK vía challenge HTTP).
- **Router llama.cpp no es systemd**: si el VPS reinicia, el router 8085 no levanta solo → el server biblos arranca pero save/search fallan hasta levantarlo.
- **FIFO del bus no determinista** si dos envíos comparten el mismo ms (tie-break UUID aleatorio) — aceptable según diseño.

## Comandos útiles
```bash
# Verificar suite local
cd /mnt/1TB/IA/mcp/biblos && npx vitest run && npm run build
# Servicio en VPS
ssh coltmandev.dev "systemctl status biblos --no-pager | head -5"
# Smoke público
curl -s -o /dev/null -w "%{http_code}\n" https://biblos.coltmandev.dev/mcp
# Router VPS (ya corriendo)
ssh coltmandev.dev "curl -s http://127.0.0.1:8085/health"
```