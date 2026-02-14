#!/usr/bin/env bash
# ============================================================
# Manual Test: Google Calendar READ → Availability Engine
# ============================================================
#
# This script verifies that personal Google Calendar events
# correctly block time slots in the availability response.
#
# Prerequisites:
#   1. Server running: npm run dev (or node dist/index.js)
#   2. A test tenant with Google OAuth connected
#   3. Add a personal event in Google Calendar for the test range
#
# The script hits the availability API and checks that:
#   - The response includes a `verified` field
#   - Slots overlapping with calendar events are marked unavailable
#
# Usage:
#   bash scripts/test-calendar-read.sh [TENANT_ID] [DATE]
#
# Example:
#   bash scripts/test-calendar-read.sh abc123 2026-06-15
#
# If no arguments provided, uses demo defaults.
# ============================================================

set -euo pipefail

BASE_URL="${API_BASE_URL:-http://localhost:3000}"
TENANT_ID="${1:-demo}"
DATE="${2:-$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d '+1 day' +%Y-%m-%d)}"

START="${DATE}T00:00:00Z"
END="${DATE}T23:59:59Z"

echo "╔═══════════════════════════════════════════════════════╗"
echo "║  Calendar READ Integration — Manual Test             ║"
echo "╠═══════════════════════════════════════════════════════╣"
echo "║  Server:    ${BASE_URL}"
echo "║  Tenant:    ${TENANT_ID}"
echo "║  Date:      ${DATE}"
echo "║  Range:     ${START} → ${END}"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Fetch availability ─────────────────────────────
echo "━━━ Step 1: Fetching availability slots ━━━"
RESPONSE=$(curl -s -w '\n%{http_code}' \
  "${BASE_URL}/api/tenants/${TENANT_ID}/availability?start=${START}&end=${END}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: ${HTTP_CODE}"

if [ "$HTTP_CODE" != "200" ]; then
  echo "❌ FAIL: Expected HTTP 200, got ${HTTP_CODE}"
  echo "Response: ${BODY}"
  exit 1
fi

echo "✅ HTTP 200 OK"
echo ""

# ── Step 2: Check for 'verified' field ─────────────────────
echo "━━━ Step 2: Checking 'verified' field ━━━"

VERIFIED=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('verified', 'MISSING'))" 2>/dev/null || echo "PARSE_ERROR")

if [ "$VERIFIED" = "MISSING" ]; then
  echo "❌ FAIL: Response missing 'verified' field"
  echo "   This means the AvailabilityResult wrapper is not being returned."
  exit 1
elif [ "$VERIFIED" = "PARSE_ERROR" ]; then
  echo "⚠️  Could not parse JSON (python3 required). Raw response:"
  echo "$BODY" | head -c 500
  exit 1
fi

echo "verified = ${VERIFIED}"

if [ "$VERIFIED" = "True" ]; then
  echo "✅ Slots are calendar-verified (Google Calendar was consulted)"
elif [ "$VERIFIED" = "False" ]; then
  echo "⚠️  Slots are UNVERIFIED (calendar read failed, lenient mode)"
fi
echo ""

# ── Step 3: Check for calendar_source ──────────────────────
echo "━━━ Step 3: Checking 'calendar_source' field ━━━"

CAL_SOURCE=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('calendar_source', 'not_set'))" 2>/dev/null || echo "PARSE_ERROR")

echo "calendar_source = ${CAL_SOURCE}"

if [ "$CAL_SOURCE" = "google" ]; then
  echo "✅ Calendar source: Google Calendar (busy ranges applied)"
elif [ "$CAL_SOURCE" = "db_only" ]; then
  echo "⚠️  Calendar source: DB only (calendar read failed)"
else
  echo "ℹ️  No calendar_source (mock mode or no OAuth connected)"
fi
echo ""

# ── Step 4: Slot summary ──────────────────────────────────
echo "━━━ Step 4: Slot availability summary ━━━"

SLOT_STATS=$(echo "$BODY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
slots = d.get('slots', [])
total = len(slots)
available = sum(1 for s in slots if s.get('available'))
unavailable = total - available
print(f'Total slots: {total}')
print(f'Available:   {available}')
print(f'Unavailable: {unavailable}')
if unavailable > 0:
    print()
    print('Blocked slots (unavailable):')
    for s in slots:
        if not s.get('available'):
            print(f'  ❌ {s[\"start\"]} → {s[\"end\"]}')
" 2>/dev/null)

if [ -n "$SLOT_STATS" ]; then
  echo "$SLOT_STATS"
else
  echo "⚠️  Could not parse slot stats"
fi
echo ""

# ── Step 5: Verify personal events block slots ────────────
echo "━━━ Step 5: Personal event blocking check ━━━"

UNAVAILABLE_COUNT=$(echo "$BODY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
slots = d.get('slots', [])
print(sum(1 for s in slots if not s.get('available')))
" 2>/dev/null || echo "0")

if [ "$VERIFIED" = "True" ] && [ "$CAL_SOURCE" = "google" ]; then
  if [ "$UNAVAILABLE_COUNT" -gt 0 ]; then
    echo "✅ PASS: ${UNAVAILABLE_COUNT} slot(s) blocked by calendar events"
    echo "   Personal Google Calendar events are correctly blocking availability."
  else
    echo "ℹ️  No blocked slots found."
    echo "   To test: create a Google Calendar event during business hours for ${DATE}"
    echo "   then re-run this script."
  fi
elif [ "$CAL_SOURCE" = "db_only" ]; then
  echo "⚠️  Calendar read failed — can't verify personal event blocking"
  echo "   Check the server logs for details."
else
  echo "ℹ️  Calendar not connected (mock mode or no OAuth)"
  echo "   To test real integration:"
  echo "   1. Set CALENDAR_MODE=real in .env"
  echo "   2. Connect tenant's Google Calendar via OAuth"
  echo "   3. Add a personal event and re-run this script"
fi
echo ""

echo "══════════════════════════════════════════════════"
echo "  Test complete. Check server logs for [availability] lines."
echo "══════════════════════════════════════════════════"
