#!/usr/bin/env bash
# =============================================================================
# T019 — Integration tests: setup-biblos.sh full flow, rollback, edge flows
# =============================================================================
# Drives the real main script non-interactively (stdin piped) against an
# isolated $HOME and the python3 mock MCP server.
#
# Covers REQ-001/002/003 (prompts drive the flow), REQ-004 (shared key prompt),
# REQ-005/006/007 (per-adapter flow), REQ-008 (register_agent), REQ-009 (smoke
# test), REQ-011 (rollback + --restore), REQ-012 (idempotency), REQ-016
# (cancel), REQ-019 (--help / unknown flag), REQ-017 (missing claude CLI).
# =============================================================================

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

NAME="test-agent-01"
# Shared server API key (BIBLOS_API_KEY). The tool does NOT generate a key
# anymore — it prompts for this shared key with no echo, so it must never
# appear in the tool's output, only inside the config's Authorization header.
KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

make_sandbox
OPENC="$HOME/.config/opencode/opencode.json"
OPENCLAW="$HOME/.openclaw/openclaw.json"

INPUT=$(mktemp "${TMPDIR:-/tmp}/biblos-input.XXXXXX")
write_input() { printf '%s\n' "$@" > "$INPUT"; }

# --- Full happy path ----------------------------------------------------------

test_happy_path() {
  reset_sandbox
  OPENC="$HOME/.config/opencode/opencode.json"
  : > "$MOCK_LOG"
  local url="http://127.0.0.1:$MOCK_PORT/mcp"
  # Origin header is the scheme://host base (no /mcp path).
  local origin="http://127.0.0.1:$MOCK_PORT"
  write_input "$url" "$NAME" "1" "$KEY" "y"
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "0" || return 1

  # config written with the REQ-005 structure
  assert_file_exists "$OPENC" || return 1
  assert_json_eq "$OPENC" '.mcp.biblos.type' "remote" || return 1
  assert_json_eq "$OPENC" '.mcp.biblos.url' "$url" || return 1

  # backup created and kept after success (REQ-011)
  local backups
  backups=$(ls "$OPENC".backup.* 2>/dev/null | wc -l)
  assert_eq "$backups" "1" || return 1

  # summary on stdout (REQ-018)
  assert_contains "$(cat "$SETUP_OUT")" "Configuration complete!" || return 1
  assert_contains "$(cat "$SETUP_OUT")" "$NAME" || return 1

  # smoke request carried the expected headers (REQ-009)
  assert_jsonl_eq "$MOCK_LOG" '[.[] | select(.body | contains("initialize"))][0].headers["X-Biblos-Agent"]' "$NAME" || return 1
  assert_jsonl_eq "$MOCK_LOG" '[.[] | select(.body | contains("initialize"))][0].headers.Origin' "$origin" || return 1

  # registration payload reached the server (REQ-008)
  local reg_body auth
  reg_body=$(jq -sr '[.[] | select(.body | contains("capabilities"))][0].body' "$MOCK_LOG")
  assert_contains "$reg_body" '"name": "'$NAME'"' || return 1
  assert_contains "$reg_body" '"type": "opencode"' || return 1
  auth=$(jq -sr '[.[] | select(.body | contains("initialize"))][0].headers.Authorization' "$MOCK_LOG")
  assert_contains "$auth" "Bearer " || return 1

  # REQ-013 / NFR-003: the shared key is entered with NO echo (prompt_secret),
  # so it must NOT appear on stderr, stdout, or in any backup — only inside
  # the config's sanctioned Authorization header.
  assert_eq "$(grep -c "$KEY" "$SETUP_ERR")" "0" || return 1
  assert_eq "$(grep -c "$KEY" "$SETUP_OUT")" "0" || return 1
  assert_eq "$(grep -c "$KEY" "$(ls "$OPENC".backup.* 2>/dev/null | head -1)")" "0" || return 1
  # the config itself carries the key via the sanctioned inline header
  assert_eq "$(grep -c "$KEY" "$OPENC")" "1" || return 1

  # registration succeeded against the mock (200) — REQ-008 best-effort
  assert_contains "$(cat "$SETUP_ERR")" "registered on server" || return 1
}

# --- Rollback (REQ-011) -------------------------------------------------------

