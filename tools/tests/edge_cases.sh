#!/usr/bin/env bash
# =============================================================================
# T020 — Edge cases and NFR validation
# =============================================================================
# Covers validation helpers (REQ-001/002/004), backup edge cases (REQ-011),
# missing dependencies (REQ-014), and NFR-001/002/003/004.
# =============================================================================

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

URL="http://localhost:8199/mcp"
NAME="test-agent-01"
KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

make_sandbox
OPENC="$HOME/.config/opencode/opencode.json"
OPENCLAW="$HOME/.openclaw/openclaw.json"

# --- Validation helpers (REQ-001, REQ-002) ------------------------------------

test_validate_url_accepts() {
  local cases=(
    "http://example.com"
    "https://biblos.coltmandev.dev/mcp"
    "http://127.0.0.1:8199/mcp"
    "https://localhost:9999/x?y=1"
  )
  local u
  for u in "${cases[@]}"; do
    lib_env "$LIB_DIR/tui.sh" validate_url "$u" || { fail "validate_url should accept: $u"; return 1; }
  done
  return 0
}

test_validate_url_rejects() {
  local cases=(
    "not-a-url"
    "ftp://x"
    "https://"
    "http://"
    "example.com"
  )
  local u
  for u in "${cases[@]}"; do
    lib_env "$LIB_DIR/tui.sh" validate_url "$u" && { fail "validate_url should reject: $u"; return 1; }
  done
  return 0
}

test_validate_agent_name_accepts() {
  local cases=(
    "my-agent-01"
    "abc"
    "A1-b2-c3"
    "a-b-c-d-e-f-123456"
  )
  local n
  for n in "${cases[@]}"; do
    lib_env "$LIB_DIR/tui.sh" validate_agent_name "$n" || { fail "validate_agent_name should accept: $n"; return 1; }
  done
  return 0
}

test_validate_agent_name_rejects() {
  local cases=(
    ""
    "ab"
    "this-name-is-way-too-long-for-a-valid-agent-name"
    "agent name with spaces"
    "agent_name"
    "agent.name"
  )
  local n
  for n in "${cases[@]}"; do
    lib_env "$LIB_DIR/tui.sh" validate_agent_name "$n" && { fail "validate_agent_name should reject: [$n]"; return 1; }
  done
  return 0
}

# --- Key generation (REQ-004) -------------------------------------------------

test_generate_key_format() {
  local k
  k=$(lib_env "$LIB_DIR/core.sh" generate_key)
  [[ "$k" =~ ^[0-9a-f]{64}$ ]] || { fail "key does not match ^[0-9a-f]{64}$: [$k]"; return 1; }
}

test_generate_key_random() {
  local k1 k2
  k1=$(lib_env "$LIB_DIR/core.sh" generate_key)
  k2=$(lib_env "$LIB_DIR/core.sh" generate_key)
  [[ "$k1" != "$k2" ]] || { fail "two generated keys are identical"; return 1; }
}

test_generate_key_openssl_missing() {
  local bin out rc
  bin=$(mktemp -d)
  ln -s "$(command -v date)" "$bin/date"
  out=$( ( export PATH="$bin"; source "$LIB_DIR/core.sh"; generate_key ) 2>&1 )
  rc=$?
  assert_eq "$rc" "1" || return 1
  assert_contains "$out" "openssl rand failed" || return 1
}

test_prompt_secret_reads_stdin() {
  local out
  # The value is read from stdin without echo; only the value itself is
  # printed to stdout (the prompt goes to stderr, discarded here).
  out=$(printf '%s\n' "$KEY" | lib_env "$LIB_DIR/tui.sh" prompt_secret "Enter key:" 2>/dev/null)
  assert_eq "$out" "$KEY" || return 1
}

# --- Missing dependencies (REQ-014) -------------------------------------------

test_check_deps_missing() {
  local out rc
  out=$( ( source "$LIB_DIR/core.sh"; REQUIRED_DEPS=(jq openssl curl definitely-missing-tool-xyz); check_deps ) 2>&1 )
  rc=$?
  assert_eq "$rc" "1" || return 1
  assert_contains "$out" "Missing required dependencies" || return 1
  assert_contains "$out" "apt install" || return 1
}

# --- Backup edge cases (REQ-011) ----------------------------------------------

test_backup_names_distinct_same_second() {
  local f a b
  f="$HOME/config.json"
  echo '{"x":1}' > "$f"
  a=$(lib_env "$LIB_DIR/backup.sh" create_backup "$f")
  b=$(lib_env "$LIB_DIR/backup.sh" create_backup "$f")
  [[ "$a" != "$b" ]] || { fail "concurrent backup names collided: $a"; return 1; }
  assert_file_exists "$a" || return 1
  assert_file_exists "$b" || return 1
}

