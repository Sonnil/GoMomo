/**
 * Race-Condition Integration Tests
 * =================================
 * Tests concurrent booking scenarios against a real PostgreSQL database
 * to verify that the EXCLUDE constraints and SERIALIZABLE transactions
 * prevent overbooking.
 *
 * Prerequisites:
 *   - PostgreSQL running with DATABASE_URL configured
 *   - Migrations applied (npm run migrate)
 *   - Seed data loaded (npm run seed)
 *
 * Run:
 *   npx tsx tests/race-condition.test.ts
 */

import pg from 'pg';
import { randomUUID } from 'crypto';

// ── Config ──────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/ai_receptionist';
const NUM_CONCURRENT = 10; // Number of parallel booking attempts
const HOLD_TTL_MINUTES = 5;

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: NUM_CONCURRENT + 5,
});

// ── Helpers ─────────────────────────────────────────────────────
async function ensureExtensions() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "btree_gist"`);
}

async function createTestTenant(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, slug, timezone, slot_duration, business_hours, services)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      'Race Test Clinic',
      `race-test-${randomUUID().slice(0, 8)}`,
      'America/New_York',
      30,
      JSON.stringify({
        monday: { start: '09:00', end: '17:00' },
        tuesday: { start: '09:00', end: '17:00' },
        wednesday: { start: '09:00', end: '17:00' },
        thursday: { start: '09:00', end: '17:00' },
        friday: { start: '09:00', end: '16:00' },
        saturday: null,
        sunday: null,
      }),
      JSON.stringify([{ name: 'Consultation', duration: 30 }]),
    ],
  );
  return rows[0].id;
}

function generateRefCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'APT-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ── Test 1: Concurrent holds for the same slot ──────────────────
async function testConcurrentHolds(tenantId: string) {
  console.log('\n📝 Test 1: Concurrent hold attempts for the SAME slot');
  console.log(`   Firing ${NUM_CONCURRENT} parallel INSERT into availability_holds…`);

  const startTime = new Date('2026-06-15T14:00:00Z');
  const endTime = new Date('2026-06-15T14:30:00Z');
  const expiresAt = new Date(Date.now() + HOLD_TTL_MINUTES * 60 * 1000);

  const results = await Promise.allSettled(
    Array.from({ length: NUM_CONCURRENT }, (_, i) =>
      pool.query(
        `INSERT INTO availability_holds (tenant_id, session_id, start_time, end_time, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [tenantId, `session-hold-${i}`, startTime.toISOString(), endTime.toISOString(), expiresAt.toISOString()],
      ),
    ),
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(`   ✅ Succeeded: ${succeeded}  ❌ Rejected (EXCLUDE): ${failed}`);

  if (succeeded > 1) {
    console.error('   🚨 FAIL: More than 1 hold was created for the same slot!');
    return false;
  }
  if (succeeded === 1 && failed === NUM_CONCURRENT - 1) {
    console.log('   ✅ PASS: Exactly 1 hold succeeded, all others rejected by EXCLUDE constraint.');
    return true;
  }

  console.warn(`   ⚠️  Unexpected result: ${succeeded} succeeded, ${failed} failed`);
  return false;
}

