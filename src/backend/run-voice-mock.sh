#!/bin/bash
cd "$(dirname "$0")"
export DATABASE_URL="postgres://x:x@localhost/x"
export OPENAI_API_KEY="sk-fake"
export VOICE_ENABLED="true"
npx tsx src/voice-mock-server.ts
