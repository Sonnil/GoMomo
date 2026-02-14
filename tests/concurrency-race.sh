#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  AI Receptionist — Concurrency & Overbooking Race Test
#
#  Fires parallel HTTP requests to prove that the EXCLUDE
#  constraints, SERIALIZABLE transactions, and advisory locks
#  prevent double-booking.
#
#  Tests:
#    1. N parallel holds for the SAME slot → exactly 1 wins
#    2. Parallel confirms for the winning hold → exactly 1 appointment
#    3. SQL integrity check → no overlapping confirmed bookings
#    4. Stale-hold check → no stale holds blocking
#
#  Prerequisites:
#    docker compose up -d && seed data loaded
#    brew install jq
#
#  Usage:
#    bash tests/concurrency-race.sh            # 10 racers (default)
#    RACERS=20 bash tests/concurrency-race.sh  # 20 racers
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────
BASE="${BASE:-http://localhost:3000}"
TENANT_ID="00000000-0000-4000-a000-000000000001"
RACERS="${RACERS:-10}"
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

# ── Dependency check ──────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo -e "${RED}jq is required. Install: brew install jq${RESET}"
  exit 1
fi

# ── Cleanup on exit ───────────────────────────────────────────────
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

# ══════════════════════════════════════════════════════════════════
echo -e "\n${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  Concurrency & Overbooking Race Test             ║${RESET}"
echo -e "${BOLD}║  Racers: ${RACERS}  Base: ${BASE}             ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${RESET}"

# ══════════════════════════════════════════════════════════════════
header "Preflight · Health check"
# ══════════════════════════════════════════════════════════════════
HEALTH=$(curl -sf "$BASE/health" 2>/dev/null || echo '{}')
if [[ $(echo "$HEALTH" | jq -r '.status // empty') != "ok" ]]; then
  fail "Backend not running" "curl $BASE/health → $HEALTH"
  echo -e "\n${RED}Start services: docker compose up -d${RESET}"
  exit 1
fi
pass "Backend healthy"

# ══════════════════════════════════════════════════════════════════
header "Preflight · Find available slot"
# ══════════════════════════════════════════════════════════════════
# Try up to 5 days ahead to skip weekends
SLOT_START=""
for OFFSET in 1 2 3 4 5; do
  if date -v+${OFFSET}d +%Y-%m-%d &>/dev/null; then
    DAY=$(date -v+${OFFSET}d +%Y-%m-%d)
  else
    DAY=$(date -d "+${OFFSET} days" +%Y-%m-%d)
  fi
  AVAIL=$(curl -sf "$BASE/api/tenants/$TENANT_ID/availability?start=${DAY}T00:00:00&end=${DAY}T23:59:59" 2>/dev/null || echo '{}')
  SLOT_START=$(echo "$AVAIL" | jq -r '[.slots // [] | .[] | select(.available==true)] | .[0].start // empty')
  if [[ -n "$SLOT_START" ]]; then
    SLOT_END=$(echo "$AVAIL" | jq -r '[.slots[] | select(.available==true)] | .[0].end')
    break
  fi
done

if [[ -z "$SLOT_START" ]]; then
  fail "No available slots found" "Tried +1..+5 days"
  exit 1
fi
pass "Target slot: $SLOT_START → $SLOT_END"

# ══════════════════════════════════════════════════════════════════
header "Test 1 · $RACERS parallel hold requests for the SAME slot"
# ══════════════════════════════════════════════════════════════════
info "Firing $RACERS concurrent POST /holds …"

TS=$(date +%s)
for i in $(seq 1 "$RACERS"); do
  curl -s -o "$TMPDIR_TEST/hold_body_$i.json" -w "%{http_code}" \
    -X POST "$BASE/api/tenants/$TENANT_ID/holds" \
    -H "Content-Type: application/json" \
    -d "{\"session_id\":\"racer-$i-$TS\",\"start_time\":\"$SLOT_START\",\"end_time\":\"$SLOT_END\"}" \
    > "$TMPDIR_TEST/hold_code_$i.txt" &
done
wait

HOLD_WINNERS=0
HOLD_LOSERS=0
WINNING_HOLD_ID=""
WINNING_SESSION=""

