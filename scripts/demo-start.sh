#!/usr/bin/env bash
# ============================================================
# demo-start.sh — Start the full gomomo.ai demo stack
#
# Launches:
#   1. Embedded PostgreSQL (via pg-daemon.mjs — stays alive)
#   2. Backend API (Fastify on port 3000)
#   3. Frontend dev server (Vite on port 5173)
#
# All processes run in the background, detached from this shell.
# Logs go to .logs/{pg,backend,frontend}.log
# Ctrl+C in other terminals will NOT kill the stack.
#
# Usage:  bash scripts/demo-start.sh
# Stop:   bash scripts/demo-stop.sh
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/src/backend"
FRONTEND="$ROOT/src/frontend"
LOGS="$ROOT/.logs"

C_GREEN='\033[1;32m'
C_CYAN='\033[1;36m'
C_RED='\033[1;31m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

# ── Helpers ─────────────────────────────────────────────────
die()  { echo -e "${C_RED}❌ $1${C_RESET}" >&2; exit 1; }
info() { echo -e "${C_CYAN}   $1${C_RESET}"; }
ok()   { echo -e "${C_GREEN}   ✅ $1${C_RESET}"; }

wait_for_port() {
  local port=$1 label=$2 timeout=${3:-30}
  local elapsed=0
  while ! lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      die "$label did not start within ${timeout}s — check $LOGS/"
    fi
  done
}

# ── Pre-flight ──────────────────────────────────────────────
echo ""
echo -e "${C_BOLD}╔══════════════════════════════════════════════════╗${C_RESET}"
echo -e "${C_BOLD}║  🌸 gomomo.ai — Demo Launcher                    ║${C_RESET}"
echo -e "${C_BOLD}╚══════════════════════════════════════════════════╝${C_RESET}"
echo ""

# Stop anything already running (silently)
bash "$ROOT/scripts/demo-stop.sh" 2>/dev/null || true

# Check .env
[ -f "$BACKEND/.env" ] || die "Missing $BACKEND/.env — copy from .env.example and set OPENAI_API_KEY"
grep -q 'OPENAI_API_KEY=sk-' "$BACKEND/.env" || die "OPENAI_API_KEY not set in $BACKEND/.env"

# Fail fast on placeholder secrets
if grep -qiE 'OPENAI_API_KEY=(your[-_]?key|<|TODO|REPLACE|CHANGEME|xxx|placeholder)' "$BACKEND/.env"; then
  die "OPENAI_API_KEY contains a placeholder value — set a real key"
fi

# Read key settings from .env for the banner
AUTONOMY=$(grep '^AUTONOMY_ENABLED=' "$BACKEND/.env" 2>/dev/null | cut -d= -f2 || echo "false")
SDK_AUTH=$(grep '^SDK_AUTH_REQUIRED=' "$BACKEND/.env" 2>/dev/null | cut -d= -f2 || echo "false")
DEMO_AVAIL=$(grep '^DEMO_AVAILABILITY=' "$BACKEND/.env" 2>/dev/null | cut -d= -f2 || echo "true")
CAL_MODE=$(grep '^CALENDAR_MODE=' "$BACKEND/.env" 2>/dev/null | cut -d= -f2 || echo "mock")
HAS_TWILIO="no"
if grep -q '^TWILIO_ACCOUNT_SID=AC' "$BACKEND/.env" 2>/dev/null; then HAS_TWILIO="yes"; fi

# Validate SDK_AUTH_REQUIRED=true dependencies
if [ "$SDK_AUTH" = "true" ]; then
  grep -q '^ADMIN_API_KEY=.\{16,\}' "$BACKEND/.env" || die "ADMIN_API_KEY must be ≥16 chars when SDK_AUTH_REQUIRED=true"
fi

# Check node_modules
[ -d "$BACKEND/node_modules" ]  || { info "Installing backend deps…";  npm --prefix "$BACKEND"  install --silent; }
[ -d "$FRONTEND/node_modules" ] || { info "Installing frontend deps…"; npm --prefix "$FRONTEND" install --silent; }
[ -d "$ROOT/node_modules" ]     || { info "Installing root deps…";     npm --prefix "$ROOT"     install --silent; }

# Create log directory
mkdir -p "$LOGS"

# ── 1. PostgreSQL Daemon ────────────────────────────────────
info "Starting PostgreSQL + migrations + seed…"

nohup node "$ROOT/scripts/pg-daemon.mjs" \
  >> "$LOGS/pg.log" 2>&1 &
disown

wait_for_port 5432 "PostgreSQL" 30

# Wait for migrations/seed to complete (look for "Ready" in log)
for i in $(seq 1 30); do
  if grep -q "Ready" "$LOGS/pg.log" 2>/dev/null; then
    break
  fi
  sleep 1
done

ok "PostgreSQL + migrations + seed ready on port 5432"

# ── 2. Backend API ──────────────────────────────────────────
info "Starting backend API…"

nohup bash -c "cd '$BACKEND' && npx tsx src/index.ts" \
  >> "$LOGS/backend.log" 2>&1 &
disown

wait_for_port 3000 "Backend" 30
ok "Backend ready on http://localhost:3000"

# ── 3. Frontend Dev Server ──────────────────────────────────
info "Starting frontend…"

nohup bash -c "cd '$FRONTEND' && npx vite --host --port 5173" \
  >> "$LOGS/frontend.log" 2>&1 &
disown

wait_for_port 5173 "Frontend" 20
ok "Frontend ready on http://localhost:5173"

# ── Done ────────────────────────────────────────────────────
C_YELLOW='\033[1;33m'

# Determine mode label
if [ "$AUTONOMY" = "true" ] && [ "$SDK_AUTH" = "true" ]; then
  MODE_LABEL="DEMO-FULL"
  MODE_COLOR="$C_GREEN"
elif [ "$AUTONOMY" = "true" ]; then
  MODE_LABEL="DEMO (Autonomy ON, Auth OFF)"
  MODE_COLOR="$C_YELLOW"
else
  MODE_LABEL="DEMO (Lite)"
  MODE_COLOR="$C_YELLOW"
fi

SMS_LABEL="Simulator (logged to console)"
if [ "$HAS_TWILIO" = "yes" ]; then
  SMS_LABEL="Live (Twilio)"
fi

echo ""
echo -e "${C_GREEN}╔══════════════════════════════════════════════════╗${C_RESET}"
echo -e "${C_GREEN}║  ✅  All services running!                        ║${C_RESET}"
echo -e "${C_GREEN}╚══════════════════════════════════════════════════╝${C_RESET}"
echo ""
echo -e "  �️   Mode:           ${MODE_COLOR}${MODE_LABEL}${C_RESET}"
echo -e "  🤖  Autonomy:        ${AUTONOMY}"
echo -e "  🔐  SDK Auth:        ${SDK_AUTH}"
echo -e "  📅  Calendar:        ${CAL_MODE}"
echo -e "  �  SMS:             ${SMS_LABEL}"
echo -e "  🧪  Demo Slots:      ${DEMO_AVAIL}"
echo ""
echo "  🌐  Chat widget:    http://localhost:5173?demo=1"
echo "  🔧  Backend API:    http://localhost:3000"
echo "  💚  Health check:   http://localhost:3000/health"
echo "  🐘  PostgreSQL:     localhost:5432"
echo ""
echo "  📋  Logs:           $LOGS/"
echo "  🛑  Stop:           npm run demo:stop"
echo "  📊  Status:         npm run demo:status"
echo -e "${C_GREEN}══════════════════════════════════════════════════${C_RESET}"
echo ""
