#!/usr/bin/env bash
# ============================================================
# dev-up.sh — Start the local dev stack (backend + web + widget)
# ============================================================
# Launches three dev servers in the background, each in its own
# process group. Logs go to logs/*.log; PIDs go to logs/*.pid.
#
# Port map:
#   Backend (Fastify + Socket.IO)   → 3000
#   Web     (Next.js dev)           → 3001
#   Widget  (Vite dev)              → 5173
#
# Usage:
#   bash scripts/dev-up.sh          # start everything
#   bash scripts/dev-down.sh        # stop everything
#   bash scripts/verify-local.sh    # health-check (safe, never hangs)
#
# RULES:
#   • Never run tests/typecheck/lint in the same terminal as Vite.
#   • Never run `next build` while `next dev` is active.
#   • Always use a SEPARATE terminal for checks. See docs/local-dev.md.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/src/backend"
WEB="$ROOT/src/web"
FRONTEND="$ROOT/src/frontend"
LOGDIR="$ROOT/logs"

# ── Colours ─────────────────────────────────────────────────
C_GREEN='\033[1;32m'
C_CYAN='\033[1;36m'
C_RED='\033[1;31m'
C_YELLOW='\033[1;33m'
C_BOLD='\033[1m'
C_DIM='\033[2m'
C_RESET='\033[0m'

die()  { echo -e "${C_RED}❌ $*${C_RESET}" >&2; exit 1; }
info() { echo -e "${C_CYAN}   $*${C_RESET}"; }
ok()   { echo -e "${C_GREEN}   ✅ $*${C_RESET}"; }
warn() { echo -e "${C_YELLOW}   ⚠️  $*${C_RESET}"; }

# ── Pre-flight: kill stale processes ────────────────────────
echo ""
echo -e "${C_BOLD}╔══════════════════════════════════════════╗${C_RESET}"
echo -e "${C_BOLD}║  🚀 gomomo.ai — Dev Stack Launcher       ║${C_RESET}"
echo -e "${C_BOLD}╚══════════════════════════════════════════╝${C_RESET}"
echo ""

# Clean shutdown if already running
if [ -f "$LOGDIR/backend.pid" ] || [ -f "$LOGDIR/web.pid" ] || [ -f "$LOGDIR/widget.pid" ]; then
  info "Stopping previous dev stack…"
  bash "$ROOT/scripts/dev-down.sh" 2>/dev/null || true
  sleep 1
fi

# Guard: bail if ports are taken by something else
for port_info in "3000:Backend" "3001:Web" "5173:Widget"; do
  port="${port_info%%:*}"
  label="${port_info##*:}"
  if lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    pid=$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null | head -1)
    die "Port $port ($label) already in use by PID $pid. Run: bash scripts/dev-down.sh"
  fi
done

# ── Pre-flight: node_modules ───────────────────────────────
[ -d "$BACKEND/node_modules" ]  || { info "Installing backend deps…";  npm --prefix "$BACKEND"  install --silent; }
[ -d "$WEB/node_modules" ]      || { info "Installing web deps…";      npm --prefix "$WEB"      install --silent; }
[ -d "$FRONTEND/node_modules" ] || { info "Installing widget deps…";   npm --prefix "$FRONTEND" install --silent; }

# ── Next build hygiene ──────────────────────────────────────
# Stale .next/cache can cause Next.js dev to crash or serve
# stale pages. We nuke it on fresh startup.
if [ -d "$WEB/.next/cache" ]; then
  info "Clearing stale .next/cache…"
  rm -rf "$WEB/.next/cache"
fi

# ── Create log dir ──────────────────────────────────────────
mkdir -p "$LOGDIR"

# ── Helper: wait for a port with timeout (127.0.0.1 only) ──
wait_for_port() {
  local port=$1 label=$2 timeout=${3:-30}
  local elapsed=0
  while ! lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      die "$label did not start within ${timeout}s — check $LOGDIR/${label,,}.log"
    fi
  done
}

# ── 1. Backend (Fastify on port 3000) ──────────────────────
info "Starting backend (port 3000)…"
nohup bash -c "cd '$BACKEND' && npx tsx watch src/index.ts" \
  > "$LOGDIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$LOGDIR/backend.pid"
disown "$BACKEND_PID"

wait_for_port 3000 "Backend" 30
ok "Backend ready  → http://127.0.0.1:3000  (PID $BACKEND_PID)"

# ── 2. Web / Admin (Next.js on port 3001) ──────────────────
info "Starting web (port 3001)…"
nohup bash -c "cd '$WEB' && npx next dev -p 3001" \
  > "$LOGDIR/web.log" 2>&1 &
WEB_PID=$!
echo "$WEB_PID" > "$LOGDIR/web.pid"
disown "$WEB_PID"

wait_for_port 3001 "Web" 30
ok "Web ready      → http://127.0.0.1:3001  (PID $WEB_PID)"

# ── 3. Widget (Vite on port 5173) ──────────────────────────
info "Starting widget (port 5173)…"
nohup bash -c "cd '$FRONTEND' && npx vite --host --port 5173" \
  > "$LOGDIR/widget.log" 2>&1 &
WIDGET_PID=$!
echo "$WIDGET_PID" > "$LOGDIR/widget.pid"
disown "$WIDGET_PID"

wait_for_port 5173 "Widget" 20
ok "Widget ready   → http://127.0.0.1:5173  (PID $WIDGET_PID)"

# ── Done ────────────────────────────────────────────────────
echo ""
echo -e "${C_GREEN}╔══════════════════════════════════════════╗${C_RESET}"
echo -e "${C_GREEN}║  ✅ All dev servers running!              ║${C_RESET}"
echo -e "${C_GREEN}╚══════════════════════════════════════════╝${C_RESET}"
echo ""
echo "  🔧 Backend:  http://127.0.0.1:3000   (PID $BACKEND_PID)"
echo "  🌐 Web:      http://127.0.0.1:3001   (PID $WEB_PID)"
echo "  💬 Widget:   http://127.0.0.1:5173   (PID $WIDGET_PID)"
echo ""
echo "  📋 Logs:     $LOGDIR/"
echo "  🩺 Verify:   bash scripts/verify-local.sh"
echo "  🛑 Stop:     bash scripts/dev-down.sh"
echo ""
echo -e "${C_DIM}  ⚠  Run tests/lint/typecheck in a SEPARATE terminal.${C_RESET}"
echo -e "${C_DIM}  ⚠  Never run 'next build' while 'next dev' is active.${C_RESET}"
echo ""
