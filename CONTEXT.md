# Biblos — Contexto del proyecto

> Última actualización: 2026-08-20 (cierre de sesión)

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

- El VPS del autor (acceso por SSH con la clave del usuario), Ubuntu 24.04, 6 vCPU, 11 GB RAM, 242 GB SSD, Docker.
- **OpenClaw**: gateway 127.0.0.1:18789 (systemd, NO tocar gateway.auth).
- **llama.cpp router**: 127.0.0.1:8085 (nohup; PENDIENTE: convertir a systemd) — modelos qwen35-4b (chat) y nomic-embed-text-v1.5.Q8_0 (embeddings). Log: /tmp/llama-router.log. Preset: /opt/models/router/presets.ini.
- **MongoDB**: contenedor mongo-prod, 0.0.0.0:27017 — usado por otros proyectos, NO tocar.
- **Apache + Let's Encrypt**: subdominios activos; `biblos.coltmandev.dev` A record creado por el usuario (pendiente certbot + vhost).
- Contexto servidor: documentado en el VPS (incluye credenciales — no duplicar en código).

## Seguridad / secretos

- API keys: `BIBLOS_API_KEY` → `.env` (600) del VPS, nunca en código ni en memoria documentada.
- Secretos de OpenClaw se gestionan en su store de secretos / variables de entorno (la config de OpenClaw NO se toca).
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

## Estado infraestructura VPS (verificado 16 Ago 2026)

| Servicio | Estado |
|---|---|
| **biblos** (systemd, 127.0.0.1:8199) | ✅ active |
| **openclaw** (systemd, 18789) | ✅ active, HTTPS 200 |
| **llama.cpp router** (8085 + nomic-embed 36423 + qwen35-4b 45769) | ✅ corriendo (nohup) |
| **Ollama daemon** (127.0.0.1:11434) | ✅ systemd enabled+active (desde 16 Ago) — sirve modelos cloud de Ollama |
| **MongoDB** (27017, docker) | ✅ activo — OTROS proyectos, NO tocar |

## Conflicto OpenClaw ↔ biblos (resuelto 16 Ago 2026)

- El vhost 443 de `openclaw.coltmandev.dev` no tenía directivas SSL → Apache servía el cert de biblos → Cloudflare **526**.
- Corregido: `SSLEngine on` + certs propios de `/etc/letsencrypt/live/openclaw.coltmandev.dev/` (expira Sep 19). Backup: `openclaw.conf.bak-20260816212631`.
- ⚠️ REGLA: al tocar Apache, hacerlo quirúrgicamente por vhost — OpenClaw y Ollama son LEGACY aislados, NO tocar config/servicios/modelos; el router llama.cpp (8085) pertenece a OTRO proyecto.

## Investigación de alternativas a OpenClaw (16 Ago 2026)

- **Conclusión**: OpenClaw sigue siendo el único gateway personal con WhatsApp multi-cuenta + modelos locales + MCP + self-host. No migrar.
- **Hermes Agent** (`NousResearch/hermes-agent`, MIT, Python, 231K★): competidor directo con migración oficial `hermes claw migrate` (dry-run, importa SOUL/memoria/skills/proveedores). 25+ canales (WhatsApp Baileys + Cloud API), MCP cliente Y servidor (`hermes mcp serve` — **stdio-only hoy**), memoria FTS5+Honcho, exige modelos ≥64K ctx. Vive en `~/.hermes/`, no toca `~/.openclaw/`. Puede probarse en paralelo (Telegram o 2º número; dos bridges Baileys en el mismo número NO conviven).
- **Pi** (`earendil-works/pi`, MIT, TS, 91K★, Mario Zechner): agente de **codificación** CLI (estilo Claude Code), NO asistente personal. Sin canales de mensajería, **anti-MCP** explícito, sin sandbox propio. Solo tendría sentido como coding agent en workstation.
- **Modelos Hermes (Nous)**: 4.3-36B / 4-14B dense — ninguno corre con calidad en VPS 11GB sin GPU (14B Q4 ~8.5GB, CPU 1-3 tok/s). Sin MoE pequeño. No está en librería Ollama (importar GGUF manual). El único MoE fue Hermes-2-Mixtral 2024 (27GB).
- **Modelos locales del stack**: `gemma4:31b-cloud` (Ollama Cloud) es el modelo recomendado por la guía local de Hermes para tool-calling fiable — valida el stack actual.
- **Interconexión entre computadoras**: SÍ — vía MCP Streamable HTTP (estándar). Biblos ya lo implementa (`StreamableHTTPServerTransport`, `src/index.ts`). Hermes cliente habla HTTP remoto nativo (`url`+headers, OAuth 2.1, mTLS). Config de ejemplo: `url: https://biblos.coltmandev.dev/mcp` + `Authorization: Bearer <BIBLOS_API_KEY>`.

## Estado OpenClaw local (workstation, 20 Ago 2026)

- Se instaló OpenClaw local (npm global, v2026.7.1-2) para la prueba del MCP de Biblos, se configuró `mcp.servers.biblos` y se verificó (14 tools, smoke PASS, agente `openclaw-local` registrado).
- Por decisión del usuario, OpenClaw local se **desinstaló** (20 Ago): `npm uninstall -g openclaw` + servicio user systemd `openclaw-gateway.service` deshabilitado.
- `~/.openclaw/` se **conservó** (config, estado, `BIBLOS_API_KEY` en `~/.openclaw/.env`), por si se reinstala.
- ⚠️ El **OpenClaw del VPS** (`openclaw.coltmandev.dev`, gateway 18789) es distinto y sigue **activo e intacto** — NO se toca.

## Skills y convenciones

- SDD: `/home/juanvs23/.config/opencode/skills/{sdd-apply,sdd-verify,sdd-archive,sdd-tasks}/SKILL.md`
- Chained PR local: `/home/juanvs23/.config/opencode/skills/chained-pr/SKILL.md`
- Work unit commits: `/home/juanvs23/.config/opencode/skills/work-unit-commits/SKILL.md`
- Registro local: `.atl/skill-registry.md`