test_backup_permissions_600() {
  local f b mode
  f="$HOME/config.json"
  echo '{"x":1}' > "$f"
  chmod 640 "$f" # deliberately loose original permissions
  b=$(lib_env "$LIB_DIR/backup.sh" create_backup "$f")
  mode=$(stat -c %a "$b")
  assert_eq "$mode" "600" || return 1
}

test_validate_backup_missing() {
  lib_env "$LIB_DIR/backup.sh" validate_backup "$HOME/nope.json.backup.x"
  [[ $? -ne 0 ]]
}

test_validate_backup_empty() {
  local f
  f="$HOME/empty.json.backup.x"
  : > "$f"
  lib_env "$LIB_DIR/backup.sh" validate_backup "$f"
  [[ $? -ne 0 ]]
}

test_validate_backup_corrupt() {
  local f
  f="$HOME/bad.json.backup.x"
  echo 'nope' > "$f"
  lib_env "$LIB_DIR/backup.sh" validate_backup "$f"
  [[ $? -ne 0 ]]
}

test_validate_backup_valid() {
  local f
  f="$HOME/good.json.backup.x"
  echo '{"ok":true}' > "$f"
  lib_env "$LIB_DIR/backup.sh" validate_backup "$f"
}

test_restore_missing_backup_fails() {
  local out rc
  out=$(lib_env "$LIB_DIR/backup.sh" restore_backup "$HOME/cfg.json" "$HOME/ghost.json.backup.x" 2>&1)
  rc=$?
  assert_eq "$rc" "1" || return 1
  assert_contains "$out" "validation failed" || return 1
}

# --- Empty / corrupt config files ---------------------------------------------

test_empty_existing_config_initialized_opencode() {
  # A 0-byte existing file has nothing to preserve — the adapter must
  # initialize it with the default empty JSON (design edge case #1).
  mkdir -p "$(dirname "$OPENC")"
  : > "$OPENC"
  adapter_env "$TOOLS_DIR/adapters/opencode.sh" write_config "$URL" "$NAME" "$KEY"
  local rc=$?
  assert_eq "$rc" "0" || return 1
  assert_json_eq "$OPENC" '.mcp.biblos.type' "remote" || return 1
  assert_file_absent "${OPENC}.tmp" || return 1
}

test_empty_existing_config_initialized_openclaw() {
  mkdir -p "$(dirname "$OPENCLAW")"
  : > "$OPENCLAW"
  adapter_env "$TOOLS_DIR/adapters/openclaw.sh" write_config "$URL" "$NAME" "$KEY"
  local rc=$?
  assert_eq "$rc" "0" || return 1
  assert_json_eq "$OPENCLAW" '.mcp.servers.biblos.type' "streamable-http" || return 1
  assert_file_absent "${OPENCLAW}.tmp" || return 1
}

# --- NFR-004: error handling --------------------------------------------------

test_unwritable_config_dir_clean_error() {
  if [[ "$(id -u)" -eq 0 ]]; then
    echo "  SKIP: running as root — permission test skipped" >&2
    return 0
  fi
  mkdir -p "$HOME/.config/opencode"
  chmod 555 "$HOME/.config/opencode"
  local rc
  adapter_env "$TOOLS_DIR/adapters/opencode.sh" write_config "$URL" "$NAME" "$KEY" 2>/dev/null
  rc=$?
  chmod 755 "$HOME/.config/opencode"
  assert_eq "$rc" "1" || return 1
}

test_no_tmp_leftover_after_run() {
  run_setup_flags --help
  assert_eq "$SETUP_RC" "0" || return 1
  assert_file_absent "$TOOLS_DIR/.tmp_setup" || return 1
}

# --- NFR-001: platform compatibility (static checks) --------------------------

test_nfr_shebang() {
  local f
  for f in setup-biblos.sh lib/core.sh lib/backup.sh lib/tui.sh \
           adapters/opencode.sh adapters/openclaw.sh adapters/claude-code.sh; do
    head -1 "$TOOLS_DIR/$f" | grep -q '#!/usr/bin/env bash' || { fail "shebang missing in $f"; return 1; }
  done
  return 0
}

test_nfr_executable() {
  [[ -x "$TOOLS_DIR/setup-biblos.sh" ]] || { fail "setup-biblos.sh is not executable"; return 1; }
}

test_nfr_bash_version() {
  [[ "${BASH_VERSINFO[0]}" -ge 4 ]] || { fail "bash ${BASH_VERSION} < 4"; return 1; }
}

