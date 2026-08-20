# Proposal: Multi-Agent Client Setup

## Intent

A terminal-UI CLI tool that automates connecting MCP clients (OpenCode, OpenClaw, Claude Code) to a self-hosted Biblos server — generating correct configs per client format, provisioning an API key via each client's secret mechanism, registering the agent identity, and running a smoke test. Zero external dependencies in v1.

## Scope

### In Scope
- Interactive TUI (prompts for URL, agent name, confirmation)
- v1 client adapters: OpenCode, OpenClaw, Claude Code
- API key generation (`openssl rand -hex 32`)
- Config generation per client format (JSON edits for OpenCode/OpenClaw, `claude mcp add` for Claude Code)
- Secret injection (OpenCode: inline header; OpenClaw: secret store reference; Claude Code: `--header` flag)
- Agent registration via `register_agent` MCP call
- Smoke test (curl-based connection + registration verification)
- Extensible adapter interface for future agents (Hermes Agent, etc.)

### Out of Scope
- Server-side changes (server config, auth model, Origin allowlist)
- GUI (terminal-only)
- Non-Linux platforms
- Multiple agents per machine (one at a time)
- Client uninstallation/teardown
- Other agents beyond v1 (Hermes Agent = adapter only)

## Context / Background

Biblos server is deployed and reachable at `https://biblos.coltmandev.dev/mcp`. Three headers required per request: `Authorization: Bearer <KEY>`, `Origin: https://biblos.coltmandev.dev`, `X-Biblos-Agent: <name>`. Client config formats documented in `docs/clients.md`. Each client stores secrets differently — OpenCode allows inline Bearer in headers, OpenClaw uses a secret store, Claude Code passes via `--header` flags. The `register_agent` tool requires the agent to be registered before bus tools are usable.

## Capabilities

### New Capabilities
- `client-setup`: TUI wizard + per-agent adapters + smoke testing

### Modified Capabilities
None (tool is standalone; does not modify Biblos server)

## Approach

Single bash script (`setup-biblos.sh`) with a lightweight TUI using `read` prompts and `dialog`/`whiptail` fallback. Adapter registry pattern: each agent gets a small adapter module (bash function) that handles its specific config format and secret injection. Main flow: URL prompt → name prompt → key generation → per-adapter config write → `register_agent` call → smoke test → summary.

Adapter interface (per agent):
```
write_config(url, agent_name, api_key) → exits 0/1
smoke_test(url, agent_name, api_key) → exits 0/1
backup_config()    → exits 0/1, prints backup path on success
restore_config()   → exits 0/1
cleanup_backup()   → exits 0/1 (optional, after 24h)
```

### Backup & Rollback Strategy

**Before any modification:**
1. Detect if config file exists
2. Create timestamped backup: `config.json.backup.<timestamp>`
3. Store original file permissions and ownership

**After smoke test:**
- ✅ **Success**: Keep changes, optionally keep backup for 24h
- ❌ **Failure**: Automatically restore from backup, exit with error code

**Backup naming pattern:**
```
~/.config/opencode/opencode.json.backup.20260818-143022
~/.openclaw/openclaw.json.backup.20260818-143022
```

**Rollback trigger:**
- Any non-zero exit code from smoke test
- Network timeout (>30s)
- Authentication failure (401/403)
- Invalid response format

**Manual restore:**
```bash
setup-biblos.sh --restore <config-file> <backup-file>
```

**Smoke test flow (with backup):**
```bash
# 1. Backup
BACKUP_PATH=$(backup_config "$CONFIG_FILE")

# 2. Apply changes
apply_config "$URL" "$NAME" "$KEY"

# 3. Smoke test
if smoke_test "$URL" "$NAME" "$KEY"; then
  echo "✅ Connected successfully"
  # Optional: cleanup_backup "$BACKUP_PATH"
else
  echo "❌ Connection failed, rolling back..."
  restore_config "$BACKUP_PATH"
  exit 1
fi
```

**Idempotency notes for backups:**
- Backup files must have restrictive permissions (600)
- Backup files should be excluded from git (if in repo)
- Backups are cleaned up after successful setup (optional, configurable via `--keep-backup`)

