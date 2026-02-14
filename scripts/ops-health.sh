#!/usr/bin/env bash
# ops-health.sh — Quick health dashboard for the gomomo.ai dev stack.
# Run from any terminal EXCEPT the one running Vite.
# Usage:  bash scripts/ops-health.sh
#         ./scripts/ops-health.sh          (after chmod +x)
set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:5173}"

# ── Colours ──────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf "${GREEN}✅ %s${NC}\n" "$1"; }
fail() { printf "${RED}❌ %s${NC}\n" "$1"; }
warn() { printf "${YELLOW}⚠️  %s${NC}\n" "$1"; }

# ── 1. Port check ───────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  gomomo.ai — Dev Health Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

printf "\n📡 Ports:\n"

BACKEND_PID=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$BACKEND_PID" ]; then
  ok "Backend :3000  (PID $BACKEND_PID)"
else
  fail "Backend :3000  — NOT LISTENING"
fi

FRONTEND_PID=$(lsof -ti:5173 2>/dev/null || true)
if [ -n "$FRONTEND_PID" ]; then
  ok "Frontend :5173 (PID $FRONTEND_PID)"
else
  fail "Frontend :5173 — NOT LISTENING"
fi

# ── 2. Backend /health ──────────────────────────────────────
printf "\n🏥 Backend /health:\n"

HEALTH=$(curl -sf --max-time 5 "${BACKEND_URL}/health" 2>/dev/null || echo "UNREACHABLE")
if [ "$HEALTH" = "UNREACHABLE" ]; then
  fail "Backend /health — unreachable"
else
  echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
fi

# ── 3. Backend /health/sms ──────────────────────────────────
printf "\n📱 Backend /health/sms:\n"

SMS_HEALTH=$(curl -sf --max-time 5 "${BACKEND_URL}/health/sms" 2>/dev/null || echo "UNREACHABLE")
if [ "$SMS_HEALTH" = "UNREACHABLE" ]; then
  fail "Backend /health/sms — unreachable"
else
  echo "$SMS_HEALTH" | python3 -m json.tool 2>/dev/null || echo "$SMS_HEALTH"
fi

# ── 4. Frontend reachability ────────────────────────────────
printf "\n🌐 Frontend:\n"

FRONTEND_HTTP=$(curl -sf --max-time 5 -o /dev/null -w "%{http_code}" "${FRONTEND_URL}/" 2>/dev/null || echo "000")
if [ "$FRONTEND_HTTP" = "200" ]; then
  ok "Frontend ${FRONTEND_URL}/ → HTTP $FRONTEND_HTTP"
else
  fail "Frontend ${FRONTEND_URL}/ → HTTP $FRONTEND_HTTP"
fi

# ── Summary ─────────────────────────────────────────────────
printf "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
if [ -n "$BACKEND_PID" ] && [ -n "$FRONTEND_PID" ] && [ "$FRONTEND_HTTP" = "200" ]; then
  ok "All systems operational"
else
  warn "Some services are down — see above"
fi
echo ""
