#!/usr/bin/env node
/**
 * Backfill outbox message_sids from Twilio API + send a fresh test SMS.
 * 
 * Usage: node scripts/backfill-and-send.mjs
 */

import https from 'node:https';
import pg from 'pg';
const { Client } = pg;

const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '+18445731475';
const TO_NUMBER   = process.env.TEST_TO_NUMBER || '+16892568400';
const DB_URL      = process.env.DATABASE_URL || 'postgresql://receptionist:receptionist_dev@localhost:5432/receptionist';
const TENANT_ID   = '00000000-0000-4000-a000-000000000001';

function twilioGet(path) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.twilio.com', path,
      headers: { Authorization: `Basic ${auth}` },
      rejectUnauthorized: false, timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function twilioPost(path, formBody) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.twilio.com', path, method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
      rejectUnauthorized: false, timeout: 15000,
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          data._statusCode = res.statusCode;
          resolve(data);
        } catch { reject(new Error(`Invalid JSON: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(formBody);
    req.end();
  });
}

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  console.log('\n═══ Step 1: Backfill outbox message_sids from Twilio ═══\n');

  // Get all Twilio messages
  const twilioData = await twilioGet(`/2010-04-01/Accounts/${TWILIO_SID}/Messages.json?PageSize=20`);
  const twilioMsgs = twilioData.messages || [];
  console.log(`  Twilio has ${twilioMsgs.length} messages`);

  // Get outbox entries without message_sid
  const { rows: noSid } = await db.query(
    `SELECT id, status, created_at FROM sms_outbox WHERE tenant_id = $1 AND message_sid IS NULL ORDER BY created_at DESC`,
    [TENANT_ID],
  );
  console.log(`  Outbox entries without message_sid: ${noSid.length}`);

  // Match by timestamp proximity (within 5 seconds)
  for (const row of noSid) {
    const rowTime = new Date(row.created_at).getTime();
    const match = twilioMsgs.find(m => {
      const tTime = new Date(m.date_created).getTime();
      return Math.abs(tTime - rowTime) < 10000; // 10 second window
    });
    if (match) {
      await db.query('UPDATE sms_outbox SET message_sid = $1 WHERE id = $2', [match.sid, row.id]);
      console.log(`  ✅ Matched outbox ${row.id.slice(0, 8)}... → SID ...${match.sid.slice(-8)} (Δ${Math.abs(new Date(match.date_created).getTime() - rowTime)}ms)`);
    } else {
      console.log(`  ⚠️  No Twilio match for outbox ${row.id.slice(0, 8)}... (created ${row.created_at})`);
    }
  }

  console.log('\n═══ Step 2: Send fresh test SMS (message_sid will be captured) ═══\n');

  // Insert a test outbox entry (scheduled_at is NOT NULL)
  const { rows: [inserted] } = await db.query(
    `INSERT INTO sms_outbox (tenant_id, phone, body, message_type, booking_id, status, attempts, max_attempts, scheduled_at)
     VALUES ($1, $2, $3, 'confirmation', 'e2e-delivery-test-' || extract(epoch from now())::text, 'sending', 1, 1, NOW())
     RETURNING id`,
    [TENANT_ID, TO_NUMBER, 'gomomo Demo Clinic: Delivery tracking E2E test — ' + new Date().toISOString()],
  );
  console.log(`  Created outbox entry: ${inserted.id}`);

  // Send via Twilio
  const formParams = new URLSearchParams({
    To: TO_NUMBER,
    From: FROM_NUMBER,
    Body: 'gomomo Demo Clinic: Delivery tracking E2E test — ' + new Date().toISOString(),
  });
  
  const sendResult = await twilioPost(
    `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    formParams.toString(),
  );

  if (sendResult.sid) {
    console.log(`  ✅ Twilio accepted — SID: ${sendResult.sid} (status: ${sendResult.status})`);
    
    // Store message_sid in outbox
    await db.query(
      `UPDATE sms_outbox SET message_sid = $1, status = 'sent', updated_at = NOW() WHERE id = $2`,
      [sendResult.sid, inserted.id],
    );
    console.log(`  ✅ message_sid stored in outbox`);
  } else {
    console.log(`  ❌ Twilio error: ${sendResult.message ?? JSON.stringify(sendResult)}`);
    await db.query(
      `UPDATE sms_outbox SET status = 'failed', last_error = $1, updated_at = NOW() WHERE id = $2`,
      [sendResult.message ?? 'unknown', inserted.id],
    );
  }

  console.log('\n═══ Step 3: Wait 10s then poll for delivery status ═══\n');
  console.log('  Waiting 10 seconds for Twilio to process...');
  await new Promise(r => setTimeout(r, 10000));

  // Poll all outbox entries with message_sid
  const { rows: toCheck } = await db.query(
    `SELECT id, message_sid, message_type, provider_status FROM sms_outbox
     WHERE tenant_id = $1 AND message_sid IS NOT NULL
     ORDER BY created_at DESC LIMIT 10`,
    [TENANT_ID],
  );

  console.log(`  Polling ${toCheck.length} outbox entries...\n`);

  for (const row of toCheck) {
    try {
      const msg = await twilioGet(`/2010-04-01/Accounts/${TWILIO_SID}/Messages/${row.message_sid}.json`);
      const status = msg.status;
      const errCode = (msg.error_code && msg.error_code !== 0) ? msg.error_code : null;

      await db.query(
        `UPDATE sms_outbox SET provider_status = $1, error_code = COALESCE($2, error_code), updated_at = NOW() WHERE id = $3`,
        [status, errCode, row.id],
      );
      console.log(`  ...${row.message_sid.slice(-4)} [${row.message_type}] → ${status}${errCode ? ` (err: ${errCode})` : ''}`);
    } catch (err) {
      console.log(`  ...${row.message_sid.slice(-4)} → error: ${err.message}`);
    }
  }

  // Final state
  console.log('\n═══ Step 4: Final outbox state ═══\n');
  const { rows: final } = await db.query(
    `SELECT id, status, message_type, message_sid, provider_status, error_code, last_error
     FROM sms_outbox WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [TENANT_ID],
  );
  for (const r of final) {
    console.log(`  [${r.message_type}] outbox_status=${r.status} | sid=...${r.message_sid?.slice(-4) ?? 'none'} | provider=${r.provider_status ?? '-'} | err=${r.error_code ?? '-'} | last_error=${r.last_error?.slice(0, 60) ?? '-'}`);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ✅ E2E delivery tracking verification complete');
  console.log('═══════════════════════════════════════════════════════\n');

  await db.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
