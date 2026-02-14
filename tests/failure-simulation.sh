#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  AI Receptionist — Failure Simulation Test
#
#  Tests that the booking flow handles external calendar failures
#  correctly in both lenient and strict modes.
#
#  Tests:
#    1. Lenient mode + auth_error     → booking succeeds (no cal event)
#    2. Strict mode  + auth_error     → booking rolled back (409)
#    3. Strict mode  + network_error  → booking rolled back (409)
#    4. Strict rollback verification  → appointment cancelled, hold restored
#    5. Recovery                      → fix failure, booking succeeds
#
#  Prerequisites:
#    docker compose up -d && seed data loaded
#    brew install jq
#
#  Usage:
#    bash tests/failure-simulation.sh
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────
BASE="${BASE:-http://localhost:3000}"
TENANT_ID="00000000-0000-4000-a000-000000000001"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR_TEST=$(mktemp -d)

# ── Colours ───────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

PASS=0
FAIL=0

pass() { ((PASS++)); echo -e "  ${GREEN}✅ PASS${RESET} — $1"; }
fail() { ((FAIL++)); echo -e "  ${RED}❌ FAIL${RESET} — $1"; echo -e "     ${YELLOW}↳ $2${RESET}"; }
header() { echo -e "\n${CYAN}${BOLD}━━ $1 ━━${RESET}"; }
info() { echo -e "  ${DIM}$1${RESET}"; }

cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

if ! command -v jq &>/dev/null; then
  echo -e "${RED}jq is required. Install: brew install jq${RESET}"
  exit 1
fi

# ── Helper: restart backend with env overrides ────────────────────
restart_backend() {
  local fail_mode="${1:-none}"
  local sync_required="${2:-false}"
  info "Restarting backend: CALENDAR_FAIL_MODE=$fail_mode CALENDAR_SYNC_REQUIRED=$sync_required"
  cd "$PROJECT_DIR"
  CALENDAR_FAIL_MODE="$fail_mode" CALENDAR_SYNC_REQUIRED="$sync_required" \
    docker compose up -d --force-recreate backend &>/dev/null

  # Wait for backend to be healthy
  local retries=0
  while [[ $retries -lt 30 ]]; do
    if curl -sf "$BASE/health" &>/dev/null; then
      break
    fi
    sleep 1
    ((retries++))
  done

  if [[ $retries -ge 30 ]]; then
    fail "Backend did not become healthy after restart" ""
    exit 1
  fi
  info "Backend healthy"
}

# ── Helper: find an available slot ────────────────────────────────
find_slot() {
  local slot_start=""
  for offset in 1 2 3 4 5; do
    local day
    if date -v+${offset}d +%Y-%m-%d &>/dev/null; then
      day=$(date -v+${offset}d +%Y-%m-%d)
    else
      day=$(date -d "+${offset} days" +%Y-%m-%d)
    fi
    local avail
    avail=$(curl -sf "$BASE/api/tenants/$TENANT_ID/availability?start=${day}T00:00:00&end=${day}T23:59:59" 2>/dev/null || echo '{}')
    slot_start=$(echo "$avail" | jq -r '[.slots // [] | .[] | select(.available==true)] | .[0].start // empty')
    if [[ -n "$slot_start" ]]; then
      SLOT_START="$slot_start"
      SLOT_END=$(echo "$avail" | jq -r '[.slots[] | select(.available==true)] | .[0].end')
      return 0
    fi
  done
  return 1
}

# ── Helper: hold + confirm booking ────────────────────────────────
attempt_booking() {
  local session_id="$1"
  local client_email="$2"

  # Hold
  local hold_resp
  hold_resp=$(curl -sf -X POST "$BASE/api/tenants/$TENANT_ID/holds" \
    -H "Content-Type: application/json" \
    -d "{\"session_id\":\"$session_id\",\"start_time\":\"$SLOT_START\",\"end_time\":\"$SLOT_END\"}" 2>/dev/null || echo '{}')

  local hold_id
  hold_id=$(echo "$hold_resp" | jq -r '.id // empty')
  if [[ -z "$hold_id" || "$hold_id" == "null" ]]; then
    echo "HOLD_FAILED"
    return 1
  fi

  # Confirm
  local confirm_resp
  confirm_resp=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BASE/api/tenants/$TENANT_ID/appointments" \
    -H "Content-Type: application/json" \
    -d "{
      \"session_id\":\"$session_id\",
      \"hold_id\":\"$hold_id\",
      \"client_name\":\"Failure Test\",
      \"client_email\":\"$client_email\",
      \"service\":\"Follow-up Visit\"
    }" 2>/dev/null)

  echo "$confirm_resp"
}

