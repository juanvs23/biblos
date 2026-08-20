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
  mkdir -p "$(dirname "$OPENCLAW_CONFIG")"

  if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
    local backup_path="${OPENCLAW_CONFIG}.backup.$(backup_timestamp)"
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

  # Create empty config if it doesn't exist or is empty (REQ-006)
  if [[ ! -f "$OPENCLAW_CONFIG" || ! -s "$OPENCLAW_CONFIG" ]]; then
    echo '{}' > "$OPENCLAW_CONFIG"
    chmod 600 "$OPENCLAW_CONFIG"
  fi

  # Write Biblos entry via jq (atomic, preserves existing entries).
  # OpenClaw 2026.7 expects `transport` (not the legacy `type`), and the
  # Authorization Bearer key is referenced via env-var substitution
  # `${BIBLOS_API_KEY}`, which OpenClaw resolves from its environment (global
  # `~/.openclaw/.env` or `env.vars`). The key value is stored separately below.
  # `if !` form: under `set -e` the old `if [[ $? -ne 0 ]]` guard was dead
  # code — a failing jq aborted the function before cleanup could run.
  local tmp_file="${OPENCLAW_CONFIG}.tmp"
  if ! jq --arg url "$url" \
     --arg name "$name" \
     --arg origin "$(origin_of "$url")" \
     '.mcp.servers.biblos = {
       transport: "streamable-http",
       url: $url,
       enabled: true,
       headers: {
         "Origin": $origin,
         "X-Biblos-Agent": $name,
         "Authorization": "Bearer ${BIBLOS_API_KEY}"
       }
     }' "$OPENCLAW_CONFIG" > "$tmp_file"; then
    log_error "jq failed to write OpenClaw config."
    rm -f "$tmp_file"
    return 1
  fi

  mv "$tmp_file" "$OPENCLAW_CONFIG"
  chmod 600 "$OPENCLAW_CONFIG"

  # Store BIBLOS_API_KEY in OpenClaw's global env file so `${BIBLOS_API_KEY}`
  # in the MCP header resolves. OpenClaw 2026.7 has no `openclaw secrets set`;
  # the supported path for an MCP header secret is env-var substitution.
  local env_file="$HOME/.openclaw/.env"
  if [[ ! -f "$env_file" ]]; then
    touch "$env_file"
    chmod 600 "$env_file"
  fi
  # Remove any existing BIBLOS_API_KEY line, then append the fresh value.
  if grep -q '^BIBLOS_API_KEY=' "$env_file" 2>/dev/null; then
    grep -v '^BIBLOS_API_KEY=' "$env_file" > "$env_file.tmp" 2>/dev/null || true
    mv "$env_file.tmp" "$env_file"
  fi
  printf 'BIBLOS_API_KEY=%s\n' "$key" >> "$env_file"
  chmod 600 "$env_file"

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
