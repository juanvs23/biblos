#!/usr/bin/env bash
# =============================================================================
# Biblos Core Library — shared functions for setup-biblos.sh
# =============================================================================
# Provides:
#   - Logging (log_info, log_error, log_warn)
#   - Dependency checking (check_deps)
#   - API key generation (generate_key)
#   - Agent registration (register_agent)
#   - Curl helpers (curl_json)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Logging — all to stderr per NFR-003
# ---------------------------------------------------------------------------

log_info()  { echo "[$(date '+%H:%M:%S')] ℹ  $*" >&2; }
log_error() { echo "[$(date '+%H:%M:%S')] ❌ $*" >&2; }
log_warn()  { echo "[$(date '+%H:%M:%S')] ⚠  $*" >&2; }

# ---------------------------------------------------------------------------
# Dependency checking (REQ-014)
# ---------------------------------------------------------------------------

REQUIRED_DEPS=(jq openssl curl)

check_deps() {
  local missing=()
  for dep in "${REQUIRED_DEPS[@]}"; do
    if ! command -v "$dep" &>/dev/null; then
      missing+=("$dep")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "Missing required dependencies: ${missing[*]}"
    echo "" >&2
    echo "Install with:" >&2
    echo "  apt install jq openssl curl" >&2
    echo "  brew install jq openssl curl  (macOS)" >&2
    exit 1
  fi

  log_info "All dependencies found: ${REQUIRED_DEPS[*]}"
}

# ---------------------------------------------------------------------------
# API key generation (REQ-004)
# ---------------------------------------------------------------------------

generate_key() {
  local key
  key=$(openssl rand -hex 32 2>/dev/null) || {
    log_error "openssl rand failed — openssl may not be installed."
    exit 1
  }
  echo "$key"
}

# ---------------------------------------------------------------------------
# Agent registration (REQ-008) — best-effort, never blocks
# ---------------------------------------------------------------------------

register_agent() {
  local url="$1" name="$2" type="$3" key="$4"

  local status_code
  status_code=$(curl --silent --show-error --max-time 30 --write-out "%{http_code}" \
    -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $key" \
    -H "Origin: $url" \
    -H "X-Biblos-Agent: $name" \
    -d "$(jq -n --arg n "$name" --arg t "$type" \
       '{name:$n, type:$t, capabilities:["memory","graph","bus"]}')")

  if [[ "$status_code" == "201" || "$status_code" == "200" ]]; then
    log_info "Agent '$name' registered on server."
    return 0
  fi

  # Best-effort: log warning but do NOT fail the tool
  log_warn "Agent registration returned HTTP $status_code (best-effort, continuing)."
  return 0
}

# ---------------------------------------------------------------------------
# Curl JSON helper — wraps curl with standard headers (for adapter use)
# ---------------------------------------------------------------------------

curl_json() {
  local url="$1" method="${2:-GET}" key="$3" name="$4" body="${5:-}"

  local curl_args=(
    --silent --show-error --max-time 30
    -X "$method"
    -H "Content-Type: application/json"
    -H "Authorization: Bearer $key"
    -H "Origin: $url"
    -H "X-Biblos-Agent: $name"
  )

  if [[ -n "$body" ]]; then
    curl_args+=(-d "$body")
  fi

  curl "${curl_args[@]}" "$url"
}
