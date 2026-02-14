#!/usr/bin/env bash
# ============================================================
# demo-stop.sh — Stop ALL gomomo.ai demo processes
#
# Kills processes by port, cleans stale PID files.
# Safe to run multiple times.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_DATA="$ROOT/.pg-data"
PG_DAEMON_PID="$ROOT/.pg-daemon.pid"

C_GREEN='\033[32m'
C_YELLOW='\033[33m'
C_RESET='\033[0m'

echo ""
echo "🛑  Stopping gomomo.ai demo stack…"
echo ""

killed=0

# Kill the pg-daemon Node process first (graceful SIGTERM)
if [ -f "$PG_DAEMON_PID" ]; then
  daemon_pid=$(cat "$PG_DAEMON_PID" 2>/dev/null || true)
  if [ -n "$daemon_pid" ] && kill -0 "$daemon_pid" 2>/dev/null; then
    echo "   Stopping pg-daemon (PID $daemon_pid)…"
    kill "$daemon_pid" 2>/dev/null || true
    # Wait up to 5s for graceful shutdown
    for i in $(seq 1 10); do
      kill -0 "$daemon_pid" 2>/dev/null || break
      sleep 0.5
    done
    # Force kill if still alive
    kill -9 "$daemon_pid" 2>/dev/null || true
    killed=$((killed + 1))
  fi
  rm -f "$PG_DAEMON_PID"
fi

for port in 5432 3000 5173 5174; do
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "   Killing port $port → PID(s): $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    killed=$((killed + 1))
  fi
done

# Clean stale Postgres PID file
if [ -f "$PG_DATA/postmaster.pid" ]; then
  rm -f "$PG_DATA/postmaster.pid"
  echo "   Removed stale $PG_DATA/postmaster.pid"
fi

if [ "$killed" -eq 0 ]; then
  echo -e "   ${C_GREEN}Nothing was running.${C_RESET}"
else
  echo ""
  echo -e "   ${C_GREEN}✅ All processes stopped.${C_RESET}"
fi

echo ""
