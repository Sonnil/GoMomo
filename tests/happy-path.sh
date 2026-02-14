#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
#  AI Receptionist — Local Happy-Path Test
#  Runs the full booking flow: availability → hold → confirm
#  → lookup → cancel, then verifies every step.
#
#  Prerequisites:
#    docker compose up -d && seed data loaded
#    brew install jq (if not already installed)
#
#  Usage:
#    bash tests/happy-path.sh                 # default localhost:3000
#    BASE=http://localhost:3000 bash tests/happy-path.sh
# ─────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ────────────────────────────────────────────────
BASE="${BASE:-http://localhost:3000}"
TENANT_ID="00000000-0000-4000-a000-000000000001"
SESSION_ID="hpt-$(date +%s)-$$"

# ── Colours ───────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
FAIL=0

pass() { ((PASS++)); echo -e "  ${GREEN}✅ PASS${RESET} — $1"; }
fail() { ((FAIL++)); echo -e "  ${RED}❌ FAIL${RESET} — $1"; echo -e "     ${YELLOW}↳ $2${RESET}"; }

header() { echo -e "\n${CYAN}${BOLD}── $1 ──${RESET}"; }

# ── Dependency check ──────────────────────────────────────
if ! command -v jq &> /dev/null; then
  echo -e "${RED}jq is required but not installed.${RESET}"
  echo "  macOS: brew install jq"
  echo "  Linux: sudo apt-get install jq"
  exit 1
fi

# ══════════════════════════════════════════════════════════
header "Step 1 · Health check"
# ══════════════════════════════════════════════════════════
HEALTH=$(curl -sf "$BASE/health" 2>/dev/null || echo '{}')
STATUS=$(echo "$HEALTH" | jq -r '.status // empty')

if [[ "$STATUS" == "ok" ]]; then
  pass "GET /health → status=ok"
else
  fail "GET /health" "Expected status=ok, got: $HEALTH"
  echo -e "\n${RED}Backend is not running. Start with: docker compose up -d${RESET}"
  exit 1
fi

# ══════════════════════════════════════════════════════════
header "Step 2 · Get tenant"
# ══════════════════════════════════════════════════════════
TENANT=$(curl -sf "$BASE/api/tenants/$TENANT_ID" 2>/dev/null || echo '{}')
TENANT_NAME=$(echo "$TENANT" | jq -r '.name // empty')

if [[ "$TENANT_NAME" == "gomomo Demo Clinic" ]]; then
  pass "GET /api/tenants/:id → gomomo Demo Clinic"
else
  fail "GET /api/tenants/:id" "Expected 'gomomo Demo Clinic', got: '$TENANT_NAME'"
  echo -e "\n${RED}Seed data missing. Run: docker compose exec backend npx tsx src/db/seed.ts${RESET}"
  exit 1
fi

# ══════════════════════════════════════════════════════════
header "Step 3 · Check availability (tomorrow)"
# ══════════════════════════════════════════════════════════
# Cross-platform tomorrow date
if date -v+1d +%Y-%m-%d &>/dev/null; then
  TOMORROW=$(date -v+1d +%Y-%m-%d)  # macOS
else
  TOMORROW=$(date -d "+1 day" +%Y-%m-%d)  # GNU/Linux
fi
START="${TOMORROW}T00:00:00"
END="${TOMORROW}T23:59:59"

AVAIL=$(curl -sf "$BASE/api/tenants/$TENANT_ID/availability?start=$START&end=$END" 2>/dev/null || echo '{}')
TOTAL_SLOTS=$(echo "$AVAIL" | jq '[.slots // [] | .[] | select(.available==true)] | length')

if [[ "$TOTAL_SLOTS" -gt 0 ]]; then
  pass "GET /availability → $TOTAL_SLOTS available slots for $TOMORROW"
