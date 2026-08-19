#!/usr/bin/env bash
# =============================================================================
# OpenClaw Adapter
# =============================================================================
# Writes Biblos MCP config to ~/.openclaw/openclaw.json via jq + secret store.
#
# Interface:
#   backup_config()    → prints backup path, exits 0/1
#   write_config URL NAME KEY → exits 0/1
#   smoke_test URL NAME KEY → exits 0/1
#   restore_config()   → exits 0/1
# =============================================================================

set -euo pipefail

OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

# ---------------------------------------------------------------------------
# backup_config
# ---------------------------------------------------------------------------

backup_config() {
  if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
    local backup_path="${OPENCLAW_CONFIG}.backup.$(date '+%Y%m%d-%H%M%S%N')"
    touch "$backup_path"
    chmod 600 "$backup_path"
    echo "$backup_path"
    return 0
  fi

  local backup_path
  backup_path=$(create_backup "$OPENCLAW_CONFIG")
  echo "$backup_path"
}

# ---------------------------------------------------------------------------
# write_config (REQ-006)
# ---------------------------------------------------------------------------

write_config() {
  local url="$1"
  local name="$2"
  local key="$3"

  # Ensure config directory exists
  mkdir -p "$(dirname "$OPENCLAW_CONFIG")"

  # Create empty config if it doesn't exist
  if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
    echo '{}' > "$OPENCLAW_CONFIG"
    chmod 600 "$OPENCLAW_CONFIG"
  fi

  # Write Biblos entry via jq (atomic, preserves existing entries)
  # Note: Authorization header is injected by OpenClaw runtime via secret store,
  # not written inline. The script only writes the server config block.
  local tmp_file="${OPENCLAW_CONFIG}.tmp"
  jq --arg url "$url" \
     --arg name "$name" \
     '.mcp.servers.biblos = {
       type: "streamable-http",
       url: $url,
       enabled: true,
       headers: {
         "Origin": $url,
         "X-Biblos-Agent": $name
       }
     }' "$OPENCLAW_CONFIG" > "$tmp_file"

  if [[ $? -ne 0 ]]; then
    log_error "jq failed to write OpenClaw config."
    rm -f "$tmp_file"
    return 1
  fi

  mv "$tmp_file" "$OPENCLAW_CONFIG"
  chmod 600 "$OPENCLAW_CONFIG"

  # Inject API key into OpenClaw's secret store (REQ-006)
  if command -v openclaw &>/dev/null; then
    openclaw secrets set BIBLOS_API_KEY "$key" 2>/dev/null || {
      log_warn "Failed to set BIBLOS_API_KEY in OpenClaw secret store."
      log_warn "You may need to set it manually: openclaw secrets set BIBLOS_API_KEY <key>"
    }
  else
    log_warn "openclaw CLI not found — skipping secret store injection."
    log_warn "Set BIBLOS_API_KEY manually or install openclaw CLI."
  fi

  log_info "OpenClaw config written to $OPENCLAW_CONFIG"
  return 0
}

# ---------------------------------------------------------------------------
# smoke_test — delegates to shared smoke_test_curl (core.sh)
# ---------------------------------------------------------------------------

smoke_test() {
  local url="$1"
  local name="$2"
  local key="$3"

  if smoke_test_curl "$url" "$name" "$key" "OpenClaw"; then
    log_info "OpenClaw smoke test passed."
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# restore_config
# ---------------------------------------------------------------------------

restore_config() {
  if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
    log_warn "No config file to restore: $OPENCLAW_CONFIG"
    return 0
  fi

  local backup_path
  backup_path=$(ls -t "${OPENCLAW_CONFIG}".backup.* 2>/dev/null | head -1)

  if [[ -z "$backup_path" ]]; then
    log_error "No backup found for $OPENCLAW_CONFIG"
    return 1
  fi

  restore_backup "$OPENCLAW_CONFIG" "$backup_path"
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
