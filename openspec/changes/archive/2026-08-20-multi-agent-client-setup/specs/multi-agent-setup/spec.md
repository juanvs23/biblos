# Multi-Agent Client Setup Specification

## Purpose

A terminal-UI CLI tool (`setup-biblos.sh`) that automates connecting MCP clients (OpenCode, OpenClaw, Claude Code) to a self-hosted Biblos MCP server — generating correct configs per client format, provisioning an API key via each client's native secret mechanism, registering the agent identity on the server, and running a smoke test. Zero external dependencies beyond bash, jq, openssl, and curl.

## Architecture

```
setup-biblos.sh (entry point)
  ├─ TUI layer: prompts via `read -p` / `dialog`
  ├─ Core: keygen, smoke test, backup/rollback, register_agent call
  └─ Adapter registry
       ├─ adapters/opencode.sh
       ├─ adapters/openclaw.sh
       └─ adapters/claude-code.sh
```

Each adapter exposes four functions: `write_config`, `smoke_test`, `backup_config`, `restore_config`. Adding a new agent = adding one new file under `adapters/`.

## Requirements

### REQ-001: Prompt for Server URL

The tool MUST prompt the user for the Biblos server URL with a sensible default.

**Acceptance Criteria:**
- Prompt displays default value `https://biblos.coltmandev.dev/mcp` in brackets
- User can accept default by pressing Enter
- User can type a custom URL (must be a valid HTTP/HTTPS URL)
- Invalid URLs are rejected with a clear error message and re-prompt

**Test Approach:**
- Run tool, accept default → URL is `https://biblos.coltmandev.dev/mcp`
- Run tool, enter `http://127.0.0.1:8199/mcp` → URL is used as-is
- Run tool, enter `not-a-url` → error message, re-prompt

---

### REQ-002: Prompt for Agent Name with Validation

The tool MUST prompt the user for an agent name and enforce format constraints.

**Acceptance Criteria:**
- Prompt for agent name with no default (user must provide)
- Validation: alphanumeric characters and hyphens only (`^[a-zA-Z0-9-]+$`)
- Length: 3–32 characters
- Empty input is rejected with a clear error message and re-prompt
- Invalid characters are rejected with a clear error message and re-prompt

**Test Approach:**
- Enter `my-agent-01` → accepted
- Enter `ab` (too short) → rejected, re-prompt
- Enter `this-name-is-way-too-long-for-a-valid-agent-name` (too long) → rejected, re-prompt
- Enter `agent name with spaces` → rejected, re-prompt
- Enter `agent_name_with_underscores` → rejected, re-prompt

---

### REQ-003: Agent Type Selection

The tool MUST present a numbered list of supported agent types for the user to select.

**Acceptance Criteria:**
- Display numbered list: 1=OpenCode, 2=OpenClaw, 3=Claude Code, 4=Exit
- User selects by entering the number
- Valid input range: 1–4
- Invalid input is rejected with a clear error message and re-prompt
- Selection 4 exits the tool gracefully
- Selection drives which adapter module is invoked

**Test Approach:**
- Enter 1 → OpenCode adapter invoked
- Enter 2 → OpenClaw adapter invoked
- Enter 3 → Claude Code adapter invoked
- Enter 4 → tool exits with code 0
- Enter 0 or 5 → rejected, re-prompt
- Enter `abc` → rejected, re-prompt

---

### REQ-004: Use the Shared Server API Key

The tool MUST prompt for the Biblos server's shared API key (`BIBLOS_API_KEY`) and inject it into the client config. The server authenticates every client with ONE shared key, so the tool does NOT generate a per-agent key.

**Acceptance Criteria:**
- Prompts for the server API key with a no-echo prompt (`prompt_secret`, `read -rsp`)
- Rejects an empty key with a clear error and exit
- Key is injected into the client config's `Authorization` header (and native secret mechanism where applicable)
- Key is never written to logs, stdout, or backups
- The tool does NOT display the key back to the user (no-echo input, no re-display)

