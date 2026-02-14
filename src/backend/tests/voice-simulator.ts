#!/usr/bin/env tsx
/**
 * Voice Call Simulator — Local Testing
 *
 * Simulates Twilio webhook calls to test the voice flow without a real phone.
 * Sends form-encoded POST requests just like Twilio does.
 *
 * Usage:
 *   npx tsx tests/voice-simulator.ts
 *   npx tsx tests/voice-simulator.ts --scenario=cancel
 *   npx tsx tests/voice-simulator.ts --base=http://localhost:3000
 *
 * Scenarios: book (default), cancel, silence, unknown, handoff
 */

const BASE = process.argv.find((a) => a.startsWith('--base='))?.split('=')[1] ?? 'http://localhost:3000';
const SCENARIO = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1] ?? 'book';
const CALL_SID = `CA_test_${Date.now()}`;

// ── Helpers ─────────────────────────────────────────────────────

async function post(path: string, body: Record<string, string>): Promise<string> {
  const formBody = new URLSearchParams(body).toString();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
  const text = await res.text();
  return text;
}

function extractSay(twiml: string): string {
  // Extract text between <Say ...> and </Say>
  const matches = twiml.match(/<Say[^>]*>([\s\S]*?)<\/Say>/g) ?? [];
  return matches
    .map((m) => m.replace(/<Say[^>]*>/, '').replace(/<\/Say>/, ''))
    .join('\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function hasGather(twiml: string): boolean {
  return twiml.includes('<Gather');
}

function hasHangup(twiml: string): boolean {
  return twiml.includes('<Hangup');
}

async function speak(speech: string, label?: string): Promise<string> {
  const body: Record<string, string> = {
    CallSid: CALL_SID,
    From: '+15551234567',
    To: '+15559876543',
    CallStatus: 'in-progress',
  };
  if (speech) body.SpeechResult = speech;

  const path = speech ? '/twilio/voice/continue' : '/twilio/voice/continue?timeout=true';

  console.log(`\n📞 Caller: "${speech || '(silence)'}"${label ? ` [${label}]` : ''}`);
  const twiml = await post(path, body);

  const said = extractSay(twiml);
  const gathering = hasGather(twiml);
  const hangingUp = hasHangup(twiml);

  console.log(`🤖 Bot: "${said}"`);
  if (gathering) console.log(`   ↳ [Waiting for speech...]`);
  if (hangingUp) console.log(`   ↳ [Hanging up]`);

  return twiml;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Scenarios ───────────────────────────────────────────────────

async function scenarioBook(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════');
  console.log('📞 SCENARIO: Happy Path Booking');
  console.log('═══════════════════════════════════════════════');

  // 1. Incoming call
  console.log('\n📞 [Incoming call...]');
  const greeting = await post('/twilio/voice/incoming', {
    CallSid: CALL_SID,
    From: '+15551234567',
    To: '+15559876543',
    CallStatus: 'ringing',
  });
  console.log(`🤖 Bot: "${extractSay(greeting)}"`);
  await sleep(300);

  // 2. Intent
  await speak('I would like to book an appointment');
  await sleep(300);

  // 3. Service
  await speak('General consultation');
  await sleep(300);

  // 4. Date
  await speak('Tomorrow');
  await sleep(300);

  // 5. Slot choice
  await speak('The first one');
  await sleep(300);

  // 6. Name
  await speak('My name is Alex Morrison');
  await sleep(300);

  // 7. Email
  await speak('alex at example dot com');
  await sleep(300);

  // 8. Confirm
  const result = await speak('Yes, please confirm');
  if (hasHangup(result)) {
    console.log('\n✅ Booking flow completed!');
  }
}

async function scenarioCancel(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════');
  console.log('📞 SCENARIO: Cancel Appointment');
  console.log('═══════════════════════════════════════════════');

  console.log('\n📞 [Incoming call...]');
  const greeting = await post('/twilio/voice/incoming', {
    CallSid: CALL_SID,
    From: '+15551234567',
    To: '+15559876543',
    CallStatus: 'ringing',
  });
  console.log(`🤖 Bot: "${extractSay(greeting)}"`);
  await sleep(300);

  await speak('I need to cancel my appointment');
  await sleep(300);

  await speak('APT-ABC123', 'reference code');
  await sleep(300);

  const result = await speak('Yes, cancel it');
  if (hasHangup(result)) {
    console.log('\n✅ Cancel flow completed!');
  }
}

async function scenarioSilence(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════');
  console.log('📞 SCENARIO: Caller Silence (Timeout)');
  console.log('═══════════════════════════════════════════════');

  console.log('\n📞 [Incoming call...]');
  const greeting = await post('/twilio/voice/incoming', {
    CallSid: CALL_SID,
    From: '+15551234567',
    To: '+15559876543',
    CallStatus: 'ringing',
  });
  console.log(`🤖 Bot: "${extractSay(greeting)}"`);
  await sleep(300);

  // 3 rounds of silence
  for (let i = 1; i <= 4; i++) {
    console.log(`\n📞 Caller: (silence - timeout #${i})`);
    const twiml = await post('/twilio/voice/continue?timeout=true', {
      CallSid: CALL_SID,
      From: '+15551234567',
      To: '+15559876543',
      CallStatus: 'in-progress',
    });
    console.log(`🤖 Bot: "${extractSay(twiml)}"`);
    if (hasHangup(twiml)) {
      console.log('\n✅ Silence handling completed (call ended after max retries)');
      return;
    }
    await sleep(300);
  }
}

async function scenarioUnknown(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════');
  console.log('📞 SCENARIO: Unrecognized Intent');
  console.log('═══════════════════════════════════════════════');

  console.log('\n📞 [Incoming call...]');
  const greeting = await post('/twilio/voice/incoming', {
    CallSid: CALL_SID,
    From: '+15551234567',
    To: '+15559876543',
    CallStatus: 'ringing',
  });
  console.log(`🤖 Bot: "${extractSay(greeting)}"`);
  await sleep(300);

  await speak('What is the meaning of life?');
  await sleep(300);

  await speak('Tell me about the weather');
  await sleep(300);

  await speak('How does quantum computing work?');
  await sleep(300);

  // After retries, bot should still ask for intent or provide help
  await speak('I want to book an appointment', 'finally gives valid intent');
}

async function scenarioHandoff(): Promise<void> {
  console.log('\n═══════════════════════════════════════════════');
  console.log('📞 SCENARIO: SMS Handoff (caller requests text link)');
  console.log('═══════════════════════════════════════════════');

  // 1. Incoming call
  console.log('\n📞 [Incoming call...]');
  const greeting = await post('/twilio/voice/incoming', {
    CallSid: CALL_SID,
    From: '+15551234567',
    To: '+15559876543',
    CallStatus: 'ringing',
  });
  console.log(`🤖 Bot: "${extractSay(greeting)}"`);
  await sleep(300);

  // 2. Start booking
  await speak('I want to book an appointment');
  await sleep(300);

  // 3. Service
  await speak('General consultation');
  await sleep(300);

  // 4. Date
  await speak('Tomorrow');
  await sleep(300);

  // 5. Slot choice
  await speak('The first one');
  await sleep(300);

  // 6. Now caller gives up on voice — asks for text link
  console.log('\n📱 [Caller requests SMS handoff...]');
  const handoffResult = await speak('Can you just text me a link instead?', 'handoff request');

  const handoffSay = extractSay(handoffResult);
  const handoffHangup = hasHangup(handoffResult);

  if (handoffSay.toLowerCase().includes('text') || handoffSay.toLowerCase().includes('sms') || handoffSay.toLowerCase().includes('link')) {
    console.log('\n✅ SMS handoff detected in response!');
  } else {
    console.log('\n⚠️  Expected handoff response, got:', handoffSay);
  }

  if (handoffHangup) {
    console.log('✅ Call ending after handoff (expected)');
  }

  await sleep(500);

  // ── Test handoff API endpoints ────────────────────────────────

  console.log('\n───────────────────────────────────────────────');
  console.log('🔗 Testing Handoff API Endpoints...');
  console.log('───────────────────────────────────────────────');

  // Test POST /handoff/sms
  console.log('\n📤 POST /handoff/sms (create token & send SMS)');
  try {
    const smsRes = await fetch(`${BASE}/handoff/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callSid: CALL_SID }),
    });
    const smsData = await smsRes.json() as Record<string, any>;
    console.log(`   Status: ${smsRes.status}`);
    console.log(`   Response: ${JSON.stringify(smsData, null, 2)}`);

    // If we got a webChatUrl/resumeUrl with a token, test the resume endpoint
    const chatUrl = (smsData.webChatUrl ?? smsData.resumeUrl) as string | undefined;
    if (chatUrl) {
      const tokenMatch = chatUrl.match(/[?&]handoff=([^&]+)/);
      if (tokenMatch) {
        const token = tokenMatch[1];
        console.log(`\n📥 GET /handoff/resume?token=${token.substring(0, 20)}...`);
        const resumeRes = await fetch(`${BASE}/handoff/resume?token=${encodeURIComponent(token)}`);
        const resumeData = await resumeRes.json();
        console.log(`   Status: ${resumeRes.status}`);
        console.log(`   Response: ${JSON.stringify(resumeData, null, 2)}`);

        if (resumeRes.status === 200) {
          console.log('\n✅ Token consumed successfully — context transferred!');
        }

        // Try consuming the same token again (should fail — one-time use)
        console.log(`\n🔒 GET /handoff/resume (same token — should fail, one-time use)`);
        const replayRes = await fetch(`${BASE}/handoff/resume?token=${encodeURIComponent(token)}`);
        const replayData = await replayRes.json();
        console.log(`   Status: ${replayRes.status}`);
        console.log(`   Response: ${JSON.stringify(replayData, null, 2)}`);

        if (replayRes.status !== 200) {
          console.log('✅ One-time use enforced — replay rejected!');
        } else {
          console.log('⚠️  Token was reused — one-time use NOT enforced');
        }
      }
    }
  } catch (err: any) {
    console.log(`   ⚠️ Handoff API test error: ${err.message}`);
  }

  // Test GET /handoff/status (debug)
  console.log('\n📊 GET /handoff/status (debug endpoint)');
  try {
    const statusRes = await fetch(`${BASE}/handoff/status`);
    const statusData = await statusRes.json();
    console.log(`   Status: ${statusRes.status}`);
    console.log(`   Response: ${JSON.stringify(statusData, null, 2)}`);
  } catch (err: any) {
    console.log(`   ⚠️ Status endpoint error: ${err.message}`);
  }

  console.log('\n✅ Handoff scenario completed!');
}

// ── Session Debug ───────────────────────────────────────────────

async function debugSessions(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/twilio/voice/sessions`);
    if (res.ok) {
      const data = await res.json();
      console.log('\n📊 Active voice sessions:', JSON.stringify(data, null, 2));
    }
  } catch {
    // Debug endpoint may not be available
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🔧 Voice Simulator — Target: ${BASE}`);
  console.log(`📋 Scenario: ${SCENARIO}`);
  console.log(`📞 CallSid: ${CALL_SID}`);

  try {
    switch (SCENARIO) {
      case 'book':
        await scenarioBook();
        break;
      case 'cancel':
        await scenarioCancel();
        break;
      case 'silence':
        await scenarioSilence();
        break;
      case 'unknown':
        await scenarioUnknown();
        break;
      case 'handoff':
        await scenarioHandoff();
        break;
      default:
        console.error(`Unknown scenario: ${SCENARIO}`);
        console.log('Available: book, cancel, silence, unknown, handoff');
        process.exit(1);
    }
  } catch (err: any) {
    console.error('\n❌ Error:', err.message);
    if (err.cause) console.error('   Cause:', err.cause);
  }

  await debugSessions();
  console.log('\n✨ Simulator finished.\n');
}

main();
