# Biblos — Contexto del proyecto

> Última actualización: 2026-08-15 (cierre de sesión)

## Qué es Biblos

Servidor **MCP multiagente** que corre en un VPS y sirve de **enlace entre agentes** (OpenClaw, OpenCode, Claude Code). No es un cerebro central: cada agente conserva su propio LLM y memoria local; Biblos es la **biblioteca común documentada** + **bus de interconexión**.

Dos capacidades (slice 1, ambas):
1. **Memoria documentada vectorizada**: guardar/leer/editar/borrar información de procesos y detalles. Cada recuerdo = documento **Markdown** + metadatos estructurados. Búsqueda híbrida (semántica + keyword).
2. **Bus inter-agentes**: enviar/recibir peticiones entre agentes con cola persistente y verificación de identidad.

## Arquitectura

```
Agentes (OpenClaw=Gemma, OpenCode, Claude Code)
   │  MCP Streamable HTTP + API key Bearer + header X-Biblos-Agent
   ▼
Servidor MCP TS (127.0.0.1:8199, @modelcontextprotocol/sdk@1.30.0)
   ├─ 14 tools (memoria, grafo, bus, registro)
   ├─ Dominio: documents, graph, registry, bus
   └─ SQLite /opt/biblos/biblos.db (better-sqlite3 + sqlite-vec 768d + FTS5)
        └─ embeddings → llama.cpp router 127.0.0.1:8085 (nomic-embed-text-v1.5.Q8_0)
```

- **Persistencia**: SQLite embebido (DECISIÓN: Mongo descartado, en uso por otros proyectos).
- **Embeddings**: nomic-embed-text-v1.5 (768d) vía llama.cpp router mode — validado en POC (similitud correcta: mismo tema 0.84, distinto 0.55).
- **Orquestador chat**: qwen35-4b en el mismo router (no usado por el servidor en v1).
- **Identidad**: header `X-Biblos-Agent`; registro de agentes explícito y obligatorio; poll/respond verifican destinatario.
- **Seguridad**: Bearer + Origin → 403 (spec MCP 2025-11-25).

## Decisiones clave del usuario (NO revertir)

| Decisión | Valor |
|---|---|
| OpenClaw | NO tocar su config — Gemma 31B + soul/memory, le encanta la interacción |
| llama.cpp local | Descartado como cerebro de OpenClaw; sí es base de Biblos (router 8085) |
| Persistencia | SQLite, NO MongoDB |
| Formato memoria | Markdown legible + metadatos en columnas |
| Slice 1 | Memoria + bus juntos (todo) |
| Entrega | 4 PRs encadenados, stacked-to-main, LOCAL (sin GitHub) |
| Bus | Verificación de identidad del destinatario |
| Búsqueda | Híbrida configurable, default 50/50 |
| Registro | Explícito obligatorio |
| graph_render | Mermaid por defecto |

## Infraestructura VPS (coltmandev.dev)

- `root@62.171.164.5` (clave `~/.ssh/coltmnan`), Ubuntu 24.04, 6 vCPU, 11 GB RAM, 242 GB SSD, Docker.
- **OpenClaw**: gateway 127.0.0.1:18789 (systemd, NO tocar gateway.auth).
- **llama.cpp router**: 127.0.0.1:8085 (nohup; PENDIENTE: convertir a systemd) — modelos qwen35-4b (chat) y nomic-embed-text-v1.5.Q8_0 (embeddings). Log: /tmp/llama-router.log. Preset: /opt/models/router/presets.ini.
- **MongoDB**: contenedor mongo-prod, 0.0.0.0:27017 — usado por otros proyectos, NO tocar.
- **Apache + Let's Encrypt**: subdominios activos; `biblos.coltmandev.dev` A record creado por el usuario (pendiente certbot + vhost).
- Contexto servidor: `/root/context.md` en el VPS (incluye credenciales — no duplicar en código).

## Seguridad / secretos

- API keys: `BIBLOS_API_KEY` → `.env` (600) del VPS, nunca en código ni en memoria documentada.
- Secretos de OpenClaw están en texto plano en `openclaw.json` — pendiente mover a env (cuando se toque esa config; hoy NO se toca).
- No exponer el puerto 8199 al exterior (loopback + Apache proxy).

## Cómo retomar la sesión

```bash
# 1. Recuperar contexto SDD
# mem_search: "sdd/biblos-mcp-core" (Engram)

# 2. Estado del repo
cd /mnt/1TB/IA/mcp/biblos && git branch -a && git status

# 3. Próximo paso (ver ROADMAP.md)
# Mergear WU3 → WU4 (E2E + deploy VPS) → sdd-verify → sdd-archive
```

## Skills y convenciones

- SDD: `/home/juanvs23/.config/opencode/skills/{sdd-apply,sdd-verify,sdd-archive,sdd-tasks}/SKILL.md`
- Chained PR local: `/home/juanvs23/.config/opencode/skills/chained-pr/SKILL.md`
- Work unit commits: `/home/juanvs23/.config/opencode/skills/work-unit-commits/SKILL.md`
- Registro local: `.atl/skill-registry.md`
