#!/usr/bin/env bash
# =============================================================================
# Biblos Multi-Agent Client Setup
# =============================================================================
# Automates connecting MCP clients (OpenCode, OpenClaw, Claude Code) to a
# self-hosted Biblos MCP server.
#
# Usage:
#   ./setup-biblos.sh              Interactive setup
#   ./setup-biblos.sh --help       Show usage
#   ./setup-biblos.sh --restore <config> <backup>  Restore from backup
#
# Dependencies: bash, jq, openssl, curl
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/lib"
ADAPTERS_DIR="${SCRIPT_DIR}/adapters"

# ---------------------------------------------------------------------------
# Source libraries
# ---------------------------------------------------------------------------

source "${LIB_DIR}/core.sh"
source "${LIB_DIR}/backup.sh"
source "${LIB_DIR}/tui.sh"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_URL="https://biblos.coltmandev.dev/mcp"
SUPPORTED_AGENTS=("opencode" "openclaw" "claude-code")

# Adapter registry: name:file_path
ADAPTERS=(
  "opencode:${ADAPTERS_DIR}/opencode.sh"
  "openclaw:${ADAPTERS_DIR}/openclaw.sh"
  "claude-code:${ADAPTERS_DIR}/claude-code.sh"
)

# ---------------------------------------------------------------------------
# Adapter lookup (T014 — REQ-015)
# Returns the file path for a given agent type, or exits 1 if not found.
# ---------------------------------------------------------------------------

get_adapter_file() {
  local agent_type="$1"
  for entry in "${ADAPTERS[@]}"; do
    local name="${entry%%:*}"
    local file="${entry#*:}"
    if [[ "$name" == "$agent_type" ]]; then
      echo "$file"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Config file path per agent type (T015)
# Claude Code has no config file — returns empty string.
# ---------------------------------------------------------------------------

get_config_file() {
  local agent_type="$1"
  case "$agent_type" in
    opencode)    echo "$HOME/.config/opencode/opencode.json" ;;
    openclaw)    echo "$HOME/.openclaw/openclaw.json" ;;
    claude-code) echo "" ;;
    *)           echo "" ;;
  esac
}

# ---------------------------------------------------------------------------
# Exit codes (NFR-004)
# ---------------------------------------------------------------------------

EXIT_SUCCESS=0
EXIT_ROLLBACK=1
EXIT_CONFIG_ERROR=2
EXIT_NETWORK_ERROR=3

# ---------------------------------------------------------------------------
# Trap handlers (NFR-004)
# ---------------------------------------------------------------------------

TMPFILE="${SCRIPT_DIR}/.tmp_setup"
trap '[[ -f "$TMPFILE" ]] && rm -f "$TMPFILE"' EXIT

cleanup() {
  log_info "Cleaning up..."
  [[ -f "$TMPFILE" ]] && rm -f "$TMPFILE" || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Flag parsing
# ---------------------------------------------------------------------------

show_help() {
  cat <<EOF
Biblos Multi-Agent Client Setup

Usage:
  $(basename "$0") [OPTIONS]

Options:
  --help            Show this help message
  --restore <cfg> <backup>  Restore a config from backup (non-interactive)

Description:
  Automates connecting MCP clients (OpenCode, OpenClaw, Claude Code) to a
  self-hosted Biblos MCP server. Generates API keys, writes configs, and
  runs smoke tests.

Dependencies:
  bash, jq, openssl, curl

Example:
  $(basename "$0")
  $(basename "$0") --restore ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.backup.20260818-143022
EOF
  exit 0
}

restore_mode() {
  local config_file="$1"
  local backup_file="$2"

  if [[ -z "$config_file" || -z "$backup_file" ]]; then
    log_error "Usage: $0 --restore <config_file> <backup_file>"
    exit 1
  fi

  log_info "Restoring $config_file from $backup_file..."

  if validate_backup "$backup_file"; then
    restore_backup "$config_file" "$backup_file"
    log_info "✅ Restore complete."
  else
    log_error "❌ Restore failed: backup validation failed."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

main() {
  # Parse flags
  if [[ $# -gt 0 ]]; then
    case "$1" in
      --help)
        show_help
        ;;
      --restore)
        shift
        restore_mode "$@"
        exit $?
        ;;
      *)
        log_error "Unknown flag: $1"
        echo "Run '$(basename "$0") --help' for usage." >&2
        exit 1
        ;;
    esac
  fi

  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  Biblos Multi-Agent Client Setup"
  echo "═══════════════════════════════════════════════════════"
  echo ""

  # Step 0: Check dependencies
  echo "--- Step 0 of 7: Checking dependencies ---"
  check_deps
  echo ""

  # Step 1: Prompt for server URL (REQ-001)
  echo "--- Step 1 of 7: Server URL ---"
  local url
  while true; do
    url=$(prompt_default "Biblos server URL" "$DEFAULT_URL")
    if validate_url "$url"; then
      log_info "Server URL: $url"
      break
    else
      log_error "Invalid URL. Must start with http:// or https:// and have a hostname."
    fi
  done
  echo ""

  # Step 2: Prompt for agent name (REQ-002)
  echo "--- Step 2 of 7: Agent Name ---"
  local agent_name
  while true; do
    agent_name=$(prompt_default "Agent name (alphanumeric + hyphens, 3-32 chars)" "")
    if validate_agent_name "$agent_name"; then
      log_info "Agent name: $agent_name"
      break
    else
      log_error "Invalid agent name. Must be 3-32 alphanumeric characters or hyphens."
    fi
  done
  echo ""

  # Step 3: Agent type selection (REQ-003)
  echo "--- Step 3 of 7: Agent Type ---"
  local agent_type
  agent_type=$(prompt_choice "Select agent type:" "${SUPPORTED_AGENTS[@]}")
  log_info "Agent type: $agent_type"
  echo ""

  # Step 4: Generate API key (REQ-004)
  echo "--- Step 4 of 7: Generate API Key ---"
  local api_key
  api_key=$(generate_key)
  display_key "$api_key"
  echo ""

  # Step 5: Confirmation (REQ-016)
  echo "--- Step 5 of 7: Confirm ---"
  if ! prompt_confirm "Apply configuration for '$agent_name' ($agent_type)?"; then
    log_info "Cancelled by user."
    exit 1
  fi
  echo ""

  # Step 6: Source adapter and run flow
  echo "--- Step 6 of 7: Apply Configuration ---"

  # Look up adapter file via registry (T014)
  local adapter_file
  adapter_file=$(get_adapter_file "$agent_type")
  local lookup_rc=$?

  if [[ $lookup_rc -ne 0 ]] || [[ -z "$adapter_file" ]]; then
    log_error "Unknown agent type: $agent_type"
    exit $EXIT_CONFIG_ERROR
  fi

  if [[ ! -f "$adapter_file" ]]; then
    log_error "Adapter file not found: $adapter_file"
    exit $EXIT_CONFIG_ERROR
  fi

  # Source the adapter
  source "$adapter_file"
  log_info "Loaded adapter: $adapter_file"

  # Determine config file path for this adapter (T015)
  local config_file
  config_file=$(get_config_file "$agent_type")

  # Track rollback state for summary
  local rollback_occurred="no"
  local backup_path=""

  # Backup + Write + Smoke test + Rollback flow (T015 — REQ-011)
  if [[ -n "$config_file" ]]; then
    # --- Config-file agents (OpenCode, OpenClaw) ---
    log_info "Creating backup..."
    backup_path=$(create_backup "$config_file")
    log_info "Backup created: $backup_path"

    # Write config
    log_info "Writing configuration..."
    if ! write_config "$url" "$agent_name" "$api_key"; then
      log_error "❌ Failed to write config."
      exit $EXIT_CONFIG_ERROR
    fi
    log_info "✅ Config written successfully."

    # Smoke test
    log_info "Running smoke test..."
    if smoke_test "$url" "$agent_name" "$api_key"; then
      log_info "✅ Smoke test passed."

      # Register agent (best-effort, non-blocking)
      log_info "Registering agent on server..."
      register_agent "$url" "$agent_name" "$agent_type" "$api_key"
    else
      # Smoke test failure → rollback (REQ-011)
      log_error "❌ Smoke test failed. Restoring backup..."
      if restore_backup "$config_file" "$backup_path"; then
        rollback_occurred="yes"
        log_info "Restored from $backup_path"
      else
        log_error "Critical: rollback also failed!"
      fi
      exit $EXIT_ROLLBACK
    fi
  else
    # --- CLI-only agent (Claude Code) — no config file, no backup ---
    log_info "Writing configuration via CLI..."
    if ! write_config "$url" "$agent_name" "$api_key"; then
      log_error "❌ Failed to write config."
      exit $EXIT_CONFIG_ERROR
    fi
    log_info "✅ Config written successfully."

    # Smoke test
    log_info "Running smoke test..."
    if smoke_test "$url" "$agent_name" "$api_key"; then
      log_info "✅ Smoke test passed."

      # Register agent (best-effort, non-blocking)
      log_info "Registering agent on server..."
      register_agent "$url" "$agent_name" "$agent_type" "$api_key"
    else
      log_error "❌ Smoke test failed."
      exit $EXIT_NETWORK_ERROR
    fi
  fi

  # Step 7: Summary (REQ-018)
  echo ""
  echo "--- Step 7 of 7: Summary ---"
  echo "✅ Configuration complete!"
  echo "   Server: $url"
  echo "   Agent:  $agent_name"
  echo "   Type:   $agent_type"
  if [[ -n "$config_file" ]]; then
    echo "   Config: $config_file"
    echo "   Backup: $backup_path"
  fi
  if [[ "$rollback_occurred" == "yes" ]]; then
    echo ""
    echo "⚠️  Rollback was performed. Config restored from backup."
  fi
  echo ""
  echo "🔑 Save your API key (shown above). It won't be displayed again."
  echo ""
}

main "$@"
