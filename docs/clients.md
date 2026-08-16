# Biblos — Client Integration Guide

How to connect MCP clients to the Biblos server (task 9.6, REQ-core-client-docs).
Covers **OpenClaw** (Streamable HTTP transport) and **OpenCode** (`type: remote`,
Bearer header, `oauth: false`), plus a short Claude Code note.

## 1. Prerequisites

- Biblos is deployed and reachable: `https://biblos.coltmandev.dev/mcp`
  (Apache vhost → systemd unit → `127.0.0.1:8199`). See `deploy/`.
- A `BIBLOS_API_KEY` is set in `/etc/biblos/biblos.env` (generate with
  `openssl rand -hex 32`). **Never commit a real key** — inject it via each
  client's secret mechanism.
- `BIBLOS_ALLOWED_ORIGINS` in `/etc/biblos/biblos.env` includes **exactly** the
  `Origin` header value each client sends (see §2).

## 2. Shared: the three headers every client must send

Every request to Biblos carries three things (REQ-core-auth, design D4):

| Header | Value | Purpose |
|--------|-------|---------|
| `Authorization` | `Bearer <BIBLOS_API_KEY>` | API-key auth (401 on mismatch) |
| `Origin` | one of the `BIBLOS_ALLOWED_ORIGINS` values | Origin validation (403 on missing/disallowed) |
| `X-Biblos-Agent` | the agent's registered name | Agent identity — never in tool arguments |

Because the server **403s requests without an allowed Origin** (MCP 2025-11-25),
CLI clients that would otherwise omit `Origin` must send one explicitly in their
headers map (both clients below support custom headers). Pick a stable value
(e.g. `https://biblos.coltmandev.dev`) and add it to `BIBLOS_ALLOWED_ORIGINS`.

### Registration-first rule (REQ-registry-register)

Bus tools (`request_send`, `request_poll`, `request_respond`) only accept
**registered** agents, and the caller identity is taken from `X-Biblos-Agent`,
never from arguments. Before the first bus use:

1. Choose an agent name (e.g. `openclaw`, `opencode`).
2. Send the same value in `X-Biblos-Agent` on every request.
3. Call `register_agent` once:
   ```json
   {
     "name": "opencode",
     "type": "cli",
     "capabilities": ["memory", "bus"]
   }
   ```
4. Only then may that identity send/poll/respond. A duplicate `register_agent`
   fails with `identity_error` (names are unique).

Memory/graph tools and `request_status` are read-only and need only the API key.

## 3. OpenCode (remote MCP server)

Edit `~/.config/opencode/opencode.json` (or the project `opencode.json`):

```jsonc
{
  "mcp": {
    "biblos": {
      "type": "remote",
      "url": "https://biblos.coltmandev.dev/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer <BIBLOS_API_KEY>",
        "Origin": "https://biblos.coltmandev.dev",
        "X-Biblos-Agent": "opencode"
      }
    }
  }
}
```

Notes:

- `oauth: false` — Biblos does not implement OAuth; the static Bearer key is
  used (REQ-core-auth).
- The `X-Biblos-Agent` header fixes the identity for **all** tools in this
  session. If you want two identities from one machine, add a second entry
  (e.g. `"biblos-worker"`) with a different agent name and header.
- Restart opencode (`opencode` or `Ctrl+R` in the TUI) so the new server is
  picked up, then run `opencode mcp` to confirm `biblos` is connected.

## 4. OpenClaw (streamable-http)

Edit `~/.openclaw/openclaw.json`:

```jsonc
{
  "mcp": {
    "servers": {
      "biblos": {
        "type": "streamable-http",
        "url": "https://biblos.coltmandev.dev/mcp",
        "headers": {
          "Origin": "https://biblos.coltmandev.dev",
          "X-Biblos-Agent": "openclaw"
        }
      }
    }
  }
}
```

The API key should NOT sit in the headers map. Put it in the OpenClaw secret
store and reference it (exact syntax depends on the OpenClaw version; the
`{{ secrets.NAME }}` reference form is supported in recent releases):

```jsonc
"headers": {
  "Authorization": "Bearer {{ secrets.BIBLOS_API_KEY }}",
  "Origin": "https://biblos.coltmandev.dev",
  "X-Biblos-Agent": "openclaw"
}
```

Notes:

- If your OpenClaw version cannot inject secrets into headers, create the entry
  with a placeholder and fill the key via the secret store, keeping the
  plaintext out of any committed config (CONTEXT.md: OpenClaw secrets are
  currently plaintext in `openclaw.json` — prefer the store).
- `type: "streamable-http"` matches the server's stateless Streamable HTTP
  endpoint (design D3 — no sessions, proxy-friendly).

## 5. Claude Code (documented)

Claude Code's MCP config (`claude mcp add`) supports remote servers with a
Bearer header and custom headers:

```bash
claude mcp add --transport http biblos https://biblos.coltmandev.dev/mcp \
  --header "Authorization: Bearer <BIBLOS_API_KEY>" \
  --header "Origin: https://biblos.coltmandev.dev" \
  --header "X-Biblos-Agent: claude-code"
```

Live activation is optional for v1 (REQ-core-client-docs "Deferred activation").

## 6. Smoke test after wiring

1. Register the identity (see §2) — either through the client UI or:
   ```bash
   curl -s https://biblos.coltmandev.dev/mcp \
     -H "Authorization: Bearer $BIBLOS_API_KEY" \
     -H "Origin: https://biblos.coltmandev.dev" \
     -H "X-Biblos-Agent: opencode" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register_agent","arguments":{"name":"opencode","type":"cli","capabilities":["memory","bus"]}}}'
   ```
2. Save a memory: `save_document {content, author}` → returns an `id`.
3. Roundtrip a bus request between two identities (send → poll → respond →
   status) to confirm identity enforcement works end to end.
