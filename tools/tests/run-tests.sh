#!/usr/bin/env bash
# =============================================================================
# Biblos setup tool — test harness (WU3: T016-T020)
# =============================================================================
# Runs every test file in tools/tests/ as its own process and aggregates the
# results. Zero external dependencies beyond bash and the standard tools
# (jq/openssl/curl; python3 optional — only used by the mock HTTP server).
#
# Usage:
#   ./run-tests.sh              Run the full suite
#   ./run-tests.sh unit         Run only unit test files
#   ./run-tests.sh integration  Run only integration.sh
#   ./run-tests.sh edge         Run only edge_cases.sh
#
# Exit code 0 when every test passes, 1 otherwise.
# =============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FILES=(unit_opencode.sh unit_openclaw.sh unit_claude_code.sh integration.sh edge_cases.sh)
FILTER="${1:-all}"

TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()
SKIPPED=()

for f in "${FILES[@]}"; do
  case "$FILTER" in
    all) ;;
    unit) [[ "$f" == unit_* ]] || continue ;;
    integration) [[ "$f" == integration.sh ]] || continue ;;
    edge) [[ "$f" == edge_cases.sh ]] || continue ;;
    *)
      echo "Unknown filter: $FILTER (use: all | unit | integration | edge)" >&2
      exit 2
      ;;
  esac

  if [[ ! -x "$SCRIPT_DIR/$f" ]]; then
    echo "WARN: test file missing or not executable: $f" >&2
    FAILED_FILES+=("$f (missing)")
    continue
  fi

  echo ""
  echo "===== $f ====="
  out=$("$SCRIPT_DIR/$f" 2>&1)
  rc=$?

  # Print test lines but keep the RESULT line for aggregation
  echo "$out" | grep -v '^RESULT'
  res=$(echo "$out" | grep '^RESULT' | tail -1)
  p=$(echo "$res" | awk '{print $2}')
  fa=$(echo "$res" | awk '{print $3}')

  if [[ -z "$res" ]]; then
    echo "  WARN: no RESULT line produced" >&2
    FAILED_FILES+=("$f")
    continue
  fi

  TOTAL_PASS=$((TOTAL_PASS + ${p:-0}))
  TOTAL_FAIL=$((TOTAL_FAIL + ${fa:-0}))
  if [[ "$rc" -ne 0 || "${fa:-0}" -gt 0 ]]; then
    FAILED_FILES+=("$f")
  fi
done

echo ""
echo "=================================================="
echo "TOTAL: $TOTAL_PASS passed, $TOTAL_FAIL failed"
if [[ ${#FAILED_FILES[@]} -gt 0 ]]; then
  echo "FAILED FILES: ${FAILED_FILES[*]}"
  exit 1
fi
echo "ALL TESTS PASSED"
exit 0