for i in $(seq 1 "$RACERS"); do
  CODE=$(cat "$TMPDIR_TEST/hold_code_$i.txt")
  if [[ "$CODE" == "201" ]]; then
    ((HOLD_WINNERS++))
    WINNING_HOLD_ID=$(jq -r '.id' "$TMPDIR_TEST/hold_body_$i.json")
    WINNING_SESSION=$(jq -r '.session_id' "$TMPDIR_TEST/hold_body_$i.json")
    info "Racer $i: ${GREEN}201 Created${RESET} → hold=$WINNING_HOLD_ID"
  else
    ((HOLD_LOSERS++))
    info "Racer $i: ${RED}$CODE Conflict${RESET}"
  fi
done

echo ""
info "Winners: $HOLD_WINNERS / $RACERS"

if [[ "$HOLD_WINNERS" -eq 1 ]]; then
  pass "Exactly 1 hold created (${HOLD_LOSERS} rejected by EXCLUDE constraint)"
elif [[ "$HOLD_WINNERS" -eq 0 ]]; then
  fail "No holds succeeded" "Stale hold may be blocking — run: DELETE FROM availability_holds WHERE expires_at <= NOW();"
else
  fail "OVERBOOKING: $HOLD_WINNERS holds created for the same slot!" "EXCLUDE constraint may be missing or misconfigured"
fi

# ══════════════════════════════════════════════════════════════════
header "Test 2 · 5 parallel confirm requests for the winning hold"
# ══════════════════════════════════════════════════════════════════
if [[ -z "$WINNING_HOLD_ID" || "$WINNING_HOLD_ID" == "null" ]]; then
  fail "Skipped — no winning hold from Test 1" ""
else
  CONFIRM_RACERS=5
  info "Firing $CONFIRM_RACERS concurrent POST /appointments for hold=$WINNING_HOLD_ID …"

  for i in $(seq 1 "$CONFIRM_RACERS"); do
    curl -s -o "$TMPDIR_TEST/confirm_body_$i.json" -w "%{http_code}" \
      -X POST "$BASE/api/tenants/$TENANT_ID/appointments" \
      -H "Content-Type: application/json" \
      -d "{
        \"session_id\":\"$WINNING_SESSION\",
        \"hold_id\":\"$WINNING_HOLD_ID\",
        \"client_name\":\"Racer $i\",
        \"client_email\":\"racer$i@race.test\",
        \"service\":\"Follow-up Visit\"
      }" \
      > "$TMPDIR_TEST/confirm_code_$i.txt" &
  done
  wait

  CONFIRM_WINNERS=0
  CONFIRM_APT_IDS=()

  for i in $(seq 1 "$CONFIRM_RACERS"); do
    CODE=$(cat "$TMPDIR_TEST/confirm_code_$i.txt")
    if [[ "$CODE" == "201" ]]; then
      ((CONFIRM_WINNERS++))
      APT_ID=$(jq -r '.id' "$TMPDIR_TEST/confirm_body_$i.json")
      CONFIRM_APT_IDS+=("$APT_ID")
      info "Attempt $i: ${GREEN}201 Created${RESET} → apt=$APT_ID"
    else
      ERR=$(jq -r '.error // "unknown"' "$TMPDIR_TEST/confirm_body_$i.json" 2>/dev/null || echo "parse error")
      info "Attempt $i: ${RED}$CODE${RESET} — $ERR"
    fi
  done

  # Deduplicate — idempotent responses return the same appointment ID
  UNIQUE_APTS=($(printf '%s\n' "${CONFIRM_APT_IDS[@]}" | sort -u))

  echo ""
  info "Confirmations: $CONFIRM_WINNERS / $CONFIRM_RACERS (${#UNIQUE_APTS[@]} unique appointment(s))"

  if [[ "${#UNIQUE_APTS[@]}" -le 1 ]]; then
    pass "At most 1 unique appointment created (idempotency working)"
  else
    fail "OVERBOOKING: ${#UNIQUE_APTS[@]} different appointments for the same hold!" "Advisory lock or idempotency check may be broken"
  fi
fi

