#!/usr/bin/env bash
# =============================================================================
# Biblos Backup Library — backup/restore with validation
# =============================================================================
# Provides:
#   - create_backup: timestamped backup with permission enforcement
#   - restore_backup: validate before restoring
#   - validate_backup: check integrity before restore
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Backup naming: <config_path>.backup.<YYYYMMDD-HHMMSS>
# Tiebreaker: microseconds within same second
# ---------------------------------------------------------------------------

# Portable backup timestamp (NFR-001). The YYYYMMDD-HHMMSS base format is
# POSIX (GNU and BSD/macOS). GNU-only %N nanoseconds are appended when the
# platform supports them as a same-second tiebreaker (design edge case #3);
# on BSD/macOS the epoch seconds fallback keeps names unique across runs.
backup_timestamp() {
  local base nanos
  base=$(date '+%Y%m%d-%H%M%S')
  if nanos=$(date +%N 2>/dev/null) && [[ "$nanos" =~ ^[0-9]+$ ]]; then
    echo "${base}-${nanos}"
  else
    echo "${base}-$(date +%s)"
  fi
}

create_backup() {
  local config_file="$1"
  local backup_path

  # The config directory may not exist yet on first-time setup
  # (write_config creates it later) — the backup must still be creatable.
  mkdir -p "$(dirname "$config_file")"

  if [[ ! -f "$config_file" ]]; then
    # Nothing to back up — create empty backup for tracking
    backup_path="${config_file}.backup.$(backup_timestamp)"
    touch "$backup_path"
    chmod 600 "$backup_path"
    echo "$backup_path"
    return 0
  fi

  backup_path="${config_file}.backup.$(backup_timestamp)"
  cp "$config_file" "$backup_path"
  chmod 600 "$backup_path"
  echo "$backup_path"
}

# ---------------------------------------------------------------------------
# Validate backup before restore (REQ-011)
# ---------------------------------------------------------------------------

validate_backup() {
  local backup_path="$1"

  # 1. File exists
  if [[ ! -f "$backup_path" ]]; then
    log_error "Backup file not found: $backup_path"
    return 1
  fi

  # 2. Non-zero size
  if [[ ! -s "$backup_path" ]]; then
    log_error "Backup file is empty: $backup_path"
    return 1
  fi

  # 3. For JSON configs: validate with jq.
  #    Backups of JSON configs are named `<cfg>.json.backup.<ts>` — match both
  #    that canonical pattern and a plain `.json` file.
  if [[ "$backup_path" == *.json || "$backup_path" == *.json.backup.* ]]; then
    if ! jq empty "$backup_path" 2>/dev/null; then
      log_error "Backup file is not valid JSON: $backup_path"
      return 1
    fi
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Restore from backup
# ---------------------------------------------------------------------------

restore_backup() {
  local config_file="$1"
  local backup_path="$2"

  if ! validate_backup "$backup_path"; then
    log_error "Cannot restore: backup validation failed."
    return 1
  fi

  cp "$backup_path" "$config_file"
  chmod 600 "$config_file"
  log_info "Restored $config_file from $backup_path"
  return 0
}

# ---------------------------------------------------------------------------
# Cleanup old backups (optional, after 24h)
# ---------------------------------------------------------------------------

cleanup_old_backups() {
  local config_file="$1"
  local keep_hours="${2:-24}"

  local backup_pattern="${config_file}.backup.*"
  local cutoff_epoch
  cutoff_epoch=$(date -d "-${keep_hours} hours" +%s 2>/dev/null || echo "0")

  find "$(dirname "$config_file")" -name "$(basename "$backup_pattern")" -type f 2>/dev/null | while read -r backup; do
    local mtime_epoch
    mtime_epoch=$(stat -c %Y "$backup" 2>/dev/null || echo "0")
    if [[ "$mtime_epoch" -lt "$cutoff_epoch" ]]; then
      rm -f "$backup"
      log_info "Cleaned up old backup: $backup"
    fi
  done
}
