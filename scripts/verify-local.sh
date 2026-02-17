#!/usr/bin/env bash
# ============================================================
# verify-local.sh — Health-check all local dev services
# ============================================================
# Uses 127.0.0.1 (IPv4 only) + --max-time on every call so
# this script NEVER hangs, even if localhost resolves to IPv6.
#
# Safe to run from any terminal — does NOT touch Vite or Next.
#
# Exit codes:
#   0 = all services healthy
#   1 = one or more services down
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$ROOT/logs"

C_GREEN='\033[1;32m'
C_RED='\033[1;31m'
C_CYAN='\033[1;36m'
C_DIM='\033[2m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

PASS=0
FAIL=0

echo ""
echo -e "${C_BOLD}  🩺 gomomo.ai — Local Verification${C_RESET}"
echo -e "  ──────────────────────────────────────"
echo ""

# ── Helper ──────────────────────────────────────────────────
check() {
  local label=$1 url=$2 expect_code=${3:-200}
  local code
  code=$(curl -4 --max-time 3 -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [ "$code" = "$expect_code" ]; then
    echo -e "  ${C_GREEN}✅ $label${C_RESET}  ${C_DIM}→ $url (HTTP $code)${C_RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${C_RED}❌ $label${C_RESET}  ${C_DIM}→ $url (HTTP $code, expected $expect_code)${C_RESET}"
    FAIL=$((FAIL + 1))
  fi
}

check_json() {
  local label=$1 url=$2
  local body
  body=$(curl -4 --max-time 3 -s "$url" 2>/dev/null || echo "")
  if echo "$body" | grep -q '"status"' 2>/dev/null; then
    echo -e "  ${C_GREEN}✅ $label${C_RESET}  ${C_DIM}→ $url${C_RESET}"
    PASS=$((PASS + 1))
  else
    echo -e "  ${C_RED}❌ $label${C_RESET}  ${C_DIM}→ $url (no valid JSON)${C_RESET}"
    FAIL=$((FAIL + 1))
  fi
}

# ── Checks ──────────────────────────────────────────────────
check      "Backend HTTP"     "http://127.0.0.1:3000/health"
check_json "Backend JSON"     "http://127.0.0.1:3000/health"
check      "Web (Next.js)"    "http://127.0.0.1:3001/"
check      "Widget (Vite)"    "http://127.0.0.1:5173/"

# Socket.IO handshake probe (expects a 200 with EIO body)
echo ""
echo -e "  ${C_CYAN}Socket.IO probe:${C_RESET}"
SIO_BODY=$(curl -4 --max-time 3 -s "http://127.0.0.1:3000/ws/?EIO=4&transport=polling" 2>/dev/null || echo "")
if [ -n "$SIO_BODY" ] && echo "$SIO_BODY" | grep -q "sid" 2>/dev/null; then
  echo -e "  ${C_GREEN}✅ Socket.IO handshake OK${C_RESET}"
  PASS=$((PASS + 1))
else
  echo -e "  ${C_RED}❌ Socket.IO handshake failed${C_RESET}"
  FAIL=$((FAIL + 1))
fi

# ── PID file status ─────────────────────────────────────────
echo ""
echo -e "  ${C_CYAN}PID files:${C_RESET}"
for svc in backend web widget; do
  pidfile="$LOGDIR/${svc}.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo -e "  ${C_GREEN}✅ $svc${C_RESET}  ${C_DIM}PID $pid (alive)${C_RESET}"
    else
      echo -e "  ${C_RED}❌ $svc${C_RESET}  ${C_DIM}PID $pid (dead — stale pidfile)${C_RESET}"
    fi
  else
    echo -e "  ${C_DIM}   $svc  no pidfile${C_RESET}"
  fi
done

# ── Port listing ────────────────────────────────────────────
echo ""
echo -e "  ${C_CYAN}Ports listening:${C_RESET}"
lsof -nP -iTCP:3000 -iTCP:3001 -iTCP:5173 -sTCP:LISTEN 2>/dev/null \
  | awk 'NR>1 {printf "    %-12s PID %-8s %s\n", $1, $2, $9}' || echo "    (none)"

# ── Summary ─────────────────────────────────────────────────
echo ""
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo -e "  ${C_GREEN}All $TOTAL checks passed ✅${C_RESET}"
  echo ""
  exit 0
else
  echo -e "  ${C_RED}$FAIL / $TOTAL checks failed ❌${C_RESET}"
  [ -d "$LOGDIR" ] && echo -e "  ${C_DIM}Check logs: $LOGDIR/*.log${C_RESET}"
  echo ""
  exit 1
fi
