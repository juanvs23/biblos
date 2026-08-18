#!/usr/bin/env bash
# =============================================================================
# Claude Code Adapter
# =============================================================================
# Uses `claude mcp add` CLI to register Biblos server. No config file.
#
# Interface:
#   backup_config()    → no-op for Claude Code, exits 0
#   write_config URL NAME KEY → exits 0/1
#   smoke_test URL NAME KEY → exits 0/1
#   restore_config()   → no-op for Claude Code, exits 0
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# backup_config — no file to back up
# ---------------------------------------------------------------------------

backup_config() {
  log_info "Claude Code: no config file to back up (uses CLI)."
  echo ""
  return 0
}

# ---------------------------------------------------------------------------
# write_config (REQ-007)
# ---------------------------------------------------------------------------

write_config() {
  local url="$1"
  local name="$2"
  local key="$3"

  # Check if claude CLI is installed
  if ! command -v claude &>/dev/null; then
    log_info "Claude Code CLI not installed — skipping config write."
    log_info "To install: brew install anthropic/claude-code/claude"
    return 0
  fi

  # Run claude mcp add (idempotent)
  log_info "Running: claude mcp add --transport http biblos..."
  claude mcp add --transport http biblos "$url" \
    --header "Authorization: Bearer $key" \
    --header "Origin: $url" \
    --header "X-Biblos-Agent: $name" 2>&1 | while read -r line; do
      log_info "claude: $line"
  done

  log_info "Claude Code config written via CLI."
  return 0
}

# ---------------------------------------------------------------------------
# smoke_test
# ---------------------------------------------------------------------------

smoke_test() {
  local url="$1"
  local name="$2"
  local key="$3"

  local status_code
  status_code=$(curl --silent --show-error --max-time 30 --write-out "%{http_code}" \
    -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $key" \
    -H "Origin: $url" \
    -H "X-Biblos-Agent: $name" \
    -d '{"jsonrpc":"2.0","method":"initialize","id":1}')

  if [[ "$status_code" != "200" && "$status_code" != "202" ]]; then
    log_error "Claude Code smoke test failed: HTTP $status_code"
    return 1
  fi

  log_info "Claude Code smoke test passed (HTTP $status_code)."
  return 0
}

# ---------------------------------------------------------------------------
# restore_config — no file to restore
# ---------------------------------------------------------------------------

restore_config() {
  log_info "Claude Code: no config file to restore (uses CLI)."
  return 0
}

# ---------------------------------------------------------------------------
# cleanup_backup — no backup to clean
# ---------------------------------------------------------------------------

cleanup_backup() {
  log_info "Claude Code: no backup to clean up."
  return 0
}