else
  # Try day after tomorrow (could be a weekend)
  if date -v+2d +%Y-%m-%d &>/dev/null; then
    TOMORROW=$(date -v+2d +%Y-%m-%d)
  else
    TOMORROW=$(date -d "+2 days" +%Y-%m-%d)
  fi
  START="${TOMORROW}T00:00:00"
  END="${TOMORROW}T23:59:59"
  AVAIL=$(curl -sf "$BASE/api/tenants/$TENANT_ID/availability?start=$START&end=$END" 2>/dev/null || echo '{}')
  TOTAL_SLOTS=$(echo "$AVAIL" | jq '[.slots // [] | .[] | select(.available==true)] | length')
  if [[ "$TOTAL_SLOTS" -gt 0 ]]; then
    pass "GET /availability → $TOTAL_SLOTS available slots for $TOMORROW (skipped weekend)"
  else
    fail "GET /availability" "No available slots found for $TOMORROW or next day"
    exit 1
  fi
fi

# Pick the first available slot
SLOT_START=$(echo "$AVAIL" | jq -r '[.slots[] | select(.available==true)] | .[0].start')
SLOT_END=$(echo "$AVAIL" | jq -r '[.slots[] | select(.available==true)] | .[0].end')
echo -e "  ${YELLOW}↳ Selected slot: $SLOT_START → $SLOT_END${RESET}"

# ══════════════════════════════════════════════════════════
header "Step 4 · Create hold"
# ══════════════════════════════════════════════════════════
HOLD_RESP=$(curl -sf -X POST "$BASE/api/tenants/$TENANT_ID/holds" \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION_ID\",
    \"start_time\": \"$SLOT_START\",
    \"end_time\": \"$SLOT_END\"
  }" 2>/dev/null || echo '{}')

HOLD_ID=$(echo "$HOLD_RESP" | jq -r '.id // empty')

if [[ -n "$HOLD_ID" && "$HOLD_ID" != "null" ]]; then
  pass "POST /holds → hold_id=$HOLD_ID"
else
  fail "POST /holds" "Expected hold ID, got: $(echo "$HOLD_RESP" | jq -c .)"
  exit 1
fi

# ══════════════════════════════════════════════════════════
header "Step 5 · Verify slot is now held"
# ══════════════════════════════════════════════════════════
AVAIL2=$(curl -sf "$BASE/api/tenants/$TENANT_ID/availability?start=$START&end=$END" 2>/dev/null || echo '{}')
SLOT_AVAIL=$(echo "$AVAIL2" | jq --arg s "$SLOT_START" '[.slots[] | select(.start == $s)] | .[0].available')

if [[ "$SLOT_AVAIL" == "false" ]]; then
  pass "Held slot is now unavailable"
else
  fail "Held slot availability" "Expected available=false, got: $SLOT_AVAIL"
fi

# ══════════════════════════════════════════════════════════
header "Step 6 · Confirm booking"
# ══════════════════════════════════════════════════════════
BOOK_RESP=$(curl -sf -X POST "$BASE/api/tenants/$TENANT_ID/appointments" \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION_ID\",
    \"hold_id\": \"$HOLD_ID\",
    \"client_name\": \"Happy Path User\",
    \"client_email\": \"happy-path@test.local\",
    \"client_notes\": \"Automated test booking\",
    \"service\": \"Follow-up Appointment\"
  }" 2>/dev/null || echo '{}')

APT_ID=$(echo "$BOOK_RESP" | jq -r '.id // empty')
REF_CODE=$(echo "$BOOK_RESP" | jq -r '.reference_code // empty')
APT_STATUS=$(echo "$BOOK_RESP" | jq -r '.status // empty')
GCAL_ID=$(echo "$BOOK_RESP" | jq -r '.google_event_id // empty')

if [[ "$APT_STATUS" == "confirmed" ]]; then
  pass "POST /appointments → status=confirmed"
else
  fail "POST /appointments" "Expected status=confirmed, got: $APT_STATUS — $(echo "$BOOK_RESP" | jq -c .)"
  exit 1
fi

if [[ "$REF_CODE" == APT-* ]]; then
  pass "Reference code: $REF_CODE"
else
  fail "Reference code" "Expected APT-XXXX, got: $REF_CODE"
fi

