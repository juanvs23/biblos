# Design: multi-agent-client-setup

> **Change**: `multi-agent-client-setup`
> **Spec**: `openspec/changes/multi-agent-client-setup/specs/multi-agent-setup/spec.md`
> **Date**: 2026-08-18

---

## 1. Technical Approach

`setup-biblos.sh` is a single Bash entry point that:

1. Validates dependencies (jq, openssl, curl).
2. Prompts the user for server URL, agent name, and agent type via TUI (`read -p` with optional `dialog`/`whiptail`).
3. Generates a 64-hex-char API key (`openssl rand -hex 32`).
4. Backs up the existing config (if any) with a timestamped name.
5. Sources the adapter for the chosen agent type and delegates config write to it.
6. Runs a curl-based smoke test against the Biblos `/mcp` endpoint.
7. Calls `register_agent` on the server (best-effort, non-blocking).
8. On smoke test failure: restores the backup and exits 1.
9. On success: displays a summary and exits 0.

**Why Bash**: zero external dependencies beyond standard CLI tools (jq, openssl, curl). The tool is meant to be distributed as a single file + small adapter directory — no npm, no node, no python packages. Bash is the right level for config wrangling and shell-level orchestration.

**Adapter pattern**: each agent is isolated in its own file under `tools/adapters/`. The core script never touches agent-specific config formats. Adding a new agent = one new file + one entry in the registry array.

---

## 2. File Structure

```
tools/
├── setup-biblos.sh          # Entry point — TUI, core flow, adapter registry
├── lib/
│   ├── core.sh              # Shared functions: logging, keygen, curl helpers
│   ├── backup.sh            # Backup/restore with validation
│   └── tui.sh               # Prompt helpers (read -p / dialog / whiptail)
└── adapters/
    ├── opencode.sh          # OpenCode adapter
    ├── openclaw.sh          # OpenClaw adapter
    └── claude-code.sh       # Claude Code adapter
```

| File | Responsibility |
|---|---|
| `setup-biblos.sh` | Orchestrator: CLI parsing, dependency check, flow control, adapter dispatch, summary |
| `lib/core.sh` | `log_info`, `log_error`, `log_warn`, `generate_key`, `curl_json`, exit code handling |
| `lib/backup.sh` | `create_backup`, `restore_backup`, `validate_backup`, `cleanup_old_backups` |
| `lib/tui.sh` | `prompt_default`, `prompt_choice`, `prompt_confirm`, `display_key` |
| `adapters/opencode.sh` | `write_config`, `smoke_test`, `backup_config`, `restore_config` |
| `adapters/openclaw.sh` | `write_config`, `smoke_test`, `backup_config`, `restore_config` |
| `adapters/claude-code.sh` | `write_config`, `smoke_test`, `backup_config`, `restore_config` |

Each adapter exports the same four functions. The core script sources the correct adapter and calls `write_config` then `smoke_test`.

---

## 3. Adapter Interface

Every adapter in `tools/adapters/` MUST implement these four functions:

```bash
# Back up the current config file before any modification.
# Prints the backup path to stdout. Exits 0 on success, 1 on failure.
backup_config()

# Write the Biblos MCP configuration for this agent.
# Args: <server_url> <agent_name> <api_key>
# Exits 0 on success, 1 on failure.
write_config()

# Smoke-test the connection using this agent's config.
# Args: <server_url> <agent_name> <api_key>
# Exits 0 on success, 1 on failure.
smoke_test()

# Restore the config from the most recent backup.
# Exits 0 on success, 1 on failure.
restore_config()
```

Optional:

```bash
# Remove the backup file (for cleanup after 24h).
# Args: [backup_path]
# Exits 0 on success.
cleanup_backup()
```

**Core script does NOT contain any agent-specific logic.** It discovers the adapter file from the registry and sources it:

```bash
ADAPTERS=(
  "opencode:./adapters/opencode.sh"
  "openclaw:./adapters/openclaw.sh"
  "claude-code:./adapters/claude-code.sh"
)

# Lookup:
get_adapter_file() {
  for entry in "${ADAPTERS[@]}"; do
    local name="${entry%%:*}"
    local file="${entry#*:}"
    [[ "$1" == "$name" ]] && echo "$file" && return 0
  done
  return 1
}
```

---

## 4. Config Formats

### 4.1 OpenCode — `~/.config/opencode/opencode.json`

Written via `jq` to preserve existing entries:

```bash
jq --arg url "$URL" \
   --arg key "$API_KEY" \
   --arg name "$AGENT_NAME" \
   '.mcp.biblos = {
     type: "remote",
     url: $url,
     enabled: true,
     oauth: false,
     headers: {
       "Authorization": "Bearer " + $key,
       "Origin": $url,
       "X-Biblos-Agent": $name
     }
   }' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" \
  && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
```

**Idempotent**: `jq` overwrites `mcp.biblos` if it exists, creates it if not. Existing non-Biblos entries are preserved.

### 4.2 OpenClaw — `~/.openclaw/openclaw.json`

Written via `jq` + secret store:

