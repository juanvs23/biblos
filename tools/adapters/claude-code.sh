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
    --header "Origin: $(origin_of "$url")" \
    --header "X-Biblos-Agent: $name" 2>&1 | while read -r line; do
      log_info "claude: $line"
  done

  log_info "Claude Code config written via CLI."
  return 0
}

# ---------------------------------------------------------------------------
# smoke_test — delegates to shared smoke_test_curl (core.sh)
# ---------------------------------------------------------------------------

smoke_test() {
  local url="$1"
  local name="$2"
  local key="$3"

  if smoke_test_curl "$url" "$name" "$key" "Claude Code"; then
    log_info "Claude Code smoke test passed."
    return 0
  fi
  return 1
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
