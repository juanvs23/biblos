#!/usr/bin/env bash
# =============================================================================
# Biblos Test Helpers — shared functions for the tools test suite
# =============================================================================
# Provides: assertions, a t() test runner, a $HOME sandbox, a mock MCP HTTP
# server, fake CLI stubs, adapter/lib execution environments, and a runner
# for setup-biblos.sh itself.
#
# The suite is pure bash + standard tools (jq/openssl/curl). python3 is used
# only for the mock HTTP server and is optional (mock-dependent tests skip
# cleanly when it is missing).
# =============================================================================

set -u

# --- Per-file counters --------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR="$TOOLS_DIR/lib"
MOCK_SERVER_SCRIPT="$TOOLS_DIR/tests/mock_server.py"

# --- Assertions ---------------------------------------------------------------

fail() { echo "  ASSERT: $*" >&2; return 1; }

assert_eq()           { [[ "$1" == "$2" ]] || fail "expected [$2], got [$1]"; }
assert_contains()     { [[ "$1" == *"$2"* ]] || fail "expected [$1] to contain [$2]"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "unexpected [$2] found in [$1]"; }
assert_file_exists()  { [[ -f "$1" ]] || fail "file missing: $1"; }
assert_file_absent()  { [[ ! -e "$1" ]] || fail "file should not exist: $1"; }

# assert_json_eq <file> <jq-expr> <expected>
assert_json_eq() {
  local got
  got=$(jq -r "$2" "$1" 2>/dev/null) || { fail "$1: jq error on [$2]"; return 1; }
  [[ "$got" == "$3" ]] || fail "$1: jq $2 -> [$got], expected [$3]"
}

# assert_json_true <file> <jq-expr>  — expr must evaluate to boolean true
assert_json_true() {
  jq -e "$2" "$1" >/dev/null 2>&1 || fail "$1: jq [$2] is false"
}

# assert_jsonl_eq <jsonl-file> <jq-expr> <expected>
# Like assert_json_eq but for JSON-lines files (one object per line, as
# produced by the mock server log) — slurps the file into an array first.
assert_jsonl_eq() {
  local got
  got=$(jq -sr "$2" "$1" 2>/dev/null) || { fail "$1: jq error on [$2]"; return 1; }
  [[ "$got" == "$3" ]] || fail "$1: jq $2 -> [$got], expected [$3]"
}

# --- Test runner --------------------------------------------------------------

# t <description> <function> [args...] — runs a test function, records pass/fail
t() {
  local desc="$1"; shift
  local out rc
  out=$(mktemp "${TMPDIR:-/tmp}/biblos-t.XXXXXX")
  if "$@" >"$out" 2>&1; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '  ok    %s\n' "$desc"
  else
    rc=$?
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '  FAIL  %s (exit %s)\n' "$desc" "$rc" >&2
    sed 's/^/        /' "$out" >&2
  fi
  rm -f "$out"
}

# --- $HOME sandbox ------------------------------------------------------------

SANDBOX_DIR=""
FAKE_BINS=()
MOCK_PID=""

make_sandbox() {
  SANDBOX_DIR=$(mktemp -d "${TMPDIR:-/tmp}/biblos-sandbox.XXXXXX")
  export HOME="$SANDBOX_DIR"
}

cleanup_all() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  [[ -n "$MOCK_PID" ]] && wait "$MOCK_PID" 2>/dev/null
  [[ -n "$SANDBOX_DIR" ]] && rm -rf "$SANDBOX_DIR"
  local b
  for b in "${FAKE_BINS[@]:-}"; do rm -rf "$b"; done
}

# --- Mock MCP server (python3, optional) --------------------------------------

MOCK_PORT=""
MOCK_LOG=""

HAVE_PYTHON=0
command -v python3 &>/dev/null && HAVE_PYTHON=1

# start_mock_server <log-file> — starts the mock on a free port, sets MOCK_PORT
start_mock_server() {
  MOCK_LOG="$1"
  : > "$MOCK_LOG"
  export MOCK_SERVER_LOG="$MOCK_LOG"
  MOCK_PORT=$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)
  python3 "$MOCK_SERVER_SCRIPT" "$MOCK_PORT" &
  MOCK_PID=$!
  local i
  for i in $(seq 1 30); do
    curl -s --max-time 1 -o /dev/null "http://127.0.0.1:$MOCK_PORT/ping" && return 0
    sleep 0.05
  done
  echo "mock server failed to start" >&2
  return 1
}

