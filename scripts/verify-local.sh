#!/bin/zsh
# Quick local verification with timeouts to avoid hangs. Safe to run in CI/local shells.

export PATH="$HOME/.nvm/versions/node/v20.19.4/bin:$PATH"

echo "=== DB ==="
node -e "const{Client}=require('pg');const c=new Client('postgresql://receptionist:receptionist_dev@localhost:5432/receptionist');c.connect().then(()=>c.query('SELECT 1 as ok')).then(r=>{console.log('DB: OK');c.end()}).catch(e=>{console.error('DB: FAIL', e.message);process.exit(1)})" || true

echo "=== BACKEND ==="
curl -4 --max-time 2 -s http://127.0.0.1:3000/health || echo "BACKEND: unreachable or timed out"

echo "=== WEB ==="
curl -4 --max-time 2 -s -o /dev/null -w "WEB:%{http_code}\n" http://127.0.0.1:3001/ || echo "WEB: unreachable or timed out"

echo "=== WIDGET ==="
# Use IPv4 address and small timeout to avoid hangs when localhost resolves to IPv6 first
curl -4 --max-time 2 -s -o /dev/null -w "WIDGET:%{http_code}\n" http://127.0.0.1:5173/ || echo "WIDGET: unreachable or timed out"

echo "=== SOCKET.IO (probe) ==="
curl -4 --max-time 3 -s "http://127.0.0.1:3000/ws/?EIO=4&transport=polling" | sed -n '1,200p' || echo "SOCKET.IO: probe failed or timed out"

echo "=== PORTS LISTENING ==="
lsof -nP -iTCP:3000 -iTCP:3001 -iTCP:5173 -iTCP:5432 -sTCP:LISTEN 2>/dev/null | awk '{print $1, $2, $9}' || true
