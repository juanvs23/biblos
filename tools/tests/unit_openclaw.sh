#!/usr/bin/env bash
# =============================================================================
# T017 — Unit tests: OpenClaw adapter (tools/adapters/openclaw.sh)
# =============================================================================
# Covers REQ-006 (config write + secret store injection), REQ-011 (backup/
# restore), REQ-009 (smoke test), REQ-010 (idempotency), REQ-013 (no key
# leakage), REQ-017 (graceful handling of missing CLI).
# =============================================================================

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

ADAPTER="$TOOLS_DIR/adapters/openclaw.sh"
URL="http://localhost:8199/mcp"
# Origin header is the scheme://host base, NEVER the /mcp path.
ORIGIN="http://localhost:8199"
NAME="test-agent-01"
KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

make_sandbox
CONFIG="$HOME/.openclaw/openclaw.json"

# --- write_config -------------------------------------------------------------

test_wc_creates_structure() {
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  assert_file_exists "$CONFIG" || return 1
  assert_json_eq "$CONFIG" '.mcp.servers.biblos.type' "streamable-http" || return 1
  assert_json_eq "$CONFIG" '.mcp.servers.biblos.url' "$URL" || return 1
  assert_json_eq "$CONFIG" '.mcp.servers.biblos.enabled' "true" || return 1
  assert_json_eq "$CONFIG" '.mcp.servers.biblos.headers.Origin' "$ORIGIN" || return 1
  assert_json_eq "$CONFIG" '.mcp.servers.biblos.headers["X-Biblos-Agent"]' "$NAME" || return 1
  # REQ-006: Authorization comes from the secret store, never inline
  assert_json_true "$CONFIG" '.mcp.servers.biblos.headers | has("Authorization") | not' || return 1
  # REQ-013: the raw key must never appear in the config file
  assert_not_contains "$(cat "$CONFIG")" "$KEY" || return 1
}

test_wc_preserves_entries() {
  mkdir -p "$(dirname "$CONFIG")"
  cat > "$CONFIG" <<'JSON'
{"mcp":{"servers":{"other":{"type":"stdio","command":"x"}}},"telemetry":false}
JSON
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  assert_json_eq "$CONFIG" '.telemetry' "false" || return 1
  assert_json_eq "$CONFIG" '.mcp.servers.other.command' "x" || return 1
  assert_json_eq "$CONFIG" '.mcp.servers.biblos.type' "streamable-http" || return 1
}

test_wc_idempotent() {
  mkdir -p "$(dirname "$CONFIG")"
  echo '{}' > "$CONFIG"
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  local n
  n=$(jq '[.mcp.servers | keys[] | select(. == "biblos")] | length' "$CONFIG")
  assert_eq "$n" "1" || return 1
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

# --- secret store injection (REQ-006, REQ-017) --------------------------------

test_wc_injects_secret_store() {
  local log bin
  log=$(mktemp "${TMPDIR:-/tmp}/biblos-clilog.XXXXXX")
  bin=$(make_fake_cli openclaw "$log")
  export PATH="$bin:$PATH"
  mkdir -p "$(dirname "$CONFIG")"
  echo '{}' > "$CONFIG"
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  assert_contains "$(cat "$log")" "secrets set BIBLOS_API_KEY $KEY" || return 1
}

test_wc_secret_store_failure_warns_but_succeeds() {
  local log bin stub err rc
  log=$(mktemp "${TMPDIR:-/tmp}/biblos-clilog.XXXXXX")
  bin=$(make_fake_cli openclaw "$log")
  stub="$bin/openclaw"
  printf '#!/usr/bin/env bash\necho "$*" >> "%s"\nexit 1\n' "$log" > "$stub"
  chmod +x "$stub"
  export PATH="$bin:$PATH"
  mkdir -p "$(dirname "$CONFIG")"
  echo '{}' > "$CONFIG"
  err=$(adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" 2>&1 >/dev/null)
  rc=$?
  assert_eq "$rc" "0" || return 1
  assert_contains "$err" "Failed to set BIBLOS_API_KEY" || return 1
}

test_wc_absent_cli_warns_but_succeeds() {
  local tb err rc
  tb=$(mktemp -d)
  make_toolbox "$tb" # no openclaw in the toolbox
  mkdir -p "$(dirname "$CONFIG")"
  echo '{}' > "$CONFIG"
  err=$(adapter_env_path "$tb" "$ADAPTER" write_config "$URL" "$NAME" "$KEY" 2>&1 >/dev/null)
  rc=$?
  assert_eq "$rc" "0" || return 1
  assert_contains "$err" "openclaw CLI not found" || return 1
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
  local b mode
  b=$(adapter_env "$ADAPTER" backup_config)
  assert_file_exists "$b" || return 1
  assert_contains "$b" "$CONFIG.backup." || return 1
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

t "write_config creates ~/.openclaw/openclaw.json with the REQ-006 structure (no inline key)" test_wc_creates_structure
t "write_config preserves existing non-Biblos entries" test_wc_preserves_entries
t "write_config is idempotent (single biblos entry after re-run)" test_wc_idempotent
t "write_config on corrupt JSON fails cleanly, file untouched, no .tmp leftover" test_wc_corrupt_config_clean_error
t "write_config injects the key via openclaw secrets set BIBLOS_API_KEY" test_wc_injects_secret_store
t "secret store failure warns but does not fail the adapter" test_wc_secret_store_failure_warns_but_succeeds
t "absent openclaw CLI warns and still succeeds" test_wc_absent_cli_warns_but_succeeds
t "write_config never logs the API key" test_wc_no_key_in_logs
t "backup_config creates a timestamped backup with 600 permissions" test_backup_creates_timestamped_600
t "restore_config restores the latest backup" test_restore_restores_latest_backup
t "cleanup_backup removes the backup file" test_cleanup_backup_removes_file
if [[ "$HAVE_PYTHON" -eq 1 ]]; then
  t "smoke_test passes on HTTP 200 + valid JSON" test_smoke_ok
  t "smoke_test fails on HTTP 401" test_smoke_fails_401
  t "smoke_test fails on non-JSON response" test_smoke_fails_non_json
fi

finalize