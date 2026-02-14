#!/usr/bin/env node
/**
 * Standalone script: Query DB for outbox state, then poll Twilio delivery status.
 * 
 * This script:
 * 1. Reads sms_outbox for recent entries (direct DB query)
 * 2. For entries with message_sid from audit_log, backfills sms_outbox
 * 3. Polls Twilio Messages API for delivery status
 * 4. Updates sms_outbox with provider_status + error_code
 * 5. Prints diagnosis
 *
 * Usage: node scripts/poll-sms-status.mjs
 */

import https from 'node:https';
import pg from 'pg';
const { Client } = pg;

// ── Config ──────────────────────────────────────────────────
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const DB_URL      = process.env.DATABASE_URL || 'postgresql://receptionist:receptionist_dev@localhost:5432/receptionist';
const TENANT_ID   = '00000000-0000-4000-a000-000000000001';

// ── Helpers ─────────────────────────────────────────────────

/** HTTPS GET with rejectUnauthorized:false (corporate proxy TLS workaround) */
function twilioGet(path) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.twilio.com',
      path,
      headers: { Authorization: `Basic ${auth}` },
      rejectUnauthorized: false,
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON from Twilio')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Twilio timeout')));
  });
}

/** Map Twilio error codes to actionable recommendations */
function recommend(code) {
  const map = {
    30001: 'Queue overflow — reduce send rate',
    30002: 'Account suspended — check Twilio console',
    30003: 'Unreachable destination — verify phone is active',
    30004: 'Blocked by carrier — register A2P 10DLC or use Toll-Free',
    30005: 'Unknown destination — phone may be invalid/ported',
    30006: 'Landline or unreachable — cannot SMS this number',
    30007: 'Carrier filtering — register A2P 10DLC campaign',
    30008: 'Unknown error — retry or contact Twilio support',
    30034: 'Blocked by Twilio — may contain prohibited content',
    21211: 'Invalid To phone format — ensure E.164',
    21610: 'Recipient opted out (STOP) — cannot send until re-subscribe',
    21614: 'To number not valid mobile — cannot receive SMS',
  };
  return map[code] ?? `See https://www.twilio.com/docs/api/errors/${code}`;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  SMS Delivery Status Forensic Poll');
  console.log('═══════════════════════════════════════════════════════\n');

  // Step 1: Check outbox
  const { rows: outbox } = await db.query(
    `SELECT id, status, message_sid, message_type, provider_status, error_code, last_error,
            created_at, updated_at
     FROM sms_outbox WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT 10`,
    [TENANT_ID],
  );

  console.log(`📦 sms_outbox: ${outbox.length} entries found\n`);
  for (const r of outbox) {
    console.log(`  [${r.message_type}] status=${r.status} | message_sid=${r.message_sid ?? '(none)'} | provider=${r.provider_status ?? '(none)'} | err=${r.error_code ?? '-'}`);
  }

  // Step 2: Check audit_log for message_sids we can backfill
  const { rows: auditSids } = await db.query(
    `SELECT DISTINCT payload->>'message_sid' as sid, payload->>'message_sid_last4' as last4
     FROM audit_log
     WHERE tenant_id = $1
       AND event_type LIKE 'sms.%'
       AND payload->>'message_sid' IS NOT NULL
       AND payload->>'message_sid' != ''
     ORDER BY sid DESC
     LIMIT 10`,
    [TENANT_ID],
  );

  console.log(`\n📋 Audit log message SIDs: ${auditSids.length} found`);
  for (const a of auditSids) {
    console.log(`  SID: ${a.sid ? '...' + a.sid.slice(-8) : '(null)'} (last4: ${a.last4})`);
  }

  // Step 3: Backfill message_sid from audit_log into outbox where missing
  const noSidRows = outbox.filter(r => !r.message_sid && r.status === 'sent');
  if (noSidRows.length > 0 && auditSids.length > 0) {
    console.log(`\n🔧 Backfilling ${noSidRows.length} outbox entries with SIDs from audit log...`);
    for (const row of noSidRows) {
      // Find matching audit entry by outbox ID (entity_id in audit matches outbox id)
      const { rows: matchedAudit } = await db.query(
        `SELECT payload->>'message_sid' as sid
         FROM audit_log
         WHERE tenant_id = $1
           AND entity_id = $2
           AND event_type = 'sms.outbound_sent'
           AND payload->>'message_sid' IS NOT NULL
         LIMIT 1`,
        [TENANT_ID, row.id],
      );
      if (matchedAudit.length > 0 && matchedAudit[0].sid) {
        await db.query(
          'UPDATE sms_outbox SET message_sid = $1 WHERE id = $2',
          [matchedAudit[0].sid, row.id],
        );
        row.message_sid = matchedAudit[0].sid;
        console.log(`  ✅ Backfilled outbox ${row.id.slice(0, 8)}... → SID ...${matchedAudit[0].sid.slice(-8)}`);
      }
    }
  }

  // Step 4: Also check recent Twilio messages directly
  console.log('\n📡 Fetching recent messages from Twilio API...');
  let twilioMessages = [];
  try {
    const data = await twilioGet(`/2010-04-01/Accounts/${TWILIO_SID}/Messages.json?PageSize=10`);
    twilioMessages = data.messages || [];
    console.log(`  Found ${twilioMessages.length} messages on Twilio\n`);
  } catch (err) {
    console.log(`  ❌ Failed to fetch from Twilio: ${err.message}\n`);
  }

  // Step 5: Poll each message that has a SID
  const results = [];
  const rowsWithSid = outbox.filter(r => r.message_sid);

  // Also include Twilio messages not in outbox (sent before migration 016)
  const outboxSids = new Set(rowsWithSid.map(r => r.message_sid));
  const extraTwilioMessages = twilioMessages.filter(m => !outboxSids.has(m.sid));

  console.log('─── Polling Twilio for delivery status ───\n');

  // Poll outbox entries
  for (const row of rowsWithSid) {
    try {
      const msg = await twilioGet(`/2010-04-01/Accounts/${TWILIO_SID}/Messages/${row.message_sid}.json`);
      const status = msg.status;
      const errCode = (msg.error_code && msg.error_code !== 0) ? msg.error_code : null;

      // Update DB
      await db.query(
        `UPDATE sms_outbox SET provider_status = $1, error_code = COALESCE($2, error_code), updated_at = NOW()
         WHERE id = $3`,
        [status, errCode, row.id],
      );

      results.push({ sid_last4: row.message_sid.slice(-4), type: row.message_type, old: row.provider_status, new: status, error_code: errCode, source: 'outbox' });
      console.log(`  ✅ ...${row.message_sid.slice(-4)} [${row.message_type}] → ${status}${errCode ? ` (err: ${errCode})` : ''}`);
    } catch (err) {
      results.push({ sid_last4: row.message_sid.slice(-4), type: row.message_type, old: row.provider_status, new: 'poll_error', error_code: null, source: 'outbox' });
      console.log(`  ❌ ...${row.message_sid.slice(-4)} → poll failed: ${err.message}`);
    }
  }

  // Show extra Twilio messages (not in outbox)
  if (extraTwilioMessages.length > 0) {
    console.log(`\n  📌 Additional Twilio messages (sent before tracking):`);
    for (const m of extraTwilioMessages) {
      const errCode = (m.error_code && m.error_code !== 0) ? m.error_code : null;
      console.log(`  ...${m.sid.slice(-4)} → status=${m.status}${errCode ? ` err=${errCode}` : ''} | to=${m.to ? '***' + m.to.slice(-4) : '?'} | ${m.date_sent || m.date_created}`);
      results.push({ sid_last4: m.sid.slice(-4), type: 'historical', old: null, new: m.status, error_code: errCode, source: 'twilio_api' });
    }
  }

  // ── Step 6: Diagnosis ─────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  📊 DIAGNOSIS');
  console.log('═══════════════════════════════════════════════════════\n');

  const counts = {};
  for (const r of results) {
    counts[r.new] = (counts[r.new] || 0) + 1;
  }
  console.log('  Status summary:', JSON.stringify(counts));

  const errCodes = results.filter(r => r.error_code).map(r => r.error_code);
  const uniqueErrs = [...new Set(errCodes)];

  if (uniqueErrs.length > 0) {
    console.log('\n  ⚠️  Error codes found:');
    for (const code of uniqueErrs) {
      console.log(`    Error ${code}: ${recommend(code)}`);
    }
  }

  // Overall recommendation
  console.log('\n  🎯 Recommended next steps:');
  const hasUndelivered = results.some(r => r.new === 'undelivered');
  const hasFailed = results.some(r => r.new === 'failed');
  const hasDelivered = results.some(r => r.new === 'delivered');
  const hasQueued = results.some(r => r.new === 'queued' || r.new === 'accepted' || r.new === 'sending');

  if (hasDelivered) {
    console.log('    ✅ Some messages delivered successfully — Twilio pipeline working');
  }
  if (hasUndelivered && uniqueErrs.includes(30007)) {
    console.log('    🔴 Carrier filtering (30007) — MUST register A2P 10DLC campaign before production');
  }
  if (hasUndelivered && uniqueErrs.includes(30004)) {
    console.log('    🔴 Carrier blocked (30004) — register A2P 10DLC or switch to Toll-Free verified number');
  }
  if (hasUndelivered && !uniqueErrs.length) {
    console.log('    🟡 Undelivered with no error code — likely carrier filtering, register A2P 10DLC');
  }
  if (hasFailed) {
    console.log('    🔴 Failed messages — check Twilio error codes above for specific fixes');
  }
  if (hasQueued) {
    console.log('    🟡 Messages still queued — may be processing, check again in 60s');
  }
  if (!results.length) {
    console.log('    ℹ️  No messages with SIDs found — need to send a new SMS to capture delivery tracking');
  }

  console.log('\n═══════════════════════════════════════════════════════\n');

  await db.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