Config format specifics (from `docs/clients.md`):
- **OpenCode**: JSON edit `~/.config/opencode/opencode.json` — add `mcp.biblos` with `type: "remote"`, inline `Authorization` header
- **OpenClaw**: JSON edit `~/.openclaw/openclaw.json` — add `mcp.servers.biblos` with `type: "streamable-http"`, `Authorization` via secret reference
- **Claude Code**: Shell — `claude mcp add --transport http biblos <url> --header "Authorization: Bearer <key>" --header "Origin: ..." --header "X-Biblos-Agent: <name>"`

## Initial Requirements (REQ)

| ID | Requirement |
|----|-------------|
| REQ-001 | Tool prompts for server URL (default: `https://biblos.coltmandev.dev/mcp`) |
| REQ-002 | Tool prompts for agent name (user-provided, validated non-empty) |
| REQ-003 | Generates API key via `openssl rand -hex 32` |
| REQ-004 | OpenCode adapter: edits `opencode.json` adding `mcp.biblos` with correct format |
| REQ-005 | OpenClaw adapter: edits `openclaw.json` adding `mcp.servers.biblos` with correct format |
| REQ-006 | Claude Code adapter: runs `claude mcp add` with correct flags |
| REQ-007 | Each adapter injects key via client's native secret mechanism (not plaintext in committed files) |
| REQ-008 | Calls `register_agent` via MCP after config write |
| REQ-009 | Smoke test: curl-based connection + registration verification |
| REQ-010 | Tool is idempotent — safe to re-run without corruption |
| REQ-011 | Adapter interface is extensible (new agents = new adapter module, no core changes) |
| REQ-012 | Zero external dependencies — only bash + openssl + curl + jq |
| REQ-013 | Never writes API key to committed files or logs |

## Affected Areas

| Area | Impact |
|------|--------|
| `/mnt/1TB/IA/mcp/biblos/tools/setup-biblos.sh` | New — main entry point |
| `/mnt/1TB/IA/mcp/biblos/tools/adapters/` | New — per-agent adapter modules |
| `docs/clients.md` | Modified — add setup tool reference |
| `.gitignore` | Modified — ensure no key leakage |

## Risks

| Risk | L | Mitigation |
|------|---|---|
| Client config JSON malformed by edit | Med | Use `jq` for all JSON edits (atomic, safe) |
| OpenClaw secret store API varies by version | Med | Adapter reads doc; if secret ref fails, fall back to inline with warning |
| `claude` CLI not installed | Low | Adapter detects absence, skips with clear message |
| Server unreachable during setup | Med | Smoke test fails clearly; user can re-run |
| User runs as non-owner of config dir | Low | Validate write permissions before editing |
| Re-run overwrites existing Biblos config | Med | Adapter checks for existing entry; warns before overwriting |
| Backup corruption: backup itself is corrupted, restore fails | Med | Validate backup integrity before restore (file exists, non-zero size, valid JSON via `jq`) |
| Disk space exhaustion during backup | Low | Document pattern; config files are tiny (<1 MB), unlikely to be an issue |

## Rollback Plan

Tool does not modify the server. Each adapter can be reverted by removing the added config block:
- OpenCode: remove `mcp.biblos` from `opencode.json`
- OpenClaw: remove `mcp.servers.biblos` from `openclaw.json`
- Claude Code: `claude mcp remove biblos`
- Agent registration: `register_agent` is idempotent (duplicate fails with `identity_error`, not destructive)

## Dependencies

- Bash 4+, `openssl`, `curl`, `jq` (all present on Ubuntu 24.04)
- Target client installed and reachable (OpenCode/OpenClaw/Claude Code)
- Biblos server reachable at provided URL
- `register_agent` tool available on server

## Success Criteria

- [ ] All three v1 adapters write correct config (verified by client startup)
- [ ] Smoke test passes for each configured client
- [ ] `register_agent` succeeds and agent appears in registry
- [ ] Tool is idempotent (re-run produces same result, exits 0)
- [ ] No API key appears in git history or logs
- [ ] New adapter can be added without modifying core logic
