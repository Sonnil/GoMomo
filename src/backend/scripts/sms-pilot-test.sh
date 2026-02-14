#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
#  SMS Pilot Hardening — 8-message smoke test
#  Usage:  bash scripts/sms-pilot-test.sh
#  Prereqs: backend running on :3000, SMS_INBOUND_ENABLED=true
# ──────────────────────────────────────────────────────────────
set -euo pipefail

BASE="http://localhost:3000/twilio/sms/incoming"
PSQL="/Applications/Postgres.app/Contents/Versions/18/bin/psql"
FROM="+15551234567"
TO="+18005551234"
SID="SM_PILOT_$(date +%s)"
PASS=0
FAIL=0

send() {
  local label="$1" body="$2" expect="$3"
  echo ""
  echo "━━━ TEST: $label ━━━"
  RESP=$(curl -s -X POST "$BASE" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "From=$FROM&To=$TO&Body=$body&MessageSid=${SID}_${RANDOM}")

  if echo "$RESP" | grep -qi "$expect"; then
    echo "✅ PASS  (found: $expect)"
    PASS=$((PASS + 1))
  else
    echo "❌ FAIL  (expected: $expect)"
    echo "   Response: $RESP"
    FAIL=$((FAIL + 1))
  fi
}

send_empty() {
  local label="$1" body="$2"
  echo ""
  echo "━━━ TEST: $label ━━━"
  RESP=$(curl -s -X POST "$BASE" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "From=$FROM&To=$TO&Body=$body&MessageSid=${SID}_${RANDOM}")

  # Empty TwiML = <Response></Response> (no <Message> tag)
  if echo "$RESP" | grep -qi "<Message>"; then
    echo "❌ FAIL  (expected empty TwiML, got a <Message>)"
    echo "   Response: $RESP"
    FAIL=$((FAIL + 1))
  else
    echo "✅ PASS  (empty TwiML — silent as expected)"
    PASS=$((PASS + 1))
  fi
}

echo "╔══════════════════════════════════════════════════════════╗"
echo "║   SMS Pilot Hardening — 8-Message Smoke Test            ║"
echo "╚══════════════════════════════════════════════════════════╝"

# ── 1. HELP response (active user) ──
send "1 — HELP keyword" \
  "HELP" \
  "To book"

# ── 2. STOP opt-out ──
send "2 — STOP opt-out" \
  "STOP" \
  "unsubscribed"

# ── 3. HELP while opted out (should be silent) ──
send_empty "3 — HELP while opted out (silent)"  \
  "HELP"

# ── 4. START re-opt-in ──
send "4 — START re-opt-in" \
  "START" \
  "re-subscribed"

# ── 5. HELP after re-opt-in (should work again) ──
send "5 — HELP after re-opt-in" \
  "HELP" \
  "To book"

# ── 6. Normal booking message (phone gets normalized) ──
send "6 — Normal booking message" \
  "I'd like to book a haircut tomorrow at 2pm" \
  "<Message>"

# ── 7. Quiet hours — tenant config exists in DB ──
echo ""
echo "━━━ TEST: 7 — Quiet hours config in DB ━━━"
QH=$($PSQL -U receptionist -d receptionist -t -A -c \
  "SELECT quiet_hours_start || '-' || quiet_hours_end FROM tenants LIMIT 1" 2>/dev/null || echo "ERROR")
if echo "$QH" | grep -qE '^[0-9]{2}:[0-9]{2}-[0-9]{2}:[0-9]{2}$'; then
  echo "✅ PASS  (quiet hours config: $QH)"
  PASS=$((PASS + 1))
else
  echo "❌ FAIL  (expected HH:MM-HH:MM, got: $QH)"
  FAIL=$((FAIL + 1))
fi

# ── 8. Quiet hours — sms_outbox table exists ──
echo ""
echo "━━━ TEST: 8 — sms_outbox table exists ━━━"
OUTBOX=$($PSQL -U receptionist -d receptionist -t -A -c \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='sms_outbox'" 2>/dev/null || echo "0")
if [ "$OUTBOX" = "1" ]; then
  echo "✅ PASS  (sms_outbox table ready)"
  PASS=$((PASS + 1))
else
  echo "❌ FAIL  (sms_outbox table missing)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Results:  $PASS passed  /  $((PASS + FAIL)) total"
if [ "$FAIL" -gt 0 ]; then
  echo "  ⚠️  $FAIL FAILED"
else
  echo "  🎉 ALL PASSED"
fi
echo "════════════════════════════════════════════════════════════"
