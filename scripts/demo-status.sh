#!/usr/bin/env bash
# ============================================================
# demo-status.sh — Show running gomomo.ai demo processes
# ============================================================
set -euo pipefail

C_GREEN='\033[1;32m'
C_RED='\033[1;31m'
C_CYAN='\033[1;36m'
C_DIM='\033[2m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.logs"

echo ""
echo -e "${C_BOLD}  gomomo.ai — Demo Status${C_RESET}"
echo -e "  ─────────────────────────────────"

all_up=true

check_port() {
  local port=$1 label=$2 url=$3
  local pid
  pid=$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  if [ -n "$pid" ]; then
    echo -e "  ${C_GREEN}✅ $label${C_RESET}  ${C_DIM}PID $pid${C_RESET}  →  $url"
  else
    echo -e "  ${C_RED}❌ $label${C_RESET}  ${C_DIM}not running${C_RESET}"
    all_up=false
  fi
}

check_port 5432 "PostgreSQL " "localhost:5432"
check_port 3000 "Backend API" "http://localhost:3000"
check_port 5173 "Frontend   " "http://localhost:5173?demo=1"

echo ""

# Health check on backend
if lsof -ti :3000 -sTCP:LISTEN >/dev/null 2>&1; then
  health=$(curl -sf http://localhost:3000/health 2>/dev/null || echo "FAIL")
  if [ "$health" != "FAIL" ]; then
    echo -e "  ${C_GREEN}💚 Backend health: OK${C_RESET}"
  else
    echo -e "  ${C_RED}💔 Backend health: unreachable${C_RESET}"
    all_up=false
  fi
fi

echo ""

if [ "$all_up" = true ]; then
  # Fetch config from backend to show active mode
  config=$(curl -sf http://localhost:3000/api/config 2>/dev/null || echo "{}")
  autonomy_on=$(echo "$config" | grep -o '"enabled":true' | head -1)
  if [ -n "$autonomy_on" ]; then
    echo -e "  ${C_GREEN}🤖 Autonomy: ON${C_RESET} — policy-gated job runner active"
  else
    echo -e "  ${C_DIM}🤖 Autonomy: OFF${C_RESET}"
  fi

  echo ""
  echo -e "  ${C_GREEN}All services running. Ready to demo!${C_RESET}"
  echo ""
  echo "  🌐  Open:  http://localhost:5173?demo=1"
  echo "  🛑  Stop:  npm run demo:stop"
else
  echo -e "  ${C_RED}Some services are down.${C_RESET}"
  echo "  🔄  Restart:  npm run demo:start"
  [ -d "$LOGS" ] && echo "  📋  Logs:     $LOGS/"
fi

echo ""