// ── Test 2: Concurrent appointment inserts for the same slot ────
async function testConcurrentAppointments(tenantId: string) {
  console.log('\n📝 Test 2: Concurrent appointment inserts for the SAME slot');
  console.log(`   Firing ${NUM_CONCURRENT} parallel INSERT into appointments…`);

  const startTime = new Date('2026-06-16T10:00:00Z');
  const endTime = new Date('2026-06-16T10:30:00Z');

  const results = await Promise.allSettled(
    Array.from({ length: NUM_CONCURRENT }, (_, i) =>
      pool.query(
        `INSERT INTO appointments
         (tenant_id, reference_code, client_name, client_email, service, start_time, end_time, timezone, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          tenantId,
          generateRefCode(),
          `Client ${i}`,
          `client${i}@test.com`,
          'Consultation',
          startTime.toISOString(),
          endTime.toISOString(),
          'America/New_York',
          'confirmed',
        ],
      ),
    ),
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(`   ✅ Succeeded: ${succeeded}  ❌ Rejected (EXCLUDE): ${failed}`);

  if (succeeded > 1) {
    console.error('   🚨 FAIL: More than 1 appointment created for the same slot!');
    return false;
  }
  if (succeeded === 1 && failed === NUM_CONCURRENT - 1) {
    console.log('   ✅ PASS: Exactly 1 appointment succeeded, all others rejected by EXCLUDE constraint.');
    return true;
  }

  console.warn(`   ⚠️  Unexpected result: ${succeeded} succeeded, ${failed} failed`);
  return false;
}

// ── Test 3: SERIALIZABLE transaction retry ──────────────────────
async function testSerializableRetry(tenantId: string) {
  console.log('\n📝 Test 3: SERIALIZABLE transaction contention');
  console.log('   Two transactions both read, then try to write to the same slot…');

  const startTime = new Date('2026-06-17T11:00:00Z');
  const endTime = new Date('2026-06-17T11:30:00Z');

  async function bookInSerializableTxn(clientLabel: string): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Read: check if slot is free
      const { rows: existing } = await client.query(
        `SELECT id FROM appointments
         WHERE tenant_id = $1 AND status = 'confirmed'
           AND start_time < $3 AND end_time > $2`,
        [tenantId, startTime.toISOString(), endTime.toISOString()],
      );

      if (existing.length > 0) {
        await client.query('ROLLBACK');
        return false;
      }

      // Simulate some processing delay to increase contention
      await new Promise((r) => setTimeout(r, 50));

      // Write: insert appointment
      await client.query(
        `INSERT INTO appointments
         (tenant_id, reference_code, client_name, client_email, service, start_time, end_time, timezone, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          generateRefCode(),
          `Client-${clientLabel}`,
          `${clientLabel}@test.com`,
          'Consultation',
          startTime.toISOString(),
          endTime.toISOString(),
          'America/New_York',
          'confirmed',
        ],
      );

      await client.query('COMMIT');
      return true;
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error.code === '40001') {
        console.log(`   ↻ ${clientLabel}: serialization failure (40001) — would retry`);
        return false;
      }
      if (error.code === '23P01') {
        console.log(`   ✗ ${clientLabel}: EXCLUDE constraint violation — slot taken`);
        return false;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  const results = await Promise.allSettled([
    bookInSerializableTxn('txn-A'),
    bookInSerializableTxn('txn-B'),
    bookInSerializableTxn('txn-C'),
  ]);

  const succeeded = results.filter(
    (r) => r.status === 'fulfilled' && r.value === true,
  ).length;

  console.log(`   Winners: ${succeeded}/3`);

  if (succeeded <= 1) {
    console.log('   ✅ PASS: At most 1 transaction committed for the same slot.');
    return true;
  }
  console.error('   🚨 FAIL: Multiple transactions committed for the same slot!');
  return false;
}

// ── Test 4: Expired holds don't block new holds ─────────────────
async function testExpiredHoldsDontBlock(tenantId: string) {
  console.log('\n📝 Test 4: Expired holds should NOT block new holds');

  const startTime = new Date('2026-06-18T15:00:00Z');
  const endTime = new Date('2026-06-18T15:30:00Z');
  const alreadyExpired = new Date(Date.now() - 60000); // 1 minute ago

  // Insert an EXPIRED hold
  await pool.query(
    `INSERT INTO availability_holds (tenant_id, session_id, start_time, end_time, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, 'expired-session', startTime.toISOString(), endTime.toISOString(), alreadyExpired.toISOString()],
  );

  // Try to insert a fresh hold for the same slot
  const freshExpiry = new Date(Date.now() + 5 * 60 * 1000);
  try {
    await pool.query(
      `INSERT INTO availability_holds (tenant_id, session_id, start_time, end_time, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [tenantId, 'fresh-session', startTime.toISOString(), endTime.toISOString(), freshExpiry.toISOString()],
    );
    console.log('   ✅ PASS: New hold inserted despite expired hold on same slot.');
    return true;
  } catch (error: any) {
    if (error.code === '23P01') {
      console.error('   🚨 FAIL: EXCLUDE constraint blocked new hold due to expired hold!');
      console.error('   → The EXCLUDE constraint needs a WHERE (expires_at > NOW()) filter.');
      return false;
    }
    throw error;
  }
}

// ── Test 5: Hold idempotency via source_hold_id ─────────────────
async function testIdempotentBooking(tenantId: string) {
  console.log('\n📝 Test 5: Idempotent booking via source_hold_id');

  const startTime = new Date('2026-06-19T09:00:00Z');
  const endTime = new Date('2026-06-19T09:30:00Z');
  const holdId = randomUUID();

  // Create a hold
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await pool.query(
    `INSERT INTO availability_holds (id, tenant_id, session_id, start_time, end_time, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [holdId, tenantId, 'idempotent-session', startTime.toISOString(), endTime.toISOString(), expiresAt.toISOString()],
  );

  // First booking succeeds
  const refCode1 = generateRefCode();
  await pool.query(
    `INSERT INTO appointments
     (tenant_id, reference_code, client_name, client_email, service,
      start_time, end_time, timezone, status, source_hold_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, reference_code`,
    [
      tenantId, refCode1, 'Idempotent User', 'idem@test.com', 'Consultation',
      startTime.toISOString(), endTime.toISOString(), 'America/New_York', 'confirmed', holdId,
    ],
  );

  // Second booking with same source_hold_id should fail (unique index)
  try {
    const refCode2 = generateRefCode();
    await pool.query(
      `INSERT INTO appointments
       (tenant_id, reference_code, client_name, client_email, service,
        start_time, end_time, timezone, status, source_hold_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tenantId, refCode2, 'Idempotent User', 'idem@test.com', 'Consultation',
        startTime.toISOString(), endTime.toISOString(), 'America/New_York', 'confirmed', holdId,
      ],
    );
    console.error('   🚨 FAIL: Duplicate source_hold_id was accepted!');
    return false;
  } catch (error: any) {
    if (error.code === '23505') {
      // unique_violation — expected
      console.log('   ✅ PASS: Duplicate source_hold_id correctly rejected (unique constraint).');
      return true;
    }
    if (error.code === '23P01') {
      // EXCLUDE constraint — also prevents it, which is fine
      console.log('   ✅ PASS: Duplicate rejected by EXCLUDE constraint (also valid).');
      return true;
    }
    throw error;
  }
}

// ── Cleanup ─────────────────────────────────────────────────────
async function cleanup(tenantId: string) {
  await pool.query('DELETE FROM availability_holds WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
}

// ── Runner ──────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  AI Receptionist — Race-Condition Test Suite  ');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Database: ${DATABASE_URL.replace(/\/\/.*:.*@/, '//***:***@')}`);
  console.log(`  Concurrency: ${NUM_CONCURRENT} parallel workers\n`);

  let tenantId: string | null = null;
  const results: { name: string; pass: boolean }[] = [];

  try {
    await ensureExtensions();
    tenantId = await createTestTenant();
    console.log(`  Test tenant created: ${tenantId}`);

    results.push({ name: 'Concurrent holds', pass: await testConcurrentHolds(tenantId) });
    results.push({ name: 'Concurrent appointments', pass: await testConcurrentAppointments(tenantId) });
    results.push({ name: 'Serializable txn', pass: await testSerializableRetry(tenantId) });
    results.push({ name: 'Expired holds passthrough', pass: await testExpiredHoldsDontBlock(tenantId) });
    results.push({ name: 'Idempotent booking', pass: await testIdempotentBooking(tenantId) });
  } finally {
    if (tenantId) await cleanup(tenantId);
    await pool.end();
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════');
  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? '✅' : '🚨';
    console.log(`  ${icon} ${r.name}`);
    if (!r.pass) allPass = false;
  }
  console.log('═══════════════════════════════════════════════');
  if (allPass) {
    console.log('  🎉 ALL TESTS PASSED');
  } else {
    console.log('  ❌ SOME TESTS FAILED');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