**Test Approach:**
- Run tool → key is not echoed during input and not re-displayed
- Verify key appears nowhere in stderr/stdout/backup files, and once in the client config header
- Empty key → clear error, exit code 1

---

### REQ-005: OpenCode Adapter — Config Write

The OpenCode adapter MUST write a Biblos MCP entry into `~/.config/opencode/opencode.json` using `jq` for safe JSON manipulation.

**Acceptance Criteria:**
- Target file: `~/.config/opencode/opencode.json`
- Creates file if it does not exist (with default empty JSON `{}`)
- Adds/updates `mcp.biblos` block with:
  ```json
  {
    "type": "remote",
    "url": "<server_url>",
    "enabled": true,
    "oauth": false,
    "headers": {
      "Authorization": "Bearer <api_key>",
      "Origin": "<origin>",
      "X-Biblos-Agent": "<agent_name>"
    }
  }
  ```
- Uses `jq` for all JSON edits (atomic, no string concatenation)
- Preserves existing config entries not related to Biblos
- Outputs the final JSON to stderr for verification (stdout carries only the non-secret structured result, per NFR-003)

**Test Approach:**
- Pre-populate `opencode.json` with existing mcp entries → Biblos entry added alongside, existing entries preserved
- Empty/non-existent file → file created with correct structure
- Run `jq .` on output → valid JSON
- Run with `jq` removed from PATH → clear error, exit code 1

---

### REQ-006: OpenClaw Adapter — Config Write

The OpenClaw adapter MUST write a Biblos MCP entry into `~/.openclaw/openclaw.json` using `jq` for safe JSON manipulation.

**Acceptance Criteria:**
- Target file: `~/.openclaw/openclaw.json`
- Creates file if it does not exist (with default empty JSON `{}`)
- Adds/updates `mcp.servers.biblos` block with:
  ```json
  {
    "type": "streamable-http",
    "url": "<server_url>",
    "enabled": true,
    "headers": {
      "Origin": "<origin>",
      "X-Biblos-Agent": "<agent_name>"
    }
  }
  ```
- Authorization via secret store reference (not inline plaintext)
- Uses `jq` for all JSON edits (atomic, no string concatenation)
- Preserves existing config entries not related to Biblos
- Invokes `openclaw secrets set BIBLOS_API_KEY <key>` to inject the secret

**Test Approach:**
- Pre-populate `openclaw.json` with existing mcp.servers entries → Biblos entry added alongside
- Empty/non-existent file → file created with correct structure
- Run `jq .` on output → valid JSON
- Verify `openclaw secrets list` (or equivalent) shows BIBLOS_API_KEY

---

### REQ-007: Claude Code Adapter — Config Write

The Claude Code adapter MUST invoke `claude mcp add` with the correct flags to register the Biblos server.

**Acceptance Criteria:**
- Detects if `claude` CLI is installed (`command -v claude`)
- If not installed: prints informative message and exits gracefully with code 0 (not an error)
- If installed: runs:
  ```
  claude mcp add --transport http biblos "<url>" \
    --header "Authorization: Bearer <key>" \
    --header "Origin: <origin>" \
    --header "X-Biblos-Agent: <agent_name>"
  ```
- Validates `claude mcp list` shows biblos after add (optional verification)
- Does not modify any config files directly (CLI manages state)

**Test Approach:**
- `claude` not installed → informative message, exit 0
- `claude` installed → runs command, verifies with `claude mcp list`
- Re-run with same parameters → idempotent (update or no-op)

---

### REQ-008: Agent Registration on Server

The tool MUST register the agent identity on the Biblos server after config is written. Biblos is an MCP server, so registration invokes the MCP tool `register_agent` via a JSON-RPC `tools/call`, not a plain REST POST.