test_nfr_syntax_check() {
  local f rc=0
  for f in "$TOOLS_DIR"/setup-biblos.sh "$TOOLS_DIR"/lib/*.sh "$TOOLS_DIR"/adapters/*.sh; do
    bash -n "$f" || { fail "bash -n failed: $f"; rc=1; }
  done
  return $rc
}

# --- NFR-002: performance -----------------------------------------------------

test_nfr_perf_help_under_10s() {
  local start end ms
  start=$(date +%s%N)
  run_setup_flags --help
  end=$(date +%s%N)
  ms=$(( (end - start) / 1000000 ))
  assert_eq "$SETUP_RC" "0" || return 1
  [[ "$ms" -lt 10000 ]] || { fail "--help took ${ms}ms (limit 10000)"; return 1; }
}

test_nfr_perf_full_flow_under_10s() {
  if [[ "$HAVE_PYTHON" -ne 1 ]]; then
    echo "  SKIP: python3 unavailable" >&2
    return 0
  fi
  start_mock_server "$(mktemp "${TMPDIR:-/tmp}/biblos-mocklog.XXXXXX")"
  local input start end ms
  input=$(mktemp "${TMPDIR:-/tmp}/biblos-input.XXXXXX")
  printf '%s\n' "http://127.0.0.1:$MOCK_PORT/mcp" "$NAME" "1" "$KEY" "y" > "$input"
  start=$(date +%s%N)
  run_setup "$input"
  end=$(date +%s%N)
  ms=$(( (end - start) / 1000000 ))
  assert_eq "$SETUP_RC" "0" || return 1
  [[ "$ms" -lt 10000 ]] || { fail "full flow took ${ms}ms (limit 10000)"; return 1; }
  stop_mock_server
}

# --- NFR-003: logging / REQ-013: no key leakage (full flow) -------------------

test_nfr_logging_and_key_leakage() {
  if [[ "$HAVE_PYTHON" -ne 1 ]]; then
    echo "  SKIP: python3 unavailable" >&2
    return 0
  fi
  start_mock_server "$(mktemp "${TMPDIR:-/tmp}/biblos-mocklog.XXXXXX")"
  # Start from a clean slate: earlier tests in the shared sandbox already
  # wrote a (key-carrying) config, which would legitimately end up in THIS
  # run's backup. Remove prior config + backups so the only key occurrence is
  # the one this run injects into the config header.
  rm -f "$OPENC" "$OPENC".backup.* 2>/dev/null
  local input backup
  input=$(mktemp "${TMPDIR:-/tmp}/biblos-input.XXXXXX")
  printf '%s\n' "http://127.0.0.1:$MOCK_PORT/mcp" "$NAME" "1" "$KEY" "y" > "$input"
  run_setup "$input"
  assert_eq "$SETUP_RC" "0" || return 1

  # NFR-003: log lines on stderr carry timestamps
  local logs
  logs=$(grep -cE '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] ' "$SETUP_ERR")
  [[ "$logs" -gt 0 ]] || { fail "no timestamped log lines on stderr"; return 1; }

  # REQ-013: the shared key is entered with NO echo (prompt_secret), so it
  # must never appear on stderr, stdout, or in any backup file. It appears
  # exactly once: inside the config's sanctioned Authorization header.
  assert_eq "$(grep -c "$KEY" "$SETUP_ERR")" "0" || return 1
  assert_eq "$(grep -c "$KEY" "$SETUP_OUT")" "0" || return 1
  backup=$(ls "$OPENC".backup.* 2>/dev/null | head -1)
  assert_eq "$(grep -c "$KEY" "$backup")" "0" || return 1
  assert_eq "$(grep -c "$KEY" "$OPENC")" "1" || return 1
  stop_mock_server
}

# --- REQ-003: prompt_choice menu (verify findings C1 + S5) --------------------

test_prompt_choice_exit_option() {
  local out
  out=$(printf '4\n' | lib_env "$LIB_DIR/tui.sh" prompt_choice "Select:" "opencode" "openclaw" "claude-code" "Exit")
  assert_eq "$out" "Exit" || return 1
}

test_prompt_choice_invalid_reprompts() {
  local out
  out=$(printf '0\n5\nabc\n2\n' | lib_env "$LIB_DIR/tui.sh" prompt_choice "Select:" "opencode" "openclaw" "claude-code" "Exit")
  assert_eq "$out" "openclaw" || return 1
}

test_prompt_choice_invalid_error_message() {
  local err
  err=$(printf '0\n1\n' | lib_env "$LIB_DIR/tui.sh" prompt_choice "Select:" "opencode" "openclaw" 2>&1 >/dev/null)
  assert_contains "$err" "Invalid selection" || return 1
}

# --- REQ-008: register_agent best-effort on an unreachable server (W1) --------

test_register_agent_unreachable_warns() {
  local dead_port out rc
  dead_port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  out=$(lib_env "$LIB_DIR/core.sh" register_agent "http://127.0.0.1:$dead_port/mcp" "$NAME" "opencode" "$KEY" 2>&1)
  rc=$?
  assert_eq "$rc" "0" || return 1
  assert_contains "$out" "registration returned HTTP" || return 1
}

# --- NFR-001: portable backup timestamp (verify finding W2) -------------------

test_backup_timestamp_portable() {
  local ts
  ts=$(lib_env "$LIB_DIR/backup.sh" backup_timestamp)
  # YYYYMMDD-HHMMSS base (POSIX), optionally -<nanos|epoch> tiebreaker
  [[ "$ts" =~ ^[0-9]{8}-[0-9]{6}(-[0-9]+)?$ ]] || { fail "unexpected timestamp format: [$ts]"; return 1; }
}

test_backup_name_format() {
  local f b suffix
  f="$HOME/cfg.json"
  echo '{"x":1}' > "$f"
  b=$(lib_env "$LIB_DIR/backup.sh" create_backup "$f")
  assert_contains "$b" "$f.backup." || return 1
  suffix=${b#"$f.backup."}
  [[ "$suffix" =~ ^[0-9]{8}-[0-9]{6}(-[0-9]+)?$ ]] || { fail "unexpected backup suffix: [$suffix]"; return 1; }
  assert_file_exists "$b" || return 1
}

# --- run ----------------------------------------------------------------------

t "validate_url accepts http/https URLs" test_validate_url_accepts
t "validate_url rejects non-URLs" test_validate_url_rejects
t "validate_agent_name accepts 3-32 alphanumeric/hyphen names" test_validate_agent_name_accepts
t "validate_agent_name rejects empty/short/long/space/underscore/dot names" test_validate_agent_name_rejects
t "generate_key emits a 64-hex-char key" test_generate_key_format
t "generate_key produces distinct keys per call" test_generate_key_random
t "generate_key fails with a clear error when openssl is missing" test_generate_key_openssl_missing
t "prompt_secret reads a value from stdin without echoing it" test_prompt_secret_reads_stdin
t "check_deps reports missing dependencies with install hints and exits 1" test_check_deps_missing
t "concurrent same-second backups get distinct filenames" test_backup_names_distinct_same_second
t "backups are tightened to 600 permissions" test_backup_permissions_600
t "validate_backup rejects a missing backup" test_validate_backup_missing
t "validate_backup rejects an empty backup" test_validate_backup_empty
t "validate_backup rejects a corrupt (non-JSON) backup" test_validate_backup_corrupt
t "validate_backup accepts a valid JSON backup" test_validate_backup_valid
t "restore_backup fails cleanly when the backup is missing" test_restore_missing_backup_fails
t "0-byte existing opencode config is initialized with the correct structure" test_empty_existing_config_initialized_opencode
t "0-byte existing openclaw config is initialized with the correct structure" test_empty_existing_config_initialized_openclaw
t "unwritable config dir fails cleanly (NFR-004)" test_unwritable_config_dir_clean_error
t "no .tmp_setup leftover after a run (trap cleanup, NFR-004)" test_no_tmp_leftover_after_run
t "NFR-001: all scripts declare the bash shebang" test_nfr_shebang
t "NFR-001: setup-biblos.sh is executable" test_nfr_executable
t "NFR-001: bash >= 4" test_nfr_bash_version
t "NFR-001: all shell scripts pass bash -n syntax check" test_nfr_syntax_check
t "NFR-002: --help completes in under 10s" test_nfr_perf_help_under_10s
t "NFR-002: full flow completes in under 10s" test_nfr_perf_full_flow_under_10s
t "NFR-003: logs carry timestamps; key leaks nowhere (no-echo prompt) except the config header" test_nfr_logging_and_key_leakage
t "prompt_choice returns the Exit sentinel for selection 4 (REQ-003)" test_prompt_choice_exit_option
t "prompt_choice rejects 0/5/abc and re-prompts until a valid choice (S5)" test_prompt_choice_invalid_reprompts
t "prompt_choice reports invalid input with a clear error message (S5)" test_prompt_choice_invalid_error_message
if [[ "$HAVE_PYTHON" -eq 1 ]]; then
  t "register_agent on an unreachable server warns and continues (exit 0, REQ-008)" test_register_agent_unreachable_warns
fi
t "backup_timestamp emits a portable YYYYMMDD-HHMMSS[-tiebreaker] format (NFR-001)" test_backup_timestamp_portable
t "backup names keep the <cfg>.backup.<portable-ts> contract (REQ-011/NFR-001)" test_backup_name_format

finalize