test_rollback_on_401() {
  reset_sandbox
  OPENC="$HOME/.config/opencode/opencode.json"
  mkdir -p "$(dirname "$OPENC")"
  echo '{"mcp":{"other":{"type":"stdio","command":"legacy"}}}' > "$OPENC"
  write_input "http://127.0.0.1:$MOCK_PORT/unauthorized" "$NAME" "1" "$KEY" "y"
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "1" || return 1
  # config restored to the pre-write state
  assert_json_eq "$OPENC" '.mcp.other.command' "legacy" || return 1
  assert_json_true "$OPENC" '.mcp | has("biblos") | not' || return 1
  # restore action is visible on stderr
  assert_contains "$(cat "$SETUP_ERR")" "Restoring backup" || return 1
  local backups
  backups=$(ls "$OPENC".backup.* 2>/dev/null | wc -l)
  assert_eq "$backups" "1" || return 1
  # REQ-018 / W3: failure summary block on stdout — what was done, that a
  # rollback was performed, and how to restore manually.
  assert_contains "$(cat "$SETUP_OUT")" "Setup Failed" || return 1
  assert_contains "$(cat "$SETUP_OUT")" "Rollback: performed" || return 1
  assert_contains "$(cat "$SETUP_OUT")" "--restore" || return 1
}

test_rollback_unreachable_server() {
  reset_sandbox
  OPENC="$HOME/.config/opencode/opencode.json"
  mkdir -p "$(dirname "$OPENC")"
  echo '{"original":"marker"}' > "$OPENC"
  local dead_port
  dead_port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  write_input "http://127.0.0.1:$dead_port/mcp" "$NAME" "1" "$KEY" "y"
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "1" || return 1
  assert_json_eq "$OPENC" '.original' "marker" || return 1
  # REQ-018 / W3: failure summary states the rollback was performed.
  assert_contains "$(cat "$SETUP_OUT")" "Setup Failed" || return 1
  assert_contains "$(cat "$SETUP_OUT")" "Rollback: performed" || return 1
}

# --- --restore flag (REQ-019) -------------------------------------------------

test_restore_flag_valid() {
  local cfg backup
  cfg="$HOME/cfg.json"
  backup="$HOME/cfg.json.backup.test1"
  echo '{"v":1}' > "$cfg"
  echo '{"v":2}' > "$backup"
  run_setup_flags --restore "$cfg" "$backup"
  assert_eq "$SETUP_RC" "0" || return 1
  assert_json_eq "$cfg" '.v' "2" || return 1
}

test_restore_flag_corrupt_backup() {
  local cfg backup
  cfg="$HOME/cfg.json"
  backup="$HOME/cfg.json.backup.corrupt"
  echo '{"v":1}' > "$cfg"
  echo 'NOT JSON' > "$backup"
  run_setup_flags --restore "$cfg" "$backup"
  assert_eq "$SETUP_RC" "1" || return 1
  assert_contains "$(cat "$SETUP_ERR")" "validation failed" || return 1
  assert_json_eq "$cfg" '.v' "1" || return 1 # untouched
}

# --- CLI flags (REQ-019) ------------------------------------------------------

test_help_flag() {
  run_setup_flags --help
  assert_eq "$SETUP_RC" "0" || return 1
  assert_contains "$(cat "$SETUP_OUT")" "Usage:" || return 1
}

test_unknown_flag() {
  run_setup_flags --bogus
  assert_eq "$SETUP_RC" "1" || return 1
  assert_contains "$(cat "$SETUP_ERR")" "Unknown flag" || return 1
}

# --- Cancel flow (REQ-016) ----------------------------------------------------

test_cancel_before_apply() {
  reset_sandbox
  OPENC="$HOME/.config/opencode/opencode.json"
  write_input "http://127.0.0.1:$MOCK_PORT/mcp" "$NAME" "1" "$KEY" "n"
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "1" || return 1
  assert_contains "$(cat "$SETUP_ERR")" "Cancelled by user" || return 1
  assert_file_absent "$OPENC" || return 1
}

# --- Per-agent end-to-end -----------------------------------------------------

test_openclaw_e2e() {
  reset_sandbox
  OPENCLAW="$HOME/.openclaw/openclaw.json"
  local log bin
  log=$(mktemp "${TMPDIR:-/tmp}/biblos-clilog.XXXXXX")
  bin=$(make_fake_cli openclaw "$log")
  export PATH="$bin:$PATH"
  write_input "http://127.0.0.1:$MOCK_PORT/mcp" "$NAME" "2" "$KEY" "y"
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "0" || return 1
  assert_json_eq "$OPENCLAW" '.mcp.servers.biblos.type' "streamable-http" || return 1
  assert_contains "$(cat "$log")" "secrets set BIBLOS_API_KEY" || return 1
}

test_claude_e2e_with_cli() {
  local log bin
  log=$(mktemp "${TMPDIR:-/tmp}/biblos-clilog.XXXXXX")
  bin=$(make_fake_cli claude "$log")
  export PATH="$bin:$PATH"
  write_input "http://127.0.0.1:$MOCK_PORT/mcp" "$NAME" "3" "$KEY" "y"
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "0" || return 1
  assert_contains "$(cat "$log")" "mcp add --transport http biblos" || return 1
  assert_contains "$(cat "$SETUP_OUT")" "Configuration complete!" || return 1
}