**Acceptance Criteria:**
- After a successful config write and smoke test, invokes the MCP tool `register_agent` via JSON-RPC `tools/call` on the server's MCP endpoint
- JSON-RPC payload:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "register_agent",
      "arguments": {
        "name": "<agent_name>",
        "type": "<agent_type>",
        "capabilities": ["memory", "graph", "bus"]
      }
    }
  }
  ```
- Sends the required MCP headers: `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Authorization: Bearer <key>`, `Origin: <scheme://host>`, `X-Biblos-Agent: <name>`
- Verifies registration succeeded (HTTP 200/202 and no JSON-RPC `error` in the response body)
- If registration fails: logs a warning but does NOT block tool completion (registration is best-effort; the agent can register later)
- Duplicate registration (name already exists) is treated as success (idempotent)

**Test Approach:**
- Run tool with valid server → agent appears in registry (JSON-RPC `tools/call` received)
- Re-run same agent name → no conflict, treated as success
- Run with unreachable server → warning logged, tool continues
- Registration rejected by server (JSON-RPC error) → warning logged, tool exits 0

---

### REQ-009: Smoke Test — Connection Verification

The tool MUST perform a curl-based smoke test to verify the client can reach and authenticate with the Biblos server.

**Acceptance Criteria:**
- Sends an MCP `initialize` request to the server MCP endpoint with the required headers: `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Authorization: Bearer <key>`, `Origin: <scheme://host>` (base, never the `/mcp` path), `X-Biblos-Agent: <name>`
- Checks for HTTP 200 or 202 response
- Validates response contains valid JSON
- Timeout: 30 seconds
- On success: displays confirmation message
- On failure: triggers automatic rollback (see REQ-011)

**Test Approach:**
- Server reachable with valid key → smoke test passes
- Server reachable with invalid key → smoke test fails (401/403)
- Server unreachable (network down) → smoke test fails (timeout/connection refused)
- Server returns non-JSON response → smoke test fails

---

### REQ-010: Smoke Test — Registration Verification

After config write and smoke test, the tool MUST verify the agent appears in the server's agent registry.

**Acceptance Criteria:**
- Calls the registry list endpoint (or equivalent) to confirm the agent is registered
- Checks that the agent name appears in the returned list
- If not found: logs warning but does NOT fail the tool (registration may be asynchronous)
- Verification uses the same API key and headers

**Test Approach:**
- After successful config write → agent appears in registry query
- After failed registration → warning logged, tool still exits 0

---

### REQ-011: Backup and Rollback

The tool MUST create a backup before any modification and restore it on smoke test failure.

**Acceptance Criteria:**
- Before any config modification: creates timestamped backup
- Backup naming: `<config_path>.backup.<YYYYMMDD-HHMMSS>` (e.g., `~/.config/opencode/opencode.json.backup.20260818-143022`)
- Backup preserves original file permissions (chmod 600 on backup)
- After smoke test failure: automatically restores from backup
- After successful smoke test: keeps backup available for manual restore (does NOT auto-delete)
- Rollback trigger: any non-zero exit from smoke test, network timeout (>30s), auth failure (401/403), invalid JSON response
- Manual restore: `setup-biblos.sh --restore <config_file> <backup_file>`
- Backup integrity check before restore: file exists, non-zero size, valid JSON (for JSON configs)

**Test Approach:**
- Modify config → backup file created with correct naming pattern
- Smoke test fails → config restored to backup state, original content verified
- Smoke test succeeds → backup file still exists on disk
- Run `--restore` with valid backup → config restored
- Run `--restore` with corrupted backup → clear error message

---

### REQ-012: Idempotency

The tool MUST be safe to run multiple times without corrupting state.

**Acceptance Criteria:**
- Re-running on the same agent overwrites the existing Biblos config block (not appends)
- Existing non-Biblos config entries are preserved across re-runs
- Warning displayed if Biblos config already exists (user can choose to overwrite or exit)
- Backup of existing config created before overwrite
- No duplicate entries, no JSON array growth on each run

