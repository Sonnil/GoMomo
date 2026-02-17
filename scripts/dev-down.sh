#!/usr/bin/env bash
# ============================================================
# dev-down.sh — Stop the local dev stack (PID-based)
# ============================================================
# Reads PIDs from logs/*.pid and kills ONLY those processes.
# Safe to run multiple times. Idempotent.
#
# Falls back to port-based kill if PID files are missing.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$ROOT/logs"

C_GREEN='\033[1;32m'
C_YELLOW='\033[1;33m'
C_DIM='\033[2m'
C_RESET='\033[0m'

echo ""
echo "🛑  Stopping gomomo.ai dev stack…"
echo ""

killed=0

# ── Helper: kill a PID from a .pid file ─────────────────────
kill_by_pidfile() {
  local name="$1"
  local port="$2"
  local pidfile="$LOGDIR/${name}.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      # Kill the process tree (the nohup bash wrapper + its child)
      if kill -0 "$pid" 2>/dev/null; then
        echo "   Stopping $name (PID $pid)…"
        # Kill the whole process group rooted at $pid
        kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
        # Wait briefly for graceful shutdown
        for i in $(seq 1 6); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.5
        done
        # Force kill if still alive
        kill -9 "$pid" 2>/dev/null || true
        kill -9 -- -"$pid" 2>/dev/null || true
        killed=$((killed + 1))
      else
        echo -e "   ${C_DIM}$name (PID $pid) already stopped${C_RESET}"
      fi
    fi
    rm -f "$pidfile"
  fi

  # Fallback: kill anything still on the port
  local remaining
  remaining=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    echo "   Cleaning up port $port → PID(s): $remaining"
    echo "$remaining" | xargs kill -9 2>/dev/null || true
    killed=$((killed + 1))
  fi
}

# ── Kill each service ──────────────────────────────────────
kill_by_pidfile "widget"  5173
kill_by_pidfile "web"     3001
kill_by_pidfile "backend" 3000

# ── Report ─────────────────────────────────────────────────
echo ""
if [ "$killed" -eq 0 ]; then
  echo -e "   ${C_GREEN}Nothing was running.${C_RESET}"
else
  echo -e "   ${C_GREEN}✅ Dev stack stopped ($killed service(s) killed).${C_RESET}"
fi
echo ""