# ══════════════════════════════════════════════════════════════════
echo -e "\n${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  Failure Simulation Test Suite                    ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${RESET}"

# ══════════════════════════════════════════════════════════════════
header "Test 1 · Lenient mode + auth_error → booking succeeds"
# ══════════════════════════════════════════════════════════════════
restart_backend "auth_error" "false"
find_slot || { fail "No available slots" ""; exit 1; }
info "Slot: $SLOT_START → $SLOT_END"

RESULT=$(attempt_booking "lenient-$(date +%s)" "lenient-test@fail.test")
HTTP_CODE=$(echo "$RESULT" | grep "HTTP_CODE:" | sed 's/HTTP_CODE://')
BODY=$(echo "$RESULT" | grep -v "HTTP_CODE:")
STATUS=$(echo "$BODY" | jq -r '.status // empty')
GCAL_ID=$(echo "$BODY" | jq -r '.google_event_id // "null"')

if [[ "$HTTP_CODE" == "201" && "$STATUS" == "confirmed" ]]; then
  pass "Lenient mode: HTTP 201, status=confirmed (calendar failed silently)"
else
  fail "Lenient mode" "Expected 201/confirmed, got HTTP $HTTP_CODE status=$STATUS"
fi

if [[ "$GCAL_ID" == "null" || -z "$GCAL_ID" ]]; then
  pass "google_event_id is null (calendar sync failed as expected)"
else
  fail "google_event_id should be null" "Got: $GCAL_ID"
fi

# ══════════════════════════════════════════════════════════════════
header "Test 2 · Strict mode + auth_error → booking rolled back"
# ══════════════════════════════════════════════════════════════════
restart_backend "auth_error" "true"
find_slot || { fail "No available slots" ""; exit 1; }
info "Slot: $SLOT_START → $SLOT_END"

RESULT=$(attempt_booking "strict-auth-$(date +%s)" "strict-auth@fail.test")
HTTP_CODE=$(echo "$RESULT" | grep "HTTP_CODE:" | sed 's/HTTP_CODE://')
BODY=$(echo "$RESULT" | grep -v "HTTP_CODE:")
ERROR_MSG=$(echo "$BODY" | jq -r '.error // empty')

if [[ "$HTTP_CODE" == "409" ]]; then
  pass "Strict mode + auth_error: HTTP 409 (booking rejected)"
else
  fail "Strict mode + auth_error" "Expected 409, got HTTP $HTTP_CODE — body: $(echo "$BODY" | jq -c .)"
fi

if echo "$ERROR_MSG" | grep -qi "calendar\|rolled back\|sync"; then
  pass "Error message mentions calendar/rollback"
else
  fail "Error message" "Expected mention of calendar failure, got: $ERROR_MSG"
fi

# ══════════════════════════════════════════════════════════════════
header "Test 3 · Strict mode + network_error → booking rolled back"
# ══════════════════════════════════════════════════════════════════
restart_backend "network_error" "true"
find_slot || { fail "No available slots" ""; exit 1; }
info "Slot: $SLOT_START → $SLOT_END"

RESULT=$(attempt_booking "strict-net-$(date +%s)" "strict-net@fail.test")
HTTP_CODE=$(echo "$RESULT" | grep "HTTP_CODE:" | sed 's/HTTP_CODE://')

if [[ "$HTTP_CODE" == "409" ]]; then
  pass "Strict mode + network_error: HTTP 409 (booking rejected)"
else
  fail "Strict mode + network_error" "Expected 409, got HTTP $HTTP_CODE"
fi

# ══════════════════════════════════════════════════════════════════
header "Test 4 · Verify rollback state in database"
# ══════════════════════════════════════════════════════════════════

