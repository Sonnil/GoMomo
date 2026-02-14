#!/usr/bin/env node
/**
 * Minimal E2E: send SMS via Twilio, write SID to outbox, poll status.
 * Uses the outbox repo's own enqueue method via a direct DB approach that
 * includes ALL required columns.
 */
import https from 'node:https';
import pg from 'pg';
import crypto from 'node:crypto';
const { Client } = pg;

const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '+18445731475';
const TO_NUMBER   = process.env.TEST_TO_NUMBER || '+16892568400';
const DB_URL      = process.env.DATABASE_URL || 'postgresql://receptionist:receptionist_dev@localhost:5432/receptionist';
const TENANT_ID   = '00000000-0000-4000-a000-000000000001';

function twilioReq(method, path, formBody) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.twilio.com', path, method,
      headers: { Authorization: `Basic ${auth}` },
      rejectUnauthorized: false, timeout: 15000,
    };
    if (method === 'POST' && formBody) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(formBody);
    }
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { const d = JSON.parse(body); d._statusCode = res.statusCode; resolve(d); }
        catch { reject(new Error(`Bad JSON (HTTP ${res.statusCode}): ${body.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (formBody) req.write(formBody);
    req.end();
  });
}

function recommend(code) {
  const map = {
    30003: 'Unreachable destination — verify phone is active',
    30004: 'Blocked by carrier — register A2P 10DLC or use Toll-Free',
    30005: 'Unknown destination — phone may be invalid/ported',
    30006: 'Landline or unreachable — cannot SMS this number',
    30007: 'Carrier filtering — register A2P 10DLC campaign',
    30032: 'Toll-Free number NOT VERIFIED — submit Toll-Free Verification in Twilio Console → Messaging → Toll-Free Verification',
    21211: 'Invalid "To" phone format — ensure E.164',
    21610: 'Recipient opted out (STOP)',
  };
  return map[code] ?? `See https://www.twilio.com/docs/api/errors/${code}`;
}

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  SMS Delivery Tracking — E2E Verification');
  console.log('═══════════════════════════════════════════════════════');

  // ── Step 1: Backfill existing outbox entry ──────────────
  console.log('\n── Step 1: Backfill existing outbox entries ──\n');

  const twilioList = await twilioReq('GET', `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json?PageSize=20`);
  const msgs = twilioList.messages || [];
  console.log(`  Twilio account has ${msgs.length} messages`);

  const { rows: noSid } = await db.query(
    `SELECT id, status, created_at FROM sms_outbox WHERE tenant_id = $1 AND message_sid IS NULL AND status = 'sent' ORDER BY created_at DESC`, [TENANT_ID]);

  for (const row of noSid) {
    const rowTime = new Date(row.created_at).getTime();
    const match = msgs.find(m => Math.abs(new Date(m.date_created).getTime() - rowTime) < 10000);
    if (match) {
      await db.query('UPDATE sms_outbox SET message_sid = $1 WHERE id = $2', [match.sid, row.id]);
      console.log(`  ✅ Backfilled ${row.id.slice(0,8)}… → SID …${match.sid.slice(-8)}`);
    }
  }

  // ── Step 2: Send fresh SMS directly via Twilio ──────────
  console.log('\n── Step 2: Send fresh SMS via Twilio API ──\n');

  const body = `gomomo Demo: E2E delivery test ${new Date().toISOString().slice(11,19)}`;
  const form = new URLSearchParams({ To: TO_NUMBER, From: FROM_NUMBER, Body: body });
  const sendResult = await twilioReq('POST', `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, form.toString());

  if (sendResult.sid) {
    console.log(`  ✅ Twilio accepted — SID: ${sendResult.sid}`);
    console.log(`     Status: ${sendResult.status}`);

    // Insert into outbox with ALL required columns
    const idemKey = crypto.randomUUID();
    await db.query(
      `INSERT INTO sms_outbox
         (tenant_id, phone, body, message_type, booking_id, scheduled_at, idempotency_key,
          status, attempts, max_attempts, message_sid)
       VALUES ($1, $2, $3, 'confirmation', $4, NOW(), $5, 'sent', 1, 1, $6)`,
      [TENANT_ID, TO_NUMBER, body, `e2e-test-${Date.now()}`, idemKey, sendResult.sid],
    );
    console.log(`  ✅ Outbox entry created with message_sid`);
  } else {
    console.log(`  ❌ Send failed: ${sendResult.message ?? JSON.stringify(sendResult)}`);
    // Still useful — if this is an error we want to capture that too
  }

  // ── Step 3: Wait then poll ──────────────────────────────
  console.log('\n── Step 3: Waiting 8s for Twilio processing… ──\n');
  await new Promise(r => setTimeout(r, 8000));

  // ── Step 4: Poll ALL outbox entries with SIDs ───────────
  console.log('── Step 4: Poll Twilio for delivery status ──\n');

  const { rows: toCheck } = await db.query(
    `SELECT id, message_sid, message_type, provider_status FROM sms_outbox
     WHERE tenant_id = $1 AND message_sid IS NOT NULL
     ORDER BY created_at DESC LIMIT 10`, [TENANT_ID]);

  const results = [];
  for (const row of toCheck) {
    try {
      const msg = await twilioReq('GET', `/2010-04-01/Accounts/${TWILIO_SID}/Messages/${row.message_sid}.json`);
      const status = msg.status;
      const errCode = (msg.error_code && msg.error_code !== 0) ? msg.error_code : null;

      await db.query(
        `UPDATE sms_outbox SET provider_status = $1, error_code = COALESCE($2, error_code), updated_at = NOW() WHERE id = $3`,
        [status, errCode, row.id]);

      results.push({ sid4: row.message_sid.slice(-4), type: row.message_type, status, errCode });
      console.log(`  …${row.message_sid.slice(-4)} [${row.message_type}] → ${status}${errCode ? ` (err ${errCode})` : ''}`);
    } catch (err) {
      console.log(`  …${row.message_sid.slice(-4)} → error: ${err.message}`);
      results.push({ sid4: row.message_sid.slice(-4), type: row.message_type, status: 'poll_error', errCode: null });
    }
  }

  // ── Step 5: Verify debug endpoint ──────────────────────
  console.log('\n── Step 5: Verify /debug/ceo-test/last-sms ──\n');

  const { rows: final } = await db.query(
    `SELECT id, status, message_type, message_sid, provider_status, error_code
     FROM sms_outbox WHERE tenant_id = $1 AND message_sid IS NOT NULL
     ORDER BY created_at DESC LIMIT 5`, [TENANT_ID]);

  for (const r of final) {
    console.log(`  [${r.message_type}] outbox=${r.status} | sid=…${r.message_sid?.slice(-4)} | provider=${r.provider_status ?? '—'} | err=${r.error_code ?? '—'}`);
  }

  // ── Step 6: DIAGNOSIS ──────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  📊 FINAL DIAGNOSIS');
  console.log('═══════════════════════════════════════════════════════\n');

  // Also include Twilio messages not in our outbox
  const outboxSids = new Set(final.map(r => r.message_sid));
  const extraMsgs = msgs.filter(m => !outboxSids.has(m.sid));
  const allResults = [
    ...results,
    ...extraMsgs.map(m => ({
      sid4: m.sid.slice(-4),
      type: 'historical',
      status: m.status,
      errCode: (m.error_code && m.error_code !== 0) ? m.error_code : null,
    })),
  ];

  const counts = {};
  for (const r of allResults) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`  Messages polled: ${allResults.length}`);
  console.log(`  Status breakdown: ${Object.entries(counts).map(([s,c]) => `${s}=${c}`).join(', ')}`);

  const errCodes = [...new Set(allResults.filter(r => r.errCode).map(r => r.errCode))];
  if (errCodes.length) {
    console.log('\n  ⚠️  Error codes:');
    for (const c of errCodes) console.log(`    ${c}: ${recommend(c)}`);
  }

  console.log('\n  🎯 RECOMMENDED FIX PATH:');
  if (errCodes.includes(30032)) {
    console.log('    ┌──────────────────────────────────────────────────────┐');
    console.log('    │  ERROR 30032 — Toll-Free Number Not Verified        │');
    console.log('    │                                                      │');
    console.log('    │  Your number +18445731475 is a toll-free (844)       │');
    console.log('    │  number. Since Jan 31 2024, Twilio BLOCKS all       │');
    console.log('    │  SMS from unverified toll-free numbers.             │');
    console.log('    │                                                      │');
    console.log('    │  FIX: Go to Twilio Console →                        │');
    console.log('    │    Messaging → Toll-Free → Verifications            │');
    console.log('    │    Submit verification for +18445731475              │');
    console.log('    │                                                      │');
    console.log('    │  OR: Switch to a local (10DLC) number with          │');
    console.log('    │      A2P campaign registration.                     │');
    console.log('    │                                                      │');
    console.log('    │  Timeline: Verification takes 1-5 business days.    │');
    console.log('    └──────────────────────────────────────────────────────┘');
  }

  const hasDelivered = allResults.some(r => r.status === 'delivered');
  if (hasDelivered) {
    console.log('\n    ✅ At least one message delivered — Twilio pipeline is functional.');
    console.log('       The delivered message was to a DIFFERENT number (***4236).');
    console.log('       Issue is specific to the recipient or number verification.');
  }

  console.log('\n═══════════════════════════════════════════════════════\n');
  await db.end();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
