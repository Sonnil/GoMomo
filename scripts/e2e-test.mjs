#!/usr/bin/env node
// E2E test — simulates exactly what DemoChatWidget does
import http from 'http';
import { io } from 'socket.io-client';

function fetchJSON(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function main() {
  const TENANT = '00000000-0000-4000-a000-000000000001';

  // Step A: POST /api/auth/session
  console.log('\n=== Step A: POST /api/auth/session ===');
  const authRes = await fetchJSON('http://localhost:3000/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: TENANT }),
  });
  console.log('  Status:', authRes.status);
  console.log('  session_id:', authRes.data.session_id);
  console.log('  token (first 30):', (authRes.data.token || '').slice(0, 30) + '...');
  console.log('  expires_at:', authRes.data.expires_at);

  if (authRes.status !== 200 || !authRes.data.token) {
    console.error('  ❌ FAILED — cannot get token');
    process.exit(1);
  }
  console.log('  ✅ Token acquired');

  const token = authRes.data.token;
  const sessionId = authRes.data.session_id;

  // Step B: Connect Socket.IO
  console.log('\n=== Step B: Socket.IO connect ===');
  const socket = io('http://localhost:3000', {
    path: '/ws',
    transports: ['websocket', 'polling'],
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
    socket.on('connect', () => { clearTimeout(t); console.log('  ✅ Connected, socket.id:', socket.id); resolve(); });
    socket.on('connect_error', (err) => { clearTimeout(t); reject(err); });
  });

  // Step C: Emit join with token
  console.log('\n=== Step C: Emit join ===');
  console.log('  Emitting: { tenant_id, session_id, token }');
  socket.emit('join', {
    tenant_id: TENANT,
    session_id: sessionId,
    token: token,
  });

  const joinResult = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('join timeout')), 5000);
    socket.on('joined', (data) => { clearTimeout(t); resolve({ type: 'joined', data }); });
    socket.on('error', (data) => { clearTimeout(t); resolve({ type: 'error', data }); });
  });

  if (joinResult.type === 'error') {
    console.log('  ❌ Join rejected:', joinResult.data.error);
    socket.disconnect();
    process.exit(1);
  }
  console.log('  ✅ Joined — server session_id:', joinResult.data.session_id);

  // Step D: Send a message
  console.log('\n=== Step D: Chat message ===');
  socket.emit('message', { message: 'Hi, what services do you offer?' });

  const chatResult = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('chat timeout')), 15000);
    socket.on('response', (data) => { clearTimeout(t); resolve({ type: 'response', data }); });
    socket.on('error', (data) => { clearTimeout(t); resolve({ type: 'error', data }); });
  });

  if (chatResult.type === 'error') {
    console.log('  ❌ Chat error:', chatResult.data.error);
  } else {
    console.log('  ✅ AI response (' + chatResult.data.response.length + ' chars)');
    console.log('  Preview:', chatResult.data.response.slice(0, 100) + '...');
  }

  socket.disconnect();
  console.log('\n✅ All steps passed — flow works end-to-end');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
