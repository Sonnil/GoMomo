#!/usr/bin/env node
/**
 * demo:smoke — Lightweight smoke test for the AI Receptionist demo stack.
 *
 * Verifies:
 *   1. POST /api/auth/session → token + session_id
 *   2. Socket.IO connects
 *   3. join emitted → server responds with 'joined'
 *   4. message "hello" → assistant 'response' event
 *
 * No external deps — uses socket.io-client already installed in src/frontend.
 * Exit 0 = all pass, Exit 1 = failure.
 */

'use strict';

const path = require('path');

// Resolve socket.io-client from the frontend workspace (already installed)
const frontendModules = path.resolve(__dirname, '..', 'src', 'frontend', 'node_modules');
const { io } = require(path.join(frontendModules, 'socket.io-client'));

const API = process.env.API_URL || 'http://localhost:3000';
const TENANT = '00000000-0000-4000-a000-000000000001';
const TIMEOUT = 15_000; // 15s per step

// ── Helpers ────────────────────────────────────────────────

let stepNum = 0;
const startTime = Date.now();

function elapsed() {
  return `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
}

function pass(label, detail) {
  stepNum++;
  console.log(`  ✅ Step ${stepNum}: ${label}${detail ? '  (' + detail + ')' : ''}`);
}

function fail(label, reason) {
  stepNum++;
  console.error(`  ❌ Step ${stepNum}: ${label}  — ${reason}`);
  process.exit(1);
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${TIMEOUT / 1000}s`)), TIMEOUT)
    ),
  ]).catch(err => fail(label, err.message));
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log('\n  🔬 Demo Smoke Test\n  ─────────────────────────────\n');

  // Step 1 — Token acquisition
  let token, sessionId;
  await withTimeout((async () => {
    const res = await fetch(`${API}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: TENANT }),
    });
    if (!res.ok) return fail('Token acquisition', `HTTP ${res.status}`);
    const body = await res.json();
    if (!body.token) return fail('Token acquisition', 'No token in response');
    token = body.token;
    sessionId = body.session_id;
    pass('Token acquisition', `session=${sessionId.slice(0, 8)}…`);
  })(), 'Token acquisition');

  // Step 2 — Socket.IO connect
  const socket = io(API, { path: '/ws', transports: ['websocket', 'polling'] });

  await withTimeout(new Promise((resolve, reject) => {
    socket.on('connect', () => {
      pass('WebSocket connect', `id=${socket.id}`);
      resolve();
    });
    socket.on('connect_error', (err) => reject(new Error(err.message)));
  }), 'WebSocket connect');

  // Step 3 — Join tenant
  await withTimeout(new Promise((resolve, reject) => {
    socket.emit('join', { tenant_id: TENANT, session_id: sessionId, token });
    socket.once('joined', (data) => {
      pass('Join tenant', `session=${data.session_id?.slice(0, 8)}…`);
      resolve();
    });
    socket.once('error', (data) => reject(new Error(data.error)));
  }), 'Join tenant');

  // Step 4 — Chat response
  await withTimeout(new Promise((resolve, reject) => {
    socket.emit('message', { message: 'hello' });
    socket.once('response', (data) => {
      if (!data.response || data.response.length === 0) return reject(new Error('Empty response'));
      pass('Chat response', `${data.response.length} chars`);
      resolve();
    });
    socket.once('error', (data) => reject(new Error(data.error)));
  }), 'Chat response');

  // Done
  socket.disconnect();
  console.log(`\n  ✅ All 4 steps passed  (${elapsed()})\n`);
  process.exit(0);
}

main().catch(err => {
  console.error(`\n  ❌ Unexpected error: ${err.message}\n`);
  process.exit(1);
});