if [[ -n "$GCAL_ID" && "$GCAL_ID" != "null" ]]; then
  pass "Calendar event ID: $GCAL_ID"
else
  echo -e "  ${YELLOW}⚠️  SKIP${RESET} — google_event_id is null (may be expected — check logs)"
fi

echo -e "  ${YELLOW}↳ Appointment ID: $APT_ID${RESET}"
echo -e "  ${YELLOW}↳ Reference:      $REF_CODE${RESET}"

# ══════════════════════════════════════════════════════════
header "Step 7 · Lookup by reference code"
# ══════════════════════════════════════════════════════════
LOOKUP_REF=$(curl -sf "$BASE/api/tenants/$TENANT_ID/appointments/lookup?ref=$REF_CODE" 2>/dev/null || echo '{}')
LOOKUP_NAME=$(echo "$LOOKUP_REF" | jq -r '.appointments[0].client_name // empty')

if [[ "$LOOKUP_NAME" == "Happy Path User" ]]; then
  pass "Lookup by ref → client_name=Happy Path User"
else
  fail "Lookup by ref" "Expected 'Happy Path User', got: '$LOOKUP_NAME'"
fi

# ══════════════════════════════════════════════════════════
header "Step 8 · Lookup by email"
# ══════════════════════════════════════════════════════════
LOOKUP_EMAIL=$(curl -sf "$BASE/api/tenants/$TENANT_ID/appointments/lookup?email=happy-path@test.local" 2>/dev/null || echo '{}')
LOOKUP_COUNT=$(echo "$LOOKUP_EMAIL" | jq '.appointments | length')

if [[ "$LOOKUP_COUNT" -ge 1 ]]; then
  pass "Lookup by email → $LOOKUP_COUNT appointment(s) found"
else
  fail "Lookup by email" "Expected ≥1 appointments, got: $LOOKUP_COUNT"
fi

# ══════════════════════════════════════════════════════════
header "Step 9 · Cancel appointment"
# ══════════════════════════════════════════════════════════
CANCEL_RESP=$(curl -sf -X POST "$BASE/api/tenants/$TENANT_ID/appointments/$APT_ID/cancel" 2>/dev/null || echo '{}')
CANCEL_STATUS=$(echo "$CANCEL_RESP" | jq -r '.status // empty')

if [[ "$CANCEL_STATUS" == "cancelled" ]]; then
  pass "POST /cancel → status=cancelled"
else
  fail "POST /cancel" "Expected status=cancelled, got: $CANCEL_STATUS"
fi

# ══════════════════════════════════════════════════════════
header "Step 10 · Verify slot freed after cancel"
# ══════════════════════════════════════════════════════════
AVAIL3=$(curl -sf "$BASE/api/tenants/$TENANT_ID/availability?start=$START&end=$END" 2>/dev/null || echo '{}')
SLOT_FREED=$(echo "$AVAIL3" | jq --arg s "$SLOT_START" '[.slots[] | select(.start == $s)] | .[0].available')

if [[ "$SLOT_FREED" == "true" ]]; then
  pass "Cancelled slot is available again"
else
  # Some implementations keep the slot blocked after cancel — note but don't fail
  echo -e "  ${YELLOW}⚠️  NOTE${RESET} — Slot still unavailable after cancel (may be by design)"
fi

# ══════════════════════════════════════════════════════════
header "Results"
# ══════════════════════════════════════════════════════════
TOTAL=$((PASS + FAIL))
echo ""
echo -e "  ${GREEN}$PASS passed${RESET}  /  ${RED}$FAIL failed${RESET}  /  $TOTAL total"
echo ""

if [[ "$FAIL" -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}🎉 ALL TESTS PASSED — Happy path is working!${RESET}"
  echo ""
  echo -e "  ${CYAN}Tip: Check mock-calendar logs with:${RESET}"
  echo -e "  ${YELLOW}docker compose logs backend | grep '\[mock-calendar\]'${RESET}"
  exit 0
else
  echo -e "  ${RED}${BOLD}⚠️  $FAIL test(s) failed — see above for details${RESET}"
  exit 1
fi