**Test Approach:**
- Run tool twice in succession → config file contains single Biblos entry, not two
- Run tool, modify config manually, re-run → manual changes preserved (except Biblos block which is overwritten with backup)
- Verify JSON validity after each run

---

### REQ-013: Security — No Key Leakage

The tool MUST never write the API key to committed files, logs, or stdout beyond the initial display.

**Acceptance Criteria:**
- API key is never written to any file in plaintext (injected via native secret mechanisms)
- API key is never appended to log files
- API key is never echoed to stdout after the initial display
- Backup files inherit or tighten permissions (never more permissive than 600)
- Shell history does not capture the key (no `echo` or `print` of key after initial display)

**Test Approach:**
- Search backup files for key pattern → not found
- Search log files for key pattern → not found
- Grep tool source for key in non-initial-display contexts → not found

---

### REQ-014: Zero Dependencies

The tool MUST require only standard Linux utilities: bash, jq, openssl, curl.

**Acceptance Criteria:**
- No npm, node, python packages, or other external dependencies
- All dependencies checked at startup (`command -v`)
- Missing dependency produces a clear error message listing what to install
- Script declares `#!/usr/bin/env bash` shebang
- Script is executable (`chmod +x`)

**Test Approach:**
- Run with only bash, jq, openssl, curl available → tool works
- Run with `jq` missing → clear error: "jq is required. Install with: apt install jq"
- Run with `openssl` missing → clear error: "openssl is required. Install with: apt install openssl"

---

### REQ-015: Extensible Adapter Pattern

The tool MUST use an adapter registry pattern so new agents can be added without modifying core logic.

**Acceptance Criteria:**
- Each agent has its own adapter file under `tools/adapters/` (e.g., `opencode.sh`, `openclaw.sh`, `claude-code.sh`)
- Adapter interface (per agent):
  - `write_config <url> <agent_name> <api_key>` → exits 0/1
  - `smoke_test <url> <agent_name> <api_key>` → exits 0/1
  - `backup_config` → exits 0/1, prints backup path
  - `restore_config` → exits 0/1
  - `cleanup_backup` → exits 0/1 (optional, after 24h)
- Core script sources adapter files dynamically based on agent type
- Registry of supported agents maintained in a constants array (e.g., `SUPPORTED_AGENTS=("opencode" "openclaw" "claude-code")`)
- Adding a new agent = adding one new file + adding name to registry array
- Core script logic does NOT contain agent-specific config format knowledge

**Test Approach:**
- List `tools/adapters/` → each adapter is a separate file
- Add a mock adapter `tools/adapters/mock-agent.sh` + add to registry → core script invokes it correctly
- Verify core script (`setup-biblos.sh`) does not contain agent-specific JSON structures

---

### REQ-016: Terminal UI — Interactive Prompts

The tool MUST provide a clear, interactive terminal UI for user input.

**Acceptance Criteria:**
- Uses `read -p` for prompts (with `dialog` or `whiptail` as fallback if available)
- Clear labeling of each prompt (e.g., "Server URL [default: ...]:")
- Visual separator between steps (e.g., `--- Step 1 of 4 ---`)
- Confirmation prompt before applying changes: "Apply configuration for <agent_name>? [y/N]"
- User can cancel at any point before confirmation (exit code 1)
- Success/failure messages use clear emoji or text indicators (✅ / ❌)

**Test Approach:**
- Run tool in a TTY → prompts displayed with clear labels
- Press Ctrl+C before confirmation → clean exit, no partial config written
- Confirm with 'y' → changes applied
- Confirm with 'n' or Enter (default N) → tool exits without changes

---

### REQ-017: Graceful Handling of Missing Clients

The tool MUST handle cases where a target client is not installed.

**Acceptance Criteria:**
- If OpenCode config dir doesn't exist: create it and proceed
- If OpenClaw config dir doesn't exist: create it and proceed
- If `claude` CLI not installed: skip Claude Code adapter with informative message, continue with other adapters
- If a required utility (jq, openssl, curl) is missing: clear error message with install instructions, exit code 1
- Each adapter failure is isolated — one adapter failing does not prevent others from running

**Test Approach:**
- Run with only `claude` installed → OpenCode/OpenClaw adapters skip with message, Claude Code proceeds
- Run with no clients installed → all adapters skip, tool exits 0 with summary
- Run with jq missing → clear error, exit 1

---

### REQ-018: Summary Output

After completion (success or failure), the tool MUST display a summary of what was done.

**Acceptance Criteria:**
- Lists which adapters were configured successfully
- Does NOT re-display the API key (one-time display only, per REQ-004/REQ-013 — no copy-paste block)
- Shows the server URL used
- Shows the agent name registered
- If rollback occurred: shows what was restored
- Exit code 0 on success, 1 on failure

**Test Approach:**
- Successful run → summary shows all three adapters (or whichever were applicable)
- Failed smoke test → summary shows rollback occurred and what was restored

---

### REQ-019: Help and Usage

The tool MUST support `--help` and `--restore` flags.

**Acceptance Criteria:**
- `--help`: displays usage information including all flags, environment variables, and example commands
- `--restore <config_file> <backup_file>`: restores a specific backup over a config file (no interactive prompts)
- `--help` exits with code 0
- Unknown flags produce a clear error with usage hint

**Test Approach:**
- `setup-biblos.sh --help` → displays usage, exits 0
- `setup-biblos.sh --restore ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.backup.20260818-143022` → restores backup
- `setup-biblos.sh --unknown` → error with usage hint, exits 1

---

## Non-Functional Requirements

### NFR-001: Platform Compatibility

The tool MUST run on Linux (primary) and be portable to macOS with minimal changes.

**Test Approach:**
- Run on Ubuntu 24.04 → all features work
- Run on macOS → verify `openssl rand` and `date` format compatibility

---

### NFR-002: Performance

The tool MUST complete in under 10 seconds on a typical machine with network connectivity.

**Test Approach:**
- Time the full run from prompt to summary → under 10s
- Smoke test timeout is 30s (separate from total runtime)

---

### NFR-003: Logging

The tool MUST log actions to stderr (not stdout) to avoid polluting pipe output.

**Acceptance Criteria:**
- All informational messages go to stderr
- API key display goes to stderr (not stdout)
- Log messages include timestamps
- stdout carries only the non-secret structured result (success/failure summary); all other output goes to stderr

**Test Approach:**
- Run tool and pipe stdout to `/dev/null` → no key or sensitive data in output

---

### NFR-004: Error Handling

The tool MUST handle errors gracefully without leaving the system in an inconsistent state.

**Acceptance Criteria:**
- Any unexpected error exits with code 1 and a clear error message
- Partial failures (e.g., one adapter fails) do not prevent other adapters from running
- Trap handlers clean up temporary files on exit

**Test Approach:**
- Force an error mid-execution (e.g., remove write permissions on config dir) → clean error message, no partial state
- Kill tool mid-execution before smoke test → no config changes applied

---

## Delta Specifications

These are the new behaviors introduced by this change, explicitly called out as deltas against the existing Biblos server spec.

### Delta: New binary `setup-biblos.sh`

A standalone CLI tool, not part of the Biblos server. Lives in `tools/setup-biblos.sh`. Does not modify the server codebase.

### Delta: New directory `tools/adapters/`

Per-agent adapter modules. Each file is self-contained and sourced by the main script.

### Delta: Agent Registry v1 list

The server's agent registry now has v1 clients that connect via this tool:

| Agent | Adapter File | Config Mechanism |
|-------|-------------|------------------|
| OpenCode | `adapters/opencode.sh` | JSON edit via `jq` |
| OpenClaw | `adapters/openclaw.sh` | JSON edit via `jq` + secret store |
| Claude Code | `adapters/claude-code.sh` | `claude mcp add` CLI |