```bash
# 1. Write JSON config (no inline key)
jq --arg url "$URL" \
   --arg name "$AGENT_NAME" \
   '.mcp.servers.biblos = {
     type: "streamable-http",
     url: $url,
     enabled: true,
     headers: {
       "Origin": $url,
       "X-Biblos-Agent": $name
     }
   }' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" \
  && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

# 2. Inject key into OpenClaw's secret store
openclaw secrets set BIBLOS_API_KEY "$API_KEY"
```

Headers reference the secret at runtime: `"Authorization": "Bearer {{ secrets.BIBLOS_API_KEY }}"` — injected by OpenClaw's own runtime, not by the script.

### 4.3 Claude Code — CLI-invoked

No config file modification. Claude Code manages its own state:

```bash
if ! command -v claude &>/dev/null; then
  log_info "Claude Code CLI not installed — skipping."
  return 0
fi

claude mcp add --transport http biblos "$URL" \
  --header "Authorization: Bearer $API_KEY" \
  --header "Origin: $URL" \
  --header "X-Biblos-Agent: $AGENT_NAME"
```

Idempotent: `claude mcp add` updates if the entry already exists.

---

## 5. Backup & Rollback

### Flow

```
┌─────────────────────┐
│  Config exists?      │──yes──▶ Create timestamped backup
└─────────────────────┘        backup_path = <config>.backup.<YYYYMMDD-HHMMSS>
                                  chmod 600 "$backup_path"
                                     │
                                     ▼
┌─────────────────────┐
│  write_config()      │──▶ Config applied
└─────────────────────┘
                                     │
                                     ▼
┌─────────────────────┐
│  smoke_test()        │──fail──▶ restore_config() → exit 1
│                      │──pass──▶ Continue
└─────────────────────┘
                                     │
                                     ▼
┌─────────────────────┐
│  register_agent()    │──best-effort, never blocks
└─────────────────────┘
```

### Backup naming

`<config_path>.backup.<YYYYMMDD-HHMMSS>`

Example: `~/.config/opencode/opencode.json.backup.20260818-143022`

### Validation before restore

1. Backup file exists.
2. Non-zero size.
3. For JSON configs: `jq empty "$backup_path"` exits 0.

### Rollback trigger

Any non-zero exit from `smoke_test()`:
- Network timeout (>30s)
- HTTP 401/403 (auth failure)
- Non-JSON response
- Any other non-200/202 status

### Cleanup

Backups are kept indefinitely by default. Optional cleanup after 24h via `cleanup_backup()`, gated by `--keep-backup` flag (default: clean up).

---

## 6. Smoke Test

### curl command

```bash
curl --silent --show-error --max-time 30 --write-out "%{http_code}" \
  -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Origin: $URL" \
  -H "X-Biblos-Agent: $AGENT_NAME" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'
```

### Success criteria

| Check | Pass | Fail |
|---|---|---|
| HTTP status | 200 or 202 | anything else |
| Response body | Valid JSON (`jq empty`) | non-JSON or parse error |
| Timeout | < 30s | exceeded |
| Auth | 200/202 | 401 or 403 |

### Implementation

```bash
smoke_test() {
  local url="$1" name="$2" key="$3"
  local status_code response

  status_code=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 30 -X POST "$url" \
    -H "Authorization: Bearer $key" \
    -H "Origin: $url" \
    -H "X-Biblos-Agent: $name" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"initialize","id":1}')

  if [[ "$status_code" != "200" && "$status_code" != "202" ]]; then
    log_error "Smoke test failed: HTTP $status_code"
    return 1
  fi

  # Validate JSON response
  response=$(curl -s --max-time 30 "$url" \
    -H "Authorization: Bearer $key" \
    -H "Origin: $url" \
    -H "X-Biblos-Agent: $name" \
    -d '{"jsonrpc":"2.0","method":"initialize","id":1}')

  if ! echo "$response" | jq empty 2>/dev/null; then
    log_error "Smoke test: response is not valid JSON"
    return 1
  fi

  return 0
}
```

---

## 7. Agent Registration

After `write_config()` succeeds and `smoke_test()` passes, call `register_agent` on the Biblos server.

### API call

```bash
register_agent() {
  local url="$1" name="$2" type="$3" key="$4"

  local status_code
  status_code=$(curl --silent --show-error --max-time 30 --write-out "%{http_code}" \
    -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $key" \
    -H "Origin: $url" \
    -H "X-Biblos-Agent: $name" \
    -d "$(jq -n --arg n "$name" --arg t "$type" \
       '{name:$n, type:$t, capabilities:["memory","graph","bus"]}')")

  if [[ "$status_code" == "201" || "$status_code" == "200" ]]; then
    log_info "Agent '$name' registered on server."
    return 0
  fi

  # Best-effort: log warning but do NOT fail the tool
  log_warn "Agent registration returned HTTP $status_code (best-effort, continuing)."
  return 0
}
```

### Payload

```json
{
  "name": "<agent_name>",
  "type": "<agent_type>",
  "capabilities": ["memory", "graph", "bus"]
}
```

