#!/usr/bin/env bash
# =============================================================================
# OpenCode Adapter
# =============================================================================
# Writes Biblos MCP config to ~/.config/opencode/opencode.json via jq.
#
# Interface:
#   backup_config()    → prints backup path, exits 0/1
#   write_config URL NAME KEY → exits 0/1
#   smoke_test URL NAME KEY → exits 0/1
#   restore_config()   → exits 0/1
# =============================================================================

set -euo pipefail

OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"

# ---------------------------------------------------------------------------
# backup_config
# ---------------------------------------------------------------------------

backup_config() {
  mkdir -p "$(dirname "$OPENCODE_CONFIG")"

  if [[ ! -f "$OPENCODE_CONFIG" ]]; then
    # Create empty backup for tracking
    local backup_path="${OPENCODE_CONFIG}.backup.$(backup_timestamp)"
    touch "$backup_path"
    chmod 600 "$backup_path"
    echo "$backup_path"
    return 0
  fi

  local backup_path
  backup_path=$(create_backup "$OPENCODE_CONFIG")
  echo "$backup_path"
}

# ---------------------------------------------------------------------------
# write_config (REQ-005)
# ---------------------------------------------------------------------------

write_config() {
  local url="$1"
  local name="$2"
  local key="$3"

  # Ensure config directory exists
  mkdir -p "$(dirname "$OPENCODE_CONFIG")"

  # Create empty config if it doesn't exist or is empty (REQ-005:
  # "creates file if it does not exist" — an empty file has no content
  # to preserve, so initialize it with the default empty JSON).
  if [[ ! -f "$OPENCODE_CONFIG" || ! -s "$OPENCODE_CONFIG" ]]; then
    echo '{}' > "$OPENCODE_CONFIG"
    chmod 600 "$OPENCODE_CONFIG"
  fi

  # Write Biblos entry via jq (atomic, preserves existing entries)
  # `if !` form: under `set -e` the old `if [[ $? -ne 0 ]]` guard was dead
  # code — a failing jq aborted the function before cleanup could run.
  local tmp_file="${OPENCODE_CONFIG}.tmp"
  if ! jq --arg url "$url" \
     --arg key "$key" \
     --arg name "$name" \
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
     }' "$OPENCODE_CONFIG" > "$tmp_file"; then
    log_error "jq failed to write OpenCode config."
    rm -f "$tmp_file"
    return 1
  fi

  mv "$tmp_file" "$OPENCODE_CONFIG"
  chmod 600 "$OPENCODE_CONFIG"

  log_info "OpenCode config written to $OPENCODE_CONFIG"
  return 0
}

# ---------------------------------------------------------------------------
# smoke_test — delegates to shared smoke_test_curl (core.sh)
# ---------------------------------------------------------------------------

smoke_test() {
  local url="$1"
  local name="$2"
  local key="$3"

  if smoke_test_curl "$url" "$name" "$key" "OpenCode"; then
    log_info "OpenCode smoke test passed."
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# restore_config
# ---------------------------------------------------------------------------

restore_config() {
  if [[ ! -f "$OPENCODE_CONFIG" ]]; then
    log_warn "No config file to restore: $OPENCODE_CONFIG"
    return 0
  fi

  # Find most recent backup
  local backup_path
  backup_path=$(ls -t "${OPENCODE_CONFIG}".backup.* 2>/dev/null | head -1)

  if [[ -z "$backup_path" ]]; then
    log_error "No backup found for $OPENCODE_CONFIG"
    return 1
  fi

  restore_backup "$OPENCODE_CONFIG" "$backup_path"
}

# ---------------------------------------------------------------------------
# cleanup_backup (optional)
# ---------------------------------------------------------------------------

cleanup_backup() {
  local backup_path="${1:-}"
  if [[ -n "$backup_path" && -f "$backup_path" ]]; then
    rm -f "$backup_path"
    log_info "Cleaned up backup: $backup_path"
  fi
}
