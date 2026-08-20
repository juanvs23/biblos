#!/usr/bin/env bash
# =============================================================================
# T018 — Unit tests: Claude Code adapter (tools/adapters/claude-code.sh)
# =============================================================================
# Covers REQ-007 (claude mcp add invocation), REQ-017 (graceful skip when the
# claude CLI is absent), REQ-009 (smoke test), and the no-op adapter functions.
# =============================================================================

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

ADAPTER="$TOOLS_DIR/adapters/claude-code.sh"
URL="http://localhost:8199/mcp"
NAME="test-agent-01"
KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

make_sandbox

# --- write_config -------------------------------------------------------------

test_wc_no_claude_skips_gracefully() {
  local tb err rc
  tb=$(mktemp -d)
  make_toolbox "$tb" # no claude in the toolbox
  err=$(adapter_env_path "$tb" "$ADAPTER" write_config "$URL" "$NAME" "$KEY" 2>&1 >/dev/null)
  rc=$?
  assert_eq "$rc" "0" || return 1
  assert_contains "$err" "not installed" || return 1
}

test_wc_runs_claude_mcp_add() {
  local log bin err rc
  log=$(mktemp "${TMPDIR:-/tmp}/biblos-clilog.XXXXXX")
  bin=$(make_fake_cli claude "$log")
  export PATH="$bin:$PATH"
  err=$(adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" 2>&1 >/dev/null)
  rc=$?
  assert_eq "$rc" "0" || return 1
  assert_contains "$(cat "$log")" "mcp add --transport http biblos $URL" || return 1
  assert_contains "$(cat "$log")" "--header Authorization: Bearer $KEY" || return 1
  assert_contains "$(cat "$log")" "--header Origin: $URL" || return 1
  assert_contains "$(cat "$log")" "--header X-Biblos-Agent: $NAME" || return 1
  assert_contains "$err" "config written via CLI" || return 1
}

test_wc_idempotent() {
  local log bin
  log=$(mktemp "${TMPDIR:-/tmp}/biblos-clilog.XXXXXX")
  bin=$(make_fake_cli claude "$log")
  export PATH="$bin:$PATH"
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  local n
  n=$(grep -c 'mcp add' "$log")
  assert_eq "$n" "2" || return 1 # CLI manages state; re-run is a no-op update
}

test_wc_never_touches_home() {
  local log bin
  log=$(mktemp "${TMPDIR:-/tmp}/biblos-clilog.XXXXXX")
  bin=$(make_fake_cli claude "$log")
  export PATH="$bin:$PATH"
  adapter_env "$ADAPTER" write_config "$URL" "$NAME" "$KEY" || return 1
  local files
  files=$(find "$HOME" -type f 2>/dev/null | wc -l)
  assert_eq "$files" "0" || return 1
}

# --- no-op adapter functions --------------------------------------------------

test_backup_config_noop() {
  local out
  out=$(adapter_env "$ADAPTER" backup_config)
  assert_eq "$?" "0" || return 1
  assert_eq "$out" "" || return 1
}

test_restore_config_noop() {
  adapter_env "$ADAPTER" restore_config
}

test_cleanup_backup_noop() {
  adapter_env "$ADAPTER" cleanup_backup
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
else
  echo "  SKIP: python3 unavailable — smoke tests skipped" >&2
fi

# --- run ----------------------------------------------------------------------

t "write_config skips gracefully with an informative message when claude is absent" test_wc_no_claude_skips_gracefully
t "write_config invokes claude mcp add with url, key, origin and agent headers" test_wc_runs_claude_mcp_add
t "write_config is idempotent across re-runs (CLI updates state)" test_wc_idempotent
t "write_config never creates files under \$HOME (CLI manages state)" test_wc_never_touches_home
t "backup_config is a no-op that exits 0" test_backup_config_noop
t "restore_config is a no-op that exits 0" test_restore_config_noop
t "cleanup_backup is a no-op that exits 0" test_cleanup_backup_noop
if [[ "$HAVE_PYTHON" -eq 1 ]]; then
  t "smoke_test passes on HTTP 200 + valid JSON" test_smoke_ok
  t "smoke_test fails on HTTP 401" test_smoke_fails_401
fi

finalize