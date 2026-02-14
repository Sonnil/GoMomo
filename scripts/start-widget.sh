#!/bin/zsh
# Lightweight dev helper to start the widget reliably.
# vite.config.ts already defaults host to 127.0.0.1 (IPv4-deterministic).

export PATH="$HOME/.nvm/versions/node/v20.19.4/bin:$PATH"
cd "$(dirname "$0")/../src/frontend" || exit 1

exec npx vite --port 5173