stop_mock_server() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  [[ -n "$MOCK_PID" ]] && wait "$MOCK_PID" 2>/dev/null
  MOCK_PID=""
}

# --- Execution environments ---------------------------------------------------

# adapter_env <adapter-file> <func> [args...]
# Runs func in a subshell with core+backup libs and the adapter sourced.
# (Sourcing happens in a subshell so the adapters' `set -euo pipefail`
# never leaks into the test process.)
adapter_env() {
  local adapter="$1"; shift
  local func="$1"; shift
  (
    source "$LIB_DIR/core.sh"
    source "$LIB_DIR/backup.sh"
    source "$adapter"
    "$func" "$@"
  )
}

# adapter_env_path <PATH> <adapter-file> <func> [args...]
# Same as adapter_env but with an explicit PATH (for absent-CLI tests).
adapter_env_path() {
  local path="$1"; shift
  local adapter="$1"; shift
  local func="$1"; shift
  (
    export PATH="$path"
    source "$LIB_DIR/core.sh"
    source "$LIB_DIR/backup.sh"
    source "$adapter"
    "$func" "$@"
  )
}

# lib_env <lib-file> <func> [args...] — runs func in a subshell with core.sh
# (for log_* helpers) and the requested lib sourced.
lib_env() {
  local lib="$1"; shift
  local func="$1"; shift
  ( source "$LIB_DIR/core.sh"; source "$lib"; "$func" "$@" )
}

# reset_sandbox — fresh $HOME for tests that need pristine state
# (does NOT touch the mock server). Re-derives config paths afterwards.
reset_sandbox() {
  [[ -n "$SANDBOX_DIR" ]] && rm -rf "$SANDBOX_DIR"
  make_sandbox
}

# --- Fake CLI stubs -----------------------------------------------------------

# make_fake_cli <name> <log-file> — creates a stub <name> that records its argv
# to <log-file> and exits 0. Echoes the bin dir to prepend to PATH.
make_fake_cli() {
  local name="$1" logfile="$2"
  local bin
  bin=$(mktemp -d "${TMPDIR:-/tmp}/biblos-fakebin.XXXXXX")
  cat > "$bin/$name" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$logfile"
echo "fake-$name-ok"
exit 0
EOF
  chmod +x "$bin/$name"
  FAKE_BINS+=("$bin")
  echo "$bin"
}

# make_toolbox <dir> — symlinks the standard tools the suite needs into <dir>.
# Lets tests control exactly which CLIs are "installed" (e.g. no claude).
make_toolbox() {
  local dir="$1"
  mkdir -p "$dir"
  local t
  for t in bash date dirname basename mkdir cp mv rm chmod touch cat jq openssl curl stat find head ls grep sed awk sort tail printf mktemp seq; do
    if command -v "$t" &>/dev/null; then
      ln -sf "$(command -v "$t")" "$dir/$t"
    fi
  done
}

# --- setup-biblos.sh runner ---------------------------------------------------

SETUP_RC=0
SETUP_OUT=""
SETUP_ERR=""

# run_setup <input-file> — runs the main script with stdin from <input-file>
run_setup() {
  local input="$1"
  SETUP_OUT=$(mktemp "${TMPDIR:-/tmp}/biblos-out.XXXXXX")
  SETUP_ERR=$(mktemp "${TMPDIR:-/tmp}/biblos-err.XXXXXX")
  "$TOOLS_DIR/setup-biblos.sh" < "$input" >"$SETUP_OUT" 2>"$SETUP_ERR"
  SETUP_RC=$?
}

# run_setup_flags <args...> — runs the main script non-interactively
run_setup_flags() {
  SETUP_OUT=$(mktemp "${TMPDIR:-/tmp}/biblos-out.XXXXXX")
  SETUP_ERR=$(mktemp "${TMPDIR:-/tmp}/biblos-err.XXXXXX")
  "$TOOLS_DIR/setup-biblos.sh" "$@" >"$SETUP_OUT" 2>"$SETUP_ERR"
  SETUP_RC=$?
}

# --- Finalize -----------------------------------------------------------------

finalize() {
  cleanup_all
  echo "RESULT $PASS_COUNT $FAIL_COUNT"
  [[ "$FAIL_COUNT" -eq 0 ]]
  exit $?
}

trap cleanup_all EXIT