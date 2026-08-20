#!/usr/bin/env bash
# =============================================================================
# T016 — Unit tests: OpenCode adapter (tools/adapters/opencode.sh)
# =============================================================================
# Covers REQ-005 (config write), REQ-011 (backup/restore), REQ-009 (smoke
# test), REQ-010 (idempotency), REQ-012 (zero deps), REQ-013 (no key leakage).
# =============================================================================

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

ADAPTER="$TOOLS_DIR/adapters/opencode.sh"
URL="http://localhost:8199/mcp"
# Origin header is the scheme://host base, NEVER the /mcp path (matches
# BIBLOS_ALLOWED_ORIGINS exact match on the server).
ORIGIN="http://localhost:8199"
NAME="test-agent-01"
KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

make_sandbox
CONFIG="$HOME/.config/opencode/opencode.json"

# --- write_config -------------------------------------------------------------

test_wc_creates_structure() {
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  assert_file_exists "$CONFIG" || return 1
  assert_json_eq "$CONFIG" '.mcp.biblos.type' "remote" || return 1
  assert_json_eq "$CONFIG" '.mcp.biblos.url' "$URL" || return 1
  assert_json_eq "$CONFIG" '.mcp.biblos.enabled' "true" || return 1
  assert_json_eq "$CONFIG" '.mcp.biblos.oauth' "false" || return 1
  assert_json_eq "$CONFIG" '.mcp.biblos.headers.Authorization' "Bearer $KEY" || return 1
  assert_json_eq "$CONFIG" '.mcp.biblos.headers.Origin' "$ORIGIN" || return 1
  assert_json_eq "$CONFIG" '.mcp.biblos.headers["X-Biblos-Agent"]' "$NAME" || return 1
}

test_wc_preserves_entries() {
  mkdir -p "$(dirname "$CONFIG")"
  cat > "$CONFIG" <<'JSON'
{"mcp":{"servers":{"github":{"type":"stdio","command":"mcp-gh"}}},"editor":{"theme":"dark"}}
JSON
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  assert_json_eq "$CONFIG" '.editor.theme' "dark" || return 1
  assert_json_eq "$CONFIG" '.mcp.servers.github.command' "mcp-gh" || return 1
  assert_json_eq "$CONFIG" '.mcp.biblos.type' "remote" || return 1
}

test_wc_idempotent() {
  mkdir -p "$(dirname "$CONFIG")"
  echo '{}' > "$CONFIG"
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  local n
  n=$(jq '[.mcp | keys[] | select(. == "biblos")] | length' "$CONFIG")
  assert_eq "$n" "1" || return 1
  assert_json_eq "$CONFIG" '.mcp.biblos.url' "$URL" || return 1
}

test_wc_corrupt_config_clean_error() {
  mkdir -p "$(dirname "$CONFIG")"
  echo 'NOT JSON' > "$CONFIG"
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY"
  local rc=$?
  assert_eq "$rc" "1" || return 1
  assert_eq "$(cat "$CONFIG")" "NOT JSON" || return 1
  assert_file_absent "${CONFIG}.tmp" || return 1
}

test_wc_no_key_in_logs() {
  mkdir -p "$(dirname "$CONFIG")"
  echo '{}' > "$CONFIG"
  local err
  err=$(adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" 2>&1 >/dev/null)
  assert_not_contains "$err" "$KEY" || return 1
}

# --- backup / restore ---------------------------------------------------------

test_backup_creates_timestamped_600() {
  mkdir -p "$(dirname "$CONFIG")"
  echo '{"a":1}' > "$CONFIG"
  local b
  b=$(adapter_env "$ADAPTER" backup_config)
  assert_file_exists "$b" || return 1
  assert_contains "$b" "$CONFIG.backup." || return 1
  local mode
  mode=$(stat -c %a "$b")
  assert_eq "$mode" "600" || return 1
  assert_json_eq "$b" '.a' "1" || return 1
}

test_restore_restores_latest_backup() {
  mkdir -p "$(dirname "$CONFIG")"
  echo '{"original":true}' > "$CONFIG"
  adapter_env "$ADAPTER" backup_config >/dev/null
  echo '{"modified":true}' > "$CONFIG"
  adapter_env "$ADAPTER" restore_config || return 1
  assert_json_eq "$CONFIG" '.original' "true" || return 1
}

test_cleanup_backup_removes_file() {
  mkdir -p "$(dirname "$CONFIG")"
  echo '{}' > "$CONFIG"
  local b
  b=$(adapter_env "$ADAPTER" backup_config)
  adapter_env "$ADAPTER" cleanup_backup "$b" || return 1
  assert_file_absent "$b" || return 1
}

# --- smoke_test (needs the python3 mock server) --------------------------------

if [[ "$HAVE_PYTHON" -eq 1 ]]; then
  start_mock_server "$(mktemp "${TMPDIR:-/tmp}/biblos-mocklog.XXXXXX")" || {
    echo "mock server failed to start" >&2
    exit 1
  }

  test_smoke_ok() {
    adapter_env "$ADAPTER" smoke_test "http://127.0.0.1:$MOCK_PORT/ok" "$NAME" "$KEY"
  }

  test_smoke_202_accepted() {
    adapter_env "$ADAPTER" smoke_test "http://127.0.0.1:$MOCK_PORT/accepted" "$NAME" "$KEY"
  }

  test_smoke_fails_401() {
    adapter_env "$ADAPTER" smoke_test "http://127.0.0.1:$MOCK_PORT/unauthorized" "$NAME" "$KEY"
    [[ $? -ne 0 ]]
  }

  test_smoke_fails_non_json() {
    adapter_env "$ADAPTER" smoke_test "http://127.0.0.1:$MOCK_PORT/invalid" "$NAME" "$KEY"
    [[ $? -ne 0 ]]
  }
else
  echo "  SKIP: python3 unavailable — smoke tests skipped" >&2
fi

# --- run ----------------------------------------------------------------------

t "write_config creates ~/.config/opencode/opencode.json with the REQ-005 structure" test_wc_creates_structure
t "write_config preserves existing non-Biblos entries" test_wc_preserves_entries
t "write_config is idempotent (single biblos entry after re-run)" test_wc_idempotent
t "write_config on corrupt JSON fails cleanly, file untouched, no .tmp leftover" test_wc_corrupt_config_clean_error
t "write_config never logs the API key" test_wc_no_key_in_logs
t "backup_config creates a timestamped backup with 600 permissions" test_backup_creates_timestamped_600
t "restore_config restores the latest backup" test_restore_restores_latest_backup
t "cleanup_backup removes the backup file" test_cleanup_backup_removes_file
if [[ "$HAVE_PYTHON" -eq 1 ]]; then
  t "smoke_test passes on HTTP 200 + valid JSON" test_smoke_ok
  t "smoke_test passes on HTTP 202" test_smoke_202_accepted
  t "smoke_test fails on HTTP 401" test_smoke_fails_401
  t "smoke_test fails on non-JSON response" test_smoke_fails_non_json
fi

finalize