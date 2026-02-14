#!/usr/bin/env node
/**
 * Quick verification script for Demo Availability Mode.
 * Run while the stack is up: node verify-demo.mjs
 */

const BASE = 'http://localhost:3000';
const TENANT = '00000000-0000-4000-a000-000000000001';

async function check(label, url) {
  try {
    const res = await fetch(url);
    const data = await res.json();
    console.log(`\n✅ ${label}`);
    console.log(JSON.stringify(data, null, 2));
    return data;
  } catch (err) {
    console.error(`\n❌ ${label}: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  Demo Availability Mode — Verification');
  console.log('═══════════════════════════════════════');

  // 1. Config endpoint
  const config = await check('GET /api/config', `${BASE}/api/config`);

  // 2. Availability for next Monday (guaranteed weekday)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
  const daysUntilMon = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : 8 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + daysUntilMon);
  const monStr = monday.toISOString().slice(0, 10);
  const start = `${monStr}T00:00:00`;
  const end = `${monStr}T23:59:59`;

  const slots = await check(
    `GET /availability (${monStr}, next Monday)`,
    `${BASE}/api/tenants/${TENANT}/availability?start=${start}&end=${end}`
  );

  // 3. Summary
  console.log('\n═══════════════════════════════════════');
  if (config?.demo_availability && slots?.slots?.length > 0) {
    console.log(`  ✅ PASS — Demo mode active, ${slots.slots.length} slots found for ${monStr}`);
  } else if (config?.demo_availability && (!slots?.slots || slots.slots.length === 0)) {
    console.log(`  ⚠️  Demo mode active but ZERO slots for ${monStr}`);
    console.log('  Check availability.service.ts logic');
  } else {
    console.log('  ❌ FAIL — Demo mode not active or API unreachable');
  }
  console.log('═══════════════════════════════════════');
}

main();
