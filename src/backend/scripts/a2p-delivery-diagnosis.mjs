#!/usr/bin/env node
/**
 * A2P-aware SMS Delivery Diagnosis for local 10DLC sender +15738777070
 *
 * 1. Sends a single booking-confirmation-style SMS via Twilio REST API
 * 2. Polls Twilio Messages API for delivery status
 * 3. Reports: from number, provider_status, error_code, recommended action
 * 4. If A2P-related: prints Twilio Console checklist
 * 5. Confirms /health/sms shows config_status=ok, sender_type=local_10dlc
 *
 * NO PII logged — phone numbers masked in output.
 * Run: node scripts/a2p-delivery-diagnosis.mjs
 */
import https from 'node:https';
import http from 'node:http';

// ── Config ──────────────────────────────────────────────────
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '+15738777070';
const TO_NUMBER   = process.env.TEST_TO_NUMBER || '+16892568400';
const HEALTH_URL  = 'http://localhost:3000/health/sms';
const POLL_DELAY_MS = 5000;
const MAX_POLLS = 6;

// ── Helpers ─────────────────────────────────────────────────
const mask = (phone) => `***${phone.slice(-4)}`;

function twilioReq(method, path, formBody) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.twilio.com', path, method,
      headers: { Authorization: `Basic ${auth}` },
      rejectUnauthorized: false, timeout: 15_000,
    };
    if (method === 'POST' && formBody) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(formBody);
    }
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const d = JSON.parse(body);
          d._statusCode = res.statusCode;
          resolve(d);
        } catch {
          reject(new Error(`Bad JSON (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (formBody) req.write(formBody);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 10_000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Bad JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A2P Error Detection ─────────────────────────────────────
const A2P_ERROR_CODES = new Set([30004, 30005, 30006, 30007, 30034]);

function isA2PRelatedError(code) {
  return A2P_ERROR_CODES.has(code);
}

function errorRecommendation(code) {
  const map = {
    30001: 'Queue overflow — reduce send rate',
    30002: 'Account suspended — check Twilio compliance',
    30003: 'Unreachable destination — verify phone is active',
    30004: 'Blocked by carrier — A2P 10DLC registration required',
    30005: 'Unknown destination — phone may be invalid/ported',
    30006: 'Landline / unreachable — cannot SMS this number',
    30007: 'Carrier filtering — A2P 10DLC campaign required',
    30008: 'Unknown error — retry or contact Twilio support',
    30010: 'Price exceeds max — increase MaxPrice',
    30032: 'Toll-Free NOT VERIFIED — submit TF Verification in Twilio Console',
    30034: 'Message blocked by Twilio — prohibited content or A2P non-compliance',
    21211: 'Invalid "To" number — ensure E.164 format',
    21610: 'Recipient opted out (STOP)',
    21614: '"To" is not a mobile number',
  };
  return map[code] ?? `See https://www.twilio.com/docs/api/errors/${code}`;
}

// ═════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════
async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  A2P-Aware SMS Delivery Diagnosis');
  console.log('  Sender: +1573***7070 (local 10DLC)');
  console.log(`  Date:   ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════');

  // ── Step 1: Send a single booking confirmation SMS ────────
  console.log('\n── Step 1: Send booking confirmation SMS ──\n');

  const body = `[AI Receptionist Diagnosis] Booking confirmation test — sent ${new Date().toISOString().slice(0,19)}. This is an automated delivery test. Reply STOP to opt out.`;
  const formData = new URLSearchParams({
    To: TO_NUMBER,
    From: FROM_NUMBER,
    Body: body,
  }).toString();

  const sendResult = await twilioReq(
    'POST',
    `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    formData,
  );

  if (sendResult._statusCode >= 400) {
    console.log(`  ❌ SEND FAILED (HTTP ${sendResult._statusCode})`);
    console.log(`     Error code: ${sendResult.code ?? 'none'}`);
    console.log(`     Message:    ${sendResult.message ?? 'unknown'}`);
    if (sendResult.code) {
      console.log(`     Action:     ${errorRecommendation(sendResult.code)}`);
    }
    process.exit(1);
  }

  const sid = sendResult.sid;
  const fromUsed = sendResult.from ?? FROM_NUMBER;
  console.log(`  ✅ SMS queued successfully`);
  console.log(`     SID (last 4):    …${sid.slice(-4)}`);
  console.log(`     From:            ${mask(fromUsed)}`);
  console.log(`     To:              ${mask(TO_NUMBER)}`);
  console.log(`     Initial status:  ${sendResult.status}`);

  // ── Step 2: Poll Twilio for delivery status ───────────────
  console.log('\n── Step 2: Poll Twilio for delivery status ──\n');

  let finalStatus = sendResult.status;
  let errorCode = null;
  let pollCount = 0;

  while (pollCount < MAX_POLLS) {
    pollCount++;
    console.log(`  Poll ${pollCount}/${MAX_POLLS} — waiting ${POLL_DELAY_MS / 1000}s…`);
    await sleep(POLL_DELAY_MS);

    const msgData = await twilioReq(
      'GET',
      `/2010-04-01/Accounts/${TWILIO_SID}/Messages/${sid}.json`,
    );

    finalStatus = msgData.status ?? 'unknown';
    errorCode = (typeof msgData.error_code === 'number' && msgData.error_code !== 0)
      ? msgData.error_code
      : null;

    console.log(`  → status: ${finalStatus}${errorCode ? `, error_code: ${errorCode}` : ''}`);

    // Terminal states
    if (['delivered', 'undelivered', 'failed', 'canceled'].includes(finalStatus)) {
      break;
    }
  }

  // ── Step 3: Output diagnosis ──────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log('  DELIVERY DIAGNOSIS');
  console.log('══════════════════════════════════════════════════');
  console.log(`  From number:       ${mask(fromUsed)}`);
  console.log(`  Provider status:   ${finalStatus}`);
  console.log(`  Error code:        ${errorCode ?? '(none)'}`);
  if (errorCode) {
    console.log(`  Recommended action: ${errorRecommendation(errorCode)}`);
  } else if (finalStatus === 'delivered') {
    console.log(`  Recommended action: None — message delivered successfully ✅`);
  } else if (finalStatus === 'undelivered' && !errorCode) {
    console.log(`  Recommended action: Carrier filtering suspected — verify A2P 10DLC registration`);
  } else if (['queued', 'sending', 'sent'].includes(finalStatus)) {
    console.log(`  Note: Status not yet terminal after ${MAX_POLLS} polls. May need more time or StatusCallback webhook.`);
  }

  // ── Step 4: A2P checklist if applicable ───────────────────
  if (errorCode && isA2PRelatedError(errorCode)) {
    console.log('\n══════════════════════════════════════════════════');
    console.log('  ⚠️  A2P 10DLC REGISTRATION CHECKLIST');
    console.log('══════════════════════════════════════════════════');
    console.log('  Complete these steps in the Twilio Console:');
    console.log('');
    console.log('  □ a) Brand Registration approved');
    console.log('       → Twilio Console → Messaging → Brands → verify status = "Approved"');
    console.log('');
    console.log('  □ b) Campaign approved');
    console.log('       → Twilio Console → Messaging → Campaigns → verify status = "Approved"');
    console.log('       → Campaign type: typically "Mixed" or "Customer Care"');
    console.log('');
    console.log('  □ c) Phone number +1573***7070 assigned to campaign');
    console.log('       → Twilio Console → Messaging → Campaigns → [your campaign] → Numbers');
    console.log('       → Confirm the local number appears in the campaign assignment');
    console.log('');
    console.log('  Until all three steps show "Approved", carriers may block or filter messages.');
  }

  if (finalStatus === 'undelivered' && !errorCode) {
    console.log('\n══════════════════════════════════════════════════');
    console.log('  ⚠️  A2P 10DLC REGISTRATION CHECKLIST');
    console.log('  (Undelivered with no error code = likely carrier filtering)');
    console.log('══════════════════════════════════════════════════');
    console.log('  □ a) Brand Registration approved');
    console.log('  □ b) Campaign approved');
    console.log('  □ c) Number +1573***7070 assigned to campaign');
  }

  // ── Step 5: Confirm /health/sms ───────────────────────────
  console.log('\n── Step 5: Confirm /health/sms ──\n');
  try {
    const health = await httpGet(HEALTH_URL);
    const tc = health.twilio_config ?? {};
    console.log(`  config status:     ${tc.status ?? 'unknown'}`);
    console.log(`  sender_type:       ${tc.sender_type ?? 'unknown'}`);
    console.log(`  a2p_status:        ${tc.a2p_status ?? 'unknown'}`);
    console.log(`  credential_mode:   ${tc.credential_mode ?? 'unknown'}`);
    console.log(`  send_mode:         ${tc.send_mode ?? 'unknown'}`);
    console.log(`  auth_verified:     ${tc.auth_verified ?? false}`);

    const configOk = tc.status === 'ok';
    const senderOk = tc.sender_type === 'local_10dlc';
    console.log('');
    console.log(`  ${configOk ? '✅' : '❌'} config_status = ${tc.status} (expected: ok)`);
    console.log(`  ${senderOk ? '✅' : '❌'} sender_type = ${tc.sender_type} (expected: local_10dlc)`);
  } catch (err) {
    console.log(`  ❌ Could not reach /health/sms: ${err.message}`);
    console.log(`     Is the backend running on port 3000?`);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  if (finalStatus === 'delivered') {
    console.log('  🎉 RESULT: SMS DELIVERED — local 10DLC sender is working');
  } else if (finalStatus === 'sent') {
    console.log('  ⏳ RESULT: SMS SENT (awaiting carrier delivery confirmation)');
  } else if (finalStatus === 'queued' || finalStatus === 'sending') {
    console.log('  ⏳ RESULT: SMS still in transit — check again in 30–60 seconds');
  } else {
    console.log(`  ⚠️  RESULT: SMS ${finalStatus.toUpperCase()}${errorCode ? ` (error ${errorCode})` : ''}`);
  }
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n❌ Diagnosis script failed:', err.message);
  process.exit(1);
});
