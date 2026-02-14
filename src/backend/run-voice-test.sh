#!/bin/bash
# Self-contained voice test: starts mock server, runs simulator, stops server
cd "$(dirname "$0")"

export DATABASE_URL="postgres://x:x@localhost/x"
export OPENAI_API_KEY="sk-fake"
export VOICE_ENABLED="true"

SCENARIO="${1:-book}"

echo "═══════════════════════════════════════════════"
echo "  Voice Channel E2E Test — Scenario: $SCENARIO"
echo "═══════════════════════════════════════════════"

# Kill anything on port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null
sleep 1

# Start server in background
npx tsx src/voice-mock-server.ts &>/tmp/voice-server.log &
SERVER_PID=$!
echo "✅ Server starting (PID=$SERVER_PID)..."

# Wait for server to be ready
for i in {1..20}; do
  if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "✅ Server ready on port 3000"
    break
  fi
  if [ $i -eq 20 ]; then
    echo "❌ Server failed to start. Log:"
    cat /tmp/voice-server.log
    kill $SERVER_PID 2>/dev/null
    exit 1
  fi
  sleep 0.5
done

echo ""

# Run simulator
npx tsx tests/voice-simulator.ts --scenario=$SCENARIO --base=http://localhost:3000
TEST_EXIT=$?

echo ""

# Stop server
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

if [ $TEST_EXIT -eq 0 ]; then
  echo "✅ Test completed successfully"
else
  echo "❌ Test failed (exit code: $TEST_EXIT)"
fi

exit $TEST_EXIT