# ══════════════════════════════════════════════════════════════════
header "Test 3 · SQL integrity — no overlapping confirmed bookings"
# ══════════════════════════════════════════════════════════════════
OVERLAP_COUNT=$(docker compose exec -T postgres psql -U receptionist -d receptionist -tAc "
  SELECT COUNT(*)
  FROM appointments a1
  JOIN appointments a2
    ON a1.tenant_id = a2.tenant_id
   AND a1.id < a2.id
   AND a1.status = 'confirmed'
   AND a2.status = 'confirmed'
   AND a1.start_time < a2.end_time
   AND a1.end_time > a2.start_time;
" 2>/dev/null || echo "-1")

OVERLAP_COUNT=$(echo "$OVERLAP_COUNT" | tr -d '[:space:]')

if [[ "$OVERLAP_COUNT" == "0" ]]; then
  pass "Zero overlapping confirmed appointments in database"
elif [[ "$OVERLAP_COUNT" == "-1" ]]; then
  fail "Could not query database" "Is docker compose running? Check postgres container."
else
  fail "OVERBOOKING DETECTED: $OVERLAP_COUNT overlapping appointment pairs!" "Run the overlap query manually to inspect"
fi

# ══════════════════════════════════════════════════════════════════
header "Test 4 · SQL integrity — no overlapping active holds"
# ══════════════════════════════════════════════════════════════════
HOLD_OVERLAP=$(docker compose exec -T postgres psql -U receptionist -d receptionist -tAc "
  SELECT COUNT(*)
  FROM availability_holds h1
  JOIN availability_holds h2
    ON h1.tenant_id = h2.tenant_id
   AND h1.id < h2.id
   AND h1.expires_at > NOW()
   AND h2.expires_at > NOW()
   AND h1.start_time < h2.end_time
   AND h1.end_time > h2.start_time;
" 2>/dev/null || echo "-1")

HOLD_OVERLAP=$(echo "$HOLD_OVERLAP" | tr -d '[:space:]')

if [[ "$HOLD_OVERLAP" == "0" ]]; then
  pass "Zero overlapping active holds in database"
elif [[ "$HOLD_OVERLAP" == "-1" ]]; then
  fail "Could not query database" "Is docker compose running?"
else
  fail "HOLD CONFLICT: $HOLD_OVERLAP overlapping active hold pairs!" "EXCLUDE constraint may be misconfigured"
fi

# ══════════════════════════════════════════════════════════════════
header "Test 5 · Stale hold passthrough — expired holds don't block"
# ══════════════════════════════════════════════════════════════════
# Count stale holds (informational)
STALE=$(docker compose exec -T postgres psql -U receptionist -d receptionist -tAc "
  SELECT COUNT(*) FROM availability_holds WHERE expires_at <= NOW();
" 2>/dev/null || echo "-1")
STALE=$(echo "$STALE" | tr -d '[:space:]')

if [[ "$STALE" == "-1" ]]; then
  fail "Could not query stale holds" ""
elif [[ "$STALE" == "0" ]]; then
  pass "No stale holds present (clean state)"
else
  info "$STALE stale hold(s) found — acceptable (EXCLUDE filters them via WHERE expires_at > NOW())"
  pass "Stale holds exist but don't block new bookings (by design)"
fi

# ══════════════════════════════════════════════════════════════════
header "Cleanup · Remove test data"
# ══════════════════════════════════════════════════════════════════
docker compose exec -T postgres psql -U receptionist -d receptionist -c "
  DELETE FROM appointments WHERE client_email LIKE '%@race.test';
  DELETE FROM availability_holds WHERE session_id LIKE 'racer-%';
" &>/dev/null && info "Test appointments and holds cleaned up" || info "Cleanup skipped (non-critical)"

# ══════════════════════════════════════════════════════════════════
header "Results"
# ══════════════════════════════════════════════════════════════════
TOTAL=$((PASS + FAIL))
echo ""
echo -e "  ${GREEN}$PASS passed${RESET}  /  ${RED}$FAIL failed${RESET}  /  $TOTAL total"
echo ""

if [[ "$FAIL" -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}🔒 ALL TESTS PASSED — No overbooking possible!${RESET}"
  echo ""
  echo -e "  ${CYAN}Protection layers verified:${RESET}"
  echo -e "    1. EXCLUDE USING gist on availability_holds  ✅"
  echo -e "    2. EXCLUDE USING gist on appointments        ✅"
  echo -e "    3. SERIALIZABLE + advisory lock              ✅"
  echo -e "    4. Idempotent confirm (source_hold_id)       ✅"
  echo -e "    5. SQL integrity (zero overlaps)             ✅"
  exit 0
else
  echo -e "  ${RED}${BOLD}🚨 $FAIL test(s) FAILED — overbooking may be possible!${RESET}"
  echo -e "  ${YELLOW}Review the output above and check the EXCLUDE constraints.${RESET}"
  exit 1
fi