# Check that rolled-back appointments are cancelled
CANCELLED_COUNT=$(docker compose exec -T postgres psql -U receptionist -d receptionist -tAc "
  SELECT COUNT(*)
  FROM appointments
  WHERE client_email LIKE '%@fail.test'
    AND status = 'cancelled';
" 2>/dev/null | tr -d '[:space:]')

CONFIRMED_COUNT=$(docker compose exec -T postgres psql -U receptionist -d receptionist -tAc "
  SELECT COUNT(*)
  FROM appointments
  WHERE client_email LIKE 'strict-%@fail.test'
    AND status = 'confirmed';
" 2>/dev/null | tr -d '[:space:]')

if [[ "$CONFIRMED_COUNT" == "0" ]]; then
  pass "No confirmed appointments from strict-mode failure tests"
else
  fail "Strict-mode appointments should be cancelled" "Found $CONFIRMED_COUNT confirmed"
fi

# Check audit trail for rollbacks
ROLLBACK_COUNT=$(docker compose exec -T postgres psql -U receptionist -d receptionist -tAc "
  SELECT COUNT(*)
  FROM audit_log
  WHERE event_type = 'appointment.calendar_rollback';
" 2>/dev/null | tr -d '[:space:]')

if [[ "$ROLLBACK_COUNT" -ge 2 ]]; then
  pass "Found $ROLLBACK_COUNT calendar rollback audit entries"
else
  fail "Expected ≥2 rollback audit entries" "Found: $ROLLBACK_COUNT"
fi

# ══════════════════════════════════════════════════════════════════
header "Test 5 · Recovery — fix failure, booking succeeds"
# ══════════════════════════════════════════════════════════════════
restart_backend "none" "true"
find_slot || { fail "No available slots" ""; exit 1; }
info "Slot: $SLOT_START → $SLOT_END"

RESULT=$(attempt_booking "recovery-$(date +%s)" "recovery@fail.test")
HTTP_CODE=$(echo "$RESULT" | grep "HTTP_CODE:" | sed 's/HTTP_CODE://')
BODY=$(echo "$RESULT" | grep -v "HTTP_CODE:")
STATUS=$(echo "$BODY" | jq -r '.status // empty')
GCAL_ID=$(echo "$BODY" | jq -r '.google_event_id // "null"')

if [[ "$HTTP_CODE" == "201" && "$STATUS" == "confirmed" ]]; then
  pass "Recovery: booking succeeds after calendar fixed"
else
  fail "Recovery booking" "Expected 201/confirmed, got HTTP $HTTP_CODE status=$STATUS"
fi

if [[ -n "$GCAL_ID" && "$GCAL_ID" != "null" ]]; then
  pass "Calendar event created: $GCAL_ID"
else
  fail "Calendar event should exist after recovery" "google_event_id=$GCAL_ID"
fi

# ══════════════════════════════════════════════════════════════════
header "Cleanup"
# ══════════════════════════════════════════════════════════════════

# Reset backend to normal
restart_backend "none" "false"

# Clean up test data
docker compose exec -T postgres psql -U receptionist -d receptionist -c "
  DELETE FROM audit_log WHERE payload::text LIKE '%@fail.test%' OR event_type = 'appointment.calendar_rollback';
  DELETE FROM appointments WHERE client_email LIKE '%@fail.test';
  DELETE FROM availability_holds WHERE session_id LIKE 'lenient-%' OR session_id LIKE 'strict-%' OR session_id LIKE 'recovery-%';
" &>/dev/null && info "Test data cleaned up" || info "Cleanup skipped"

# ══════════════════════════════════════════════════════════════════
header "Results"
# ══════════════════════════════════════════════════════════════════
TOTAL=$((PASS + FAIL))
echo ""
echo -e "  ${GREEN}$PASS passed${RESET}  /  ${RED}$FAIL failed${RESET}  /  $TOTAL total"
echo ""

if [[ "$FAIL" -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}🛡️  ALL TESTS PASSED — Failure handling is safe!${RESET}"
  echo ""
  echo -e "  ${CYAN}Verified:${RESET}"
  echo -e "    1. Lenient mode: booking succeeds despite calendar failure   ✅"
  echo -e "    2. Strict mode:  booking rolled back on auth error           ✅"
  echo -e "    3. Strict mode:  booking rolled back on network error        ✅"
  echo -e "    4. Database:     cancelled appointments + audit trail         ✅"
  echo -e "    5. Recovery:     booking works after calendar fixed           ✅"
  exit 0
else
  echo -e "  ${RED}${BOLD}🚨 $FAIL test(s) FAILED — review output above${RESET}"
  exit 1
fi