### Behavior

- **Duplicate registration** (name already exists): treated as success (idempotent).
- **Server unreachable**: warning logged, tool continues.
- **Registration never blocks** tool completion — it is best-effort per REQ-008.

---

## 8. Error Handling

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (all adapters configured, smoke test passed) |
| 1 | Rollback triggered / critical error (smoke test failed, missing dependency, user canceled) |
| 2 | Config error (jq validation failed, invalid JSON after write) |
| 3 | Network error (smoke test timeout, DNS failure) |

### Logging

All output goes to **stderr** (never stdout) per NFR-003:

```bash
log_info()  { echo "[$(date '+%H:%M:%S')] ℹ  $*" >&2; }
log_error() { echo "[$(date '+%H:%M:%S')] ❌ $*" >&2; }
log_warn()  { echo "[$(date '+%H:%M:%S')] ⚠  $*" >&2; }
```

### Trap handler

```bash
cleanup() {
  # Remove any temp files
  [[ -f "${TMPFILE:-}" ]] && rm -f "$TMPFILE"
}
trap cleanup EXIT
```

### User-facing messages

Messages are in English. Per REQ-016, success uses ✅ and failure uses ❌:

```
✅ OpenCode adapter: config written, smoke test passed.
❌ OpenClaw adapter: smoke test failed, restored backup.
```

---

## 9. Extensibility

Adding a new agent requires two changes:

1. **Create** `tools/adapters/<agent>.sh` implementing the four adapter functions.
2. **Register** it in the array in `setup-biblos.sh`:

```bash
ADAPTERS=(
  "opencode:./adapters/opencode.sh"
  "openclaw:./adapters/openclaw.sh"
  "claude-code:./adapters/claude-code.sh"
  "cursor:./adapters/cursor.sh"        # example new agent
)
```

That's it. The core script never needs to change. The adapter interface is the contract — as long as `backup_config`, `write_config`, `smoke_test`, and `restore_config` exist with the documented signatures, the agent is supported.

---

## 10. Testing Approach

### Unit (per adapter)

Each adapter is a standalone Bash file that can be sourced and tested independently:

```bash
# Test write_config produces valid JSON
source ./tools/adapters/opencode.sh
write_config "http://localhost:8199/mcp" "test-agent" "abc123"
jq . ~/.config/opencode/opencode.json   # should be valid

# Test smoke_test with mock server
python3 -m http.server 18765 &          # mock server
smoke_test "http://127.0.0.1:18765/mcp" "test-agent" "abc123"
# expects exit 0 or 1 depending on mock response
kill %1
```

### Integration

| Scenario | Method |
|---|---|
| Full happy path | Run `setup-biblos.sh` against local Biblos server (127.0.0.1:8199) |
| Smoke test failure | Mock server returns 401 → verify rollback occurred |
| Missing dependency | Remove `jq` from PATH → verify error message and exit 1 |
| Idempotency | Run twice → single Biblos entry, no JSON array growth |
| Backup integrity | Corrupt backup file → `--restore` should report error |
| Claude Code not installed | Unset `claude` from PATH → verify graceful skip |

### Smoke test with `jq` validation

```bash
# Validate smoke test response is parseable JSON
result=$(curl -s --max-time 30 "$URL" -H "Authorization: Bearer $KEY" -d '{"jsonrpc":"2.0","method":"initialize","id":1}')
echo "$result" | jq empty && echo "VALID" || echo "INVALID"
```

### Edge cases to verify

1. **Empty config file** — adapter creates file with correct structure.
2. **Pre-existing non-Biblos entries** — preserved after write.
3. **Concurrent runs** — two instances backing up the same file get distinct timestamps (use `date +%s` as tiebreaker within the same second).
4. **Network flap mid-smoke-test** — timeout triggers rollback.
5. **Key with special chars** — `openssl rand -hex` only produces hex, so no escaping issues.

---

## Appendix: Flow Diagram

```
┌────────────────────────────────────────────────────────────┐
│                    setup-biblos.sh                         │
│                                                            │
│  1. Check deps (jq, openssl, curl)                         │
│  2. Parse flags (--help, --restore)                        │
│  3. Prompt: server URL (default: https://biblos.coltmandev.dev/mcp) │
│  4. Prompt: agent name (regex validation)                  │
│  5. Prompt: agent type (1=OpenCode, 2=OpenClaw, 3=Claude) │
│  6. Generate API key (openssl rand -hex 32)                │
│  7. Display key (ONE TIME, to stderr)                      │
│  8. Confirm: "Apply configuration?" [y/N]                  │
│     └─ No → exit 1                                         │
│  9. backup_config()                                        │
│ 10. Source adapter, call write_config()                    │
│ 11. smoke_test()                                           │
│     ├─ Pass → continue                                     │
│     └─ Fail → restore_config(), exit 1                     │
│ 12. register_agent() (best-effort)                         │
│ 13. Display summary                                        │
│ 14. exit 0                                                 │
└────────────────────────────────────────────────────────────┘
```
