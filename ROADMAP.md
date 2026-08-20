# Biblos MCP — Roadmap de lo faltante

> Estado: 2026-08-20 (multi-agent-client-setup completado y archivado)
> Proyecto: /mnt/1TB/IA/mcp/biblos · VPS: coltmandev.dev
> Repo público: https://github.com/juanvs23/biblos (MIT)

## Estado actual

### Change: `biblos-mcp-core` (completado)
SDD change — modo hybrid (openspec + engram), interactivo, ask-on-risk, PRs encadenados (stacked-to-main), 4 WU + 1 open-source.

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
| Verify | ✅ completado (PASS, 130/130 tests, 18/18 REQ, 31/31 escenarios) |
| Archive | ✅ completado (archive/2026-08-17-biblos-mcp-core) |

### Change: `multi-agent-client-setup` (completado y archivado)
CLI autoejecutable para conectar OpenCode, OpenClaw, Claude Code a Biblos self-hosted.

| Fase | Estado |
|---|---|
| Proposal | ✅ `openspec/changes/multi-agent-client-setup/proposal.md` |
| Spec | ✅ `openspec/changes/multi-agent-client-setup/specs/multi-agent-setup/spec.md` (19 REQ, sync a `openspec/specs/multi-agent-setup/spec.md`) |
| Design | ✅ `design.md` (10 decisiones) |
| Tasks | ✅ `tasks.md` (20 tareas, 7 fases) |
| WU1 (Core+TUI) | ✅ T001-T007 completados — `tools/setup-biblos.sh`, `tools/lib/*.sh`, `tools/adapters/*.sh` |
| WU2 (Adapters+Smoke) | ✅ T008-T015 completados — smoke tests compartidos, wiring E2E, rollback |
| WU3 (Testing+Polish) | ✅ T016-T020 completados — `tools/tests/` (81/81 tests) |
| Verify | ✅ PASS — 81/81 tests, 19/19 REQ, 73/73 escenarios, 0 CRITICAL/WARNING (re-run abb48cee) |
| Archive | ✅ completado (archive/2026-08-20-multi-agent-client-setup) |
| Prueba local OpenClaw | 🔲 PENDIENTE (post-archive) — instalar OpenClaw en local, probar MCP, confirmar funcionamiento |

## Siguientes pasos (orden)

### 1. Prueba local con OpenClaw
- Instalar OpenClaw en local
- Configurar MCP de Biblos via `openclaw mcp add`
- Probar conexión y herramientas
- Confirmar que funciona correctamente

### 2. Prueba local con OpenCode
- Instalar/verificar MCP de Biblos en OpenCode
- Configurar `~/.config/opencode/opencode.json`
- Probar conexión y herramientas

### 3. Post-archive (mejoras futuras, fuera de slice 1)
- Activar integración real de clientes (OpenClaw mcp.servers.biblos, OpenCode mcp.biblos, Hermes Agent mcp_servers.biblos) — requiere definir Origin de cada cliente en `BIBLOS_ALLOWED_ORIGINS` y exponer por Apache `https://biblos.coltmandev.dev/mcp` (Streamable HTTP, ya implementado).
- Ecosistema open-source: CI GitHub Actions, badges, CONTRIBUTING, `.github/` templates.
- Ranking híbrido: calibrar peso con corpus real.
- Graph: auto-relaciones (v2 — requiere LLM en servidor, decisión pendiente).
- Reranker Qwen3 para búsquedas finas.
- Convertir el router llama.cpp a systemd (hoy corre con nohup).
- Arreglar el MCP github de opencode (wrapper con el token falla: "Authentication Failed").

### 4. Evaluación opcional de agentes alternativos (16 Ago 2026)
- **Conclusión**: NO migrar de OpenClaw. Opcional probar Hermes Agent en paralelo (vive en `~/.hermes/`, no toca `~/.openclaw/`) — Telegram o 2º número, `hermes claw migrate --dry-run` para vista previa. Pi descartado como asistente (es coding agent).
- Si se prueba Hermes: apuntarlo a Ollama (`localhost:11434/v1`) u Ollama Cloud (misma key, `gemma4:31b-cloud`); NO emparejar su bridge Baileys al mismo número de OpenClaw; NO dejar que haga swap en el router 8085 que usa Biblos para embeddings.

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