test_claude_e2e_without_cli() {
  local tb oldpath
  tb=$(mktemp -d)
  make_toolbox "$tb" # complete toolbox minus the claude CLI
  oldpath="$PATH"
  export PATH="$tb"
  write_input "http://127.0.0.1:$MOCK_PORT/mcp" "$NAME" "3" "$KEY" "y"
  run_setup "$INPUT"
  local rc="$SETUP_RC"
  export PATH="$oldpath"
  assert_eq "$rc" "0" || return 1
  assert_contains "$(cat "$SETUP_ERR")" "not installed" || return 1
}

# --- Idempotency end-to-end (REQ-012) -----------------------------------------

test_idempotency_e2e() {
  reset_sandbox
  OPENC="$HOME/.config/opencode/opencode.json"
  mkdir -p "$(dirname "$OPENC")"
  echo '{"editor":{"theme":"dark"}}' > "$OPENC"
  write_input "http://127.0.0.1:$MOCK_PORT/mcp" "$NAME" "1" "$KEY" "y"
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "0" || return 1
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "0" || return 1
  local n backups
  n=$(jq '[.mcp | keys[] | select(. == "biblos")] | length' "$OPENC")
  assert_eq "$n" "1" || return 1
  assert_json_eq "$OPENC" '.editor.theme' "dark" || return 1 # manual changes preserved
  backups=$(ls "$OPENC".backup.* 2>/dev/null | wc -l)
  assert_eq "$backups" "2" || return 1 # one backup per run
}

# --- REQ-003: 4=Exit (verify finding C1) -------------------------------------

test_exit_option_e2e() {
  reset_sandbox
  OPENC="$HOME/.config/opencode/opencode.json"
  write_input "http://127.0.0.1:$MOCK_PORT/mcp" "$NAME" "4"
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "0" || return 1
  # graceful exit message on stderr
  assert_contains "$(cat "$SETUP_ERR")" "Exiting" || return 1
  # exit happens before any config write, backup, or key generation
  assert_file_absent "$OPENC" || return 1
  assert_not_contains "$(cat "$SETUP_ERR")" "API Key" || return 1
  local leftovers
  leftovers=$(find "$HOME" -name '*.backup.*' 2>/dev/null | wc -l)
  assert_eq "$leftovers" "0" || return 1
}

# --- REQ-008/REQ-010: registration failure paths (verify finding W1) ---------

test_register_failure_warns_exit0() {
  reset_sandbox
  OPENC="$HOME/.config/opencode/opencode.json"
  : > "$MOCK_LOG"
  local url="http://127.0.0.1:$MOCK_PORT/register-fail"
  write_input "$url" "$NAME" "1" "$KEY" "y"
  run_setup "$INPUT"
  assert_eq "$SETUP_RC" "0" || return 1
  # smoke test passed against /register-fail (initialize -> 200), config written
  assert_file_exists "$OPENC" || return 1
  # registration returned 500 -> warning logged, tool continues (exit 0)
  assert_contains "$(cat "$SETUP_ERR")" "registration returned HTTP 500" || return 1
  # success summary still shown
  assert_contains "$(cat "$SETUP_OUT")" "Configuration complete!" || return 1
}

# --- run ----------------------------------------------------------------------

if [[ "$HAVE_PYTHON" -eq 1 ]]; then
  start_mock_server "$(mktemp "${TMPDIR:-/tmp}/biblos-mocklog.XXXXXX")" || {
    echo "mock server failed to start" >&2
    exit 1
  }

  t "full happy path: opencode flow, smoke+register, backup kept, key never echoed" test_happy_path
  t "smoke test failure (HTTP 401) triggers automatic rollback + failure summary" test_rollback_on_401
  t "unreachable server triggers rollback with the pre-write config restored + failure summary" test_rollback_unreachable_server
  t "cancel at the confirmation prompt exits 1 without writing config" test_cancel_before_apply
  t "agent-type menu option 4=Exit exits 0 before any config is written (REQ-003)" test_exit_option_e2e
  t "registration failure (HTTP 500) warns and the tool still exits 0 (REQ-008/010)" test_register_failure_warns_exit0
  t "openclaw end-to-end: config written + secret store injected" test_openclaw_e2e
  t "claude-code end-to-end: claude mcp add invoked, summary shown" test_claude_e2e_with_cli
  t "claude-code end-to-end: absent CLI is skipped gracefully, exit 0" test_claude_e2e_without_cli
  t "idempotency end-to-end: re-run keeps a single biblos entry and user edits" test_idempotency_e2e
else
  echo "  SKIP: python3 unavailable — interactive integration tests skipped" >&2
fi

# Flag-based flows do not need the mock server
t "--restore <config> <backup> restores a valid backup" test_restore_flag_valid
t "--restore rejects a corrupt backup with a clear error, config untouched" test_restore_flag_corrupt_backup
t "--help shows usage and exits 0" test_help_flag
t "unknown flag produces an error and exits 1" test_unknown_flag

finalize