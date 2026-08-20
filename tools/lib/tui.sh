#!/usr/bin/env bash
# =============================================================================
# Biblos TUI Helpers — interactive prompts
# =============================================================================
# Provides:
#   - prompt_default: prompt with default value
#   - prompt_choice: numbered list selection
#   - prompt_confirm: yes/no confirmation
#   - display_key: secure one-time key display
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Prompt with default value (REQ-001)
# ---------------------------------------------------------------------------

prompt_default() {
  local prompt_text="$1"
  local default_value="${2:-}"
  local result

  if [[ -n "$default_value" ]]; then
    read -rp "${prompt_text} [${default_value}]: " result
    if [[ -z "$result" ]]; then
      result="$default_value"
    fi
  else
    read -rp "${prompt_text}: " result
  fi

  echo "$result"
}

# ---------------------------------------------------------------------------
# Prompt for numbered choice (REQ-003)
# ---------------------------------------------------------------------------

prompt_choice() {
  local prompt_text="$1"
  shift
  local choices=("$@")
  local result

  # Banner/list go to stderr (NFR-003): the ONLY stdout output is the
  # selected value, so callers can capture it via $(...) cleanly.
  echo "" >&2
  echo "$prompt_text" >&2
  for i in "${!choices[@]}"; do
    echo "  $((i + 1)). ${choices[$i]}" >&2
  done
  echo "" >&2

  while true; do
    local input
    read -rp "Select (1-${#choices[@]}): " input

    # Validate: must be integer in range
    if [[ "$input" =~ ^[0-9]+$ ]] && \
       [[ "$input" -ge 1 ]] && \
       [[ "$input" -le ${#choices[@]} ]]; then
      echo "${choices[$((input - 1))]}"
      return 0
    fi

    log_error "Invalid selection. Please enter a number between 1 and ${#choices[@]}."
  done
}

# ---------------------------------------------------------------------------
# Confirmation prompt (REQ-016)
# ---------------------------------------------------------------------------

prompt_confirm() {
  local prompt_text="$1"
  local result

  read -rp "${prompt_text} [y/N]: " result

  case "$result" in
    [yY]|[yY][eE][sS])
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Secret prompt (no echo) — for the shared server API key
# ---------------------------------------------------------------------------

prompt_secret() {
  local prompt_text="$1"
  local result
  read -rsp "${prompt_text}: " result
  echo "" >&2
  echo "$result"
}

# ---------------------------------------------------------------------------
# Display API key securely (REQ-004, REQ-013)
# ---------------------------------------------------------------------------

display_key() {
  local key="$1"
  echo "" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "🔑  API Key (displayed ONCE — save it now):" >&2
  echo "" >&2
  echo "  $key" >&2
  echo "" >&2
  echo "⚠   Never share this key. It grants access to your Biblos server." >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "" >&2
}

# ---------------------------------------------------------------------------
# URL validation (REQ-001)
# ---------------------------------------------------------------------------

validate_url() {
  local url="$1"

  # Must start with http:// or https://
  if [[ ! "$url" =~ ^https?:// ]]; then
    return 1
  fi

  # Must have a hostname (basic check)
  if [[ "$url" =~ ^https?://$ ]]; then
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Agent name validation (REQ-002)
# ---------------------------------------------------------------------------

validate_agent_name() {
  local name="$1"

  # Length check: 3-32 characters
  if [[ ${#name} -lt 3 ]] || [[ ${#name} -gt 32 ]]; then
    return 1
  fi

  # Alphanumeric and hyphens only
  if [[ ! "$name" =~ ^[a-zA-Z0-9-]+$ ]]; then
    return 1
  fi

  return 0
}
