/**
 * Voice Mock Server — Test the phone channel without PostgreSQL
 *
 * Runs the Twilio webhook endpoints with:
 * - In-memory tenant (same Gomomo config)
 * - In-memory availability + booking (mock tool results)
 * - Full voice NLU + conversation engine + TwiML generation
 *
 * Usage: npx tsx src/voice-mock-server.ts
 * Then:  npx tsx tests/voice-simulator.ts --scenario=book
 */

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import cors from '@fastify/cors';
import { v4 as uuidv4 } from 'uuid';
import {
  createVoiceSession,
  getVoiceSession,
  deleteVoiceSession,
  getAllVoiceSessions,
  countActiveSessions,
  advanceState,
  incrementTurn,
  incrementRetry,
  isCallExpired,
  isTurnLimitReached,
  isRetryLimitReached,
} from './voice/session-manager.js';
import {
  detectIntent,
  detectYesNo,
  detectService,
  detectDate,
  detectSlotChoice,
  detectEmail,
  detectName,
  detectReferenceCode,
  detectHandoffRequest,
} from './voice/nlu.js';
import { buildGatherTwiML, buildSayHangupTwiML } from './voice/twiml-builder.js';
import {
  createHandoffToken,
  consumeHandoffToken,
  getTokenStoreStats,
} from './voice/handoff-token.js';
import type { VoiceSession, VoiceCallState, Tenant, Service } from './domain/types.js';
import { format, addDays } from 'date-fns';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const CONTINUE_URL = `${BASE_URL}/twilio/voice/continue`;

// ── Mock Tenant ─────────────────────────────────────────────────

const MOCK_TENANT: Tenant = {
  id: 'demo-tenant-001',
  name: 'Gomomo',
  slug: 'gomomo',
  timezone: 'America/New_York',
  slot_duration: 30,
  business_hours: {
    monday: { start: '09:00', end: '17:00' },
    tuesday: { start: '09:00', end: '17:00' },
    wednesday: { start: '09:00', end: '17:00' },
    thursday: { start: '09:00', end: '17:00' },
    friday: { start: '09:00', end: '16:00' },
    saturday: { start: '10:00', end: '14:00' },
    sunday: null,
  },
  services: [
    { name: 'General Consultation', duration: 30, description: 'Standard consultation with a specialist' },
    { name: 'Extended Consultation', duration: 60, description: 'In-depth session for complex cases' },
    { name: 'Follow-up Appointment', duration: 20, description: 'Quick follow-up session' },
  ],
  google_calendar_id: null,
  google_oauth_tokens: null,
  excel_integration: null,
  quiet_hours_start: '21:00',
  quiet_hours_end: '08:00',
  sms_outbound_enabled: true,
  sms_retry_enabled: true,
  sms_quiet_hours_enabled: true,
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

// ── Mock Bookings Store ─────────────────────────────────────────

const mockBookings = new Map<string, {
  id: string;
  reference_code: string;
  service: string | null;
  start_time: string;
  end_time: string;
  client_name: string;
  status: string;
}>();

// Pre-seed a booking for cancel/reschedule testing
mockBookings.set('APT-ABC123', {
  id: uuidv4(),
  reference_code: 'APT-ABC123',
  service: 'Swedish Massage',
  start_time: addDays(new Date(), 2).toISOString(),
  end_time: addDays(new Date(), 2).toISOString(),
  client_name: 'Jane Doe',
  status: 'confirmed',
});

// ── Mock Slots Generator ────────────────────────────────────────

function generateMockSlots(dateStr: string): Array<{ start: string; end: string; display_time: string }> {
  const times = ['9:00 AM', '10:00 AM', '11:30 AM', '2:00 PM', '3:30 PM'];
  const hours = [9, 10, 11.5, 14, 15.5];

  return times.map((t, i) => {
    const d = new Date(`${dateStr}T00:00:00`);
    const h = Math.floor(hours[i]);
    const m = (hours[i] - h) * 60;
    d.setHours(h, m, 0, 0);
    const end = new Date(d.getTime() + 30 * 60_000);
    return {
      start: d.toISOString(),
      end: end.toISOString(),
      display_time: `${format(d, 'EEEE, MMMM d, yyyy')} ${t}`,
    };
  });
}

// ── Voice Conversation Engine (Mock Version) ────────────────────

function makePrompt(session: VoiceSession, prompt: string, nextState: VoiceCallState, hints?: string): string {
  advanceState(session, nextState);
  session.lastPrompt = prompt;
  return buildGatherTwiML({ prompt, action: CONTINUE_URL, hints });
}

function spellOut(code: string): string {
  return code.split('').map((c) => c === '-' ? 'dash' : c).join('. ');
}

async function processVoiceTurn(
  session: VoiceSession,
  speechResult: string,
  isTimeout: boolean,
): Promise<string> {
  incrementTurn(session);

  if (isCallExpired(session)) {
    advanceState(session, 'completed');
    return buildSayHangupTwiML("We've reached the time limit. Please call back. Goodbye!");
  }

  if (isTurnLimitReached(session)) {
    advanceState(session, 'completed');
    return buildSayHangupTwiML("We've been chatting a while. Please visit our website. Goodbye!");
  }

  if (isTimeout && !speechResult) {
    const retries = incrementRetry(session);
    if (isRetryLimitReached(session)) {
      advanceState(session, 'completed');
      return buildSayHangupTwiML("I haven't heard from you. Please call back anytime. Goodbye!");
    }
    return buildGatherTwiML({
      prompt: `I didn't catch that. ${session.lastPrompt}`,
      action: CONTINUE_URL,
    });
  }

  // SMS Handoff detection — caller says "text me", "send me a link", etc.
  if (speechResult && detectHandoffRequest(speechResult)) {
    if (session.callerPhone) {
      const token = createHandoffToken(session);
      const resumeUrl = `http://localhost:5173?handoff=${encodeURIComponent(token)}`;
      console.log(`[voice-mock] 📱 SMS Handoff triggered! Token created.`);
      console.log(`[voice-mock] 📱 Resume URL: ${resumeUrl}`);
      advanceState(session, 'completed');
      return buildSayHangupTwiML(
        "I've just sent you a text message with a link to continue online. " +
        "Tap the link to pick up right where we left off. " +
        "The link is good for 15 minutes. Thank you for calling!",
      );
    }
    return makePrompt(session,
      "I'm sorry, I can't send a text right now. Let's continue over the phone. " +
      session.lastPrompt,
      session.state,
    );
  }

  switch (session.state) {
    case 'greeting':
    case 'collecting_intent': {
      const intent = detectIntent(speechResult);
      if (intent === 'unknown') {
        incrementRetry(session);
        if (isRetryLimitReached(session)) {
          return makePrompt(session,
            "I can help you book, reschedule, or cancel. Which would you like?",
            'collecting_intent',
          );
        }
        return makePrompt(session,
          "I didn't quite get that. Would you like to book, reschedule, or cancel?",
          'collecting_intent',
        );
      }
      session.intent = intent;
      if (intent === 'book') {
        return makePrompt(session, "Great, let's book! What service are you looking for?", 'collecting_service');
      }
      return makePrompt(session,
        `Sure, I can help you ${intent}. What's your reference code? It starts with A P T.`,
        'collecting_reference',
      );
    }

    case 'collecting_service': {
      const services = MOCK_TENANT.services.map((s) => s.name);
      const detected = detectService(speechResult, services);
      if (!detected) {
        incrementRetry(session);
        if (isRetryLimitReached(session)) {
          session.service = services[0];
          return makePrompt(session, `I'll go with ${session.service}. What date works?`, 'collecting_date');
        }
        const list = services.map((s, i) => `${i + 1}. ${s}`).join('. ');
        return makePrompt(session, `We offer: ${list}. Which service?`, 'collecting_service');
      }
      session.service = detected;
      return makePrompt(session, `${detected}, perfect! What date would you prefer?`, 'collecting_date');
    }

    case 'collecting_date': {
      const date = detectDate(speechResult);
      if (!date) {
        incrementRetry(session);
        if (isRetryLimitReached(session)) {
          advanceState(session, 'completed');
          return buildSayHangupTwiML("I'm having trouble with the date. Please try our website. Goodbye!");
        }
        return makePrompt(session, "Say something like tomorrow, next Monday, or February tenth.", 'collecting_date');
      }
      session.date = date;
      session.availableSlots = generateMockSlots(date);
      const slotList = session.availableSlots.map((s, i) => `${i + 1}. ${s.display_time}`).join('. ');
      return makePrompt(session, `Available times: ${slotList}. Which time works?`, 'offering_slots');
    }

    case 'offering_slots':
    case 'collecting_slot_choice': {
      const chosen = detectSlotChoice(speechResult, session.availableSlots.slice(0, 5));
      if (!chosen) {
        incrementRetry(session);
        if (isRetryLimitReached(session)) {
          const first = session.availableSlots[0];
          session.selectedSlot = first;
        } else {
          return makePrompt(session, "Say the number or time you'd like.", 'collecting_slot_choice');
        }
      } else {
        session.selectedSlot = chosen;
      }
      session.holdId = `hold-${uuidv4()}`;
      return makePrompt(session, "I've held that slot for 5 minutes. What is your full name?", 'collecting_name');
    }

    case 'collecting_name': {
      const name = detectName(speechResult);
      session.clientName = name ?? speechResult.trim();
      return makePrompt(session, `Got it, ${session.clientName}. What's your email address?`, 'collecting_email', 'example at email dot com');
    }

    case 'collecting_email': {
      const email = detectEmail(speechResult);
      if (!email) {
        incrementRetry(session);
        if (isRetryLimitReached(session)) {
          advanceState(session, 'completed');
          return buildSayHangupTwiML("I'm having trouble with the email. Please try our website. Goodbye!");
        }
        return makePrompt(session, "Please say it slowly, like 'alex at example dot com'.", 'collecting_email');
      }
      session.clientEmail = email;
      const displayTime = session.availableSlots.find((s) => s.start === session.selectedSlot?.start)?.display_time ?? 'the selected time';
      return makePrompt(session,
        `Let me confirm: ${session.clientName}, ${session.service ?? 'appointment'} on ${displayTime}, email ${session.clientEmail}. Shall I book?`,
        'confirming_booking',
      );
    }

    case 'confirming_booking': {
      const answer = detectYesNo(speechResult);
      if (answer === 'no') {
        return makePrompt(session, "No problem! Would you like to start over?", 'collecting_intent');
      }
      if (answer !== 'yes') {
        incrementRetry(session);
        if (!isRetryLimitReached(session)) {
          return makePrompt(session, "Please say yes to confirm or no to cancel.", 'confirming_booking');
        }
      }
      // Mock booking confirmation
      const refCode = `APT-${uuidv4().substring(0, 6).toUpperCase()}`;
      session.referenceCode = refCode;
      session.bookingId = uuidv4();
      const displayTime = session.availableSlots.find((s) => s.start === session.selectedSlot?.start)?.display_time ?? 'your chosen time';
      advanceState(session, 'completed');
      return buildSayHangupTwiML(
        `Your appointment is confirmed! Reference code: ${spellOut(refCode)}. ` +
        `Booked for ${displayTime}. Thank you for calling ${MOCK_TENANT.name}!`,
      );
    }

    case 'collecting_reference': {
      const refCode = detectReferenceCode(speechResult);
      const email = detectEmail(speechResult);
      if (!refCode && !email) {
        incrementRetry(session);
        if (isRetryLimitReached(session)) {
          advanceState(session, 'completed');
          return buildSayHangupTwiML("I couldn't find your booking. Please call back with your reference. Goodbye!");
        }
        return makePrompt(session, "Say your reference code like A P T dash A B C 1 2 3.", 'collecting_reference');
      }
      // Mock lookup
      const key = refCode ?? 'APT-ABC123';
      const booking = mockBookings.get(key);
      if (!booking) {
        return makePrompt(session, "I couldn't find that appointment. Could you try again?", 'collecting_reference');
      }
      session.appointmentId = booking.id;
      session.referenceCode = booking.reference_code;
      if (session.intent === 'cancel') {
        return makePrompt(session,
          `Found: ${booking.reference_code}, ${booking.service}. Are you sure you want to cancel?`,
          'confirming_cancel',
        );
      }
      return makePrompt(session,
        `Found: ${booking.reference_code}, ${booking.service}. What new date?`,
        'collecting_reschedule_date',
      );
    }

    case 'confirming_cancel': {
      const answer = detectYesNo(speechResult);
      if (answer === 'no') {
        advanceState(session, 'completed');
        return buildSayHangupTwiML("Okay, your appointment remains. Goodbye!");
      }
      if (answer !== 'yes') {
        incrementRetry(session);
        if (!isRetryLimitReached(session)) {
          return makePrompt(session, "Say yes to cancel or no to keep.", 'confirming_cancel');
        }
      }
      advanceState(session, 'completed');
      return buildSayHangupTwiML("Your appointment has been cancelled. Call back anytime. Goodbye!");
    }

    case 'collecting_reschedule_date': {
      const date = detectDate(speechResult);
      if (!date) {
        incrementRetry(session);
        if (isRetryLimitReached(session)) {
          advanceState(session, 'completed');
          return buildSayHangupTwiML("I couldn't understand the date. Please try our website. Goodbye!");
        }
        return makePrompt(session, "Say tomorrow, next Monday, or a specific date.", 'collecting_reschedule_date');
      }
      session.date = date;
      session.availableSlots = generateMockSlots(date);
      const slotList = session.availableSlots.map((s, i) => `${i + 1}. ${s.display_time}`).join('. ');
      return makePrompt(session, `Available: ${slotList}. Which time?`, 'offering_reschedule_slots');
    }

    case 'offering_reschedule_slots': {
      const chosen = detectSlotChoice(speechResult, session.availableSlots.slice(0, 5));
      if (!chosen) {
        incrementRetry(session);
        if (isRetryLimitReached(session)) {
          advanceState(session, 'completed');
          return buildSayHangupTwiML("I couldn't understand. Please try our website. Goodbye!");
        }
        return makePrompt(session, "Say the number or time.", 'offering_reschedule_slots');
      }
      session.selectedSlot = chosen;
      session.holdId = `hold-${uuidv4()}`;
      const displayTime = session.availableSlots.find((s) => s.start === chosen.start)?.display_time ?? chosen.start;
      return makePrompt(session, `Reschedule to ${displayTime}. Confirm?`, 'confirming_reschedule');
    }

    case 'confirming_reschedule': {
      const answer = detectYesNo(speechResult);
      if (answer === 'no') {
        advanceState(session, 'completed');
        return buildSayHangupTwiML("Okay, original appointment stays. Goodbye!");
      }
      if (answer !== 'yes') {
        incrementRetry(session);
        if (!isRetryLimitReached(session)) {
          return makePrompt(session, "Say yes to confirm or no to keep.", 'confirming_reschedule');
        }
      }
      advanceState(session, 'completed');
      return buildSayHangupTwiML(
        `Appointment rescheduled! Reference: ${session.referenceCode ? spellOut(session.referenceCode) : 'confirmed'}. Thank you!`,
      );
    }

    default:
      return makePrompt(session, "Something went wrong. How can I help?", 'collecting_intent');
  }
}

// ── Server Setup ────────────────────────────────────────────────

async function main(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: '*' });
  await app.register(formbody);

  app.get('/health', async () => ({ status: 'ok', mode: 'voice-mock' }));

  // ── POST /twilio/voice/incoming ──────────────────────────────
  app.post('/twilio/voice/incoming', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const callSid = body.CallSid;

    if (!callSid) {
      return reply.type('text/xml').send(buildSayHangupTwiML("Error: no CallSid."));
    }

    console.log(`[voice-mock] Incoming: ${callSid} from ${body.From}`);

    const active = countActiveSessions(MOCK_TENANT.id);
    if (active >= 5) {
      return reply.type('text/xml').send(buildSayHangupTwiML("All lines are busy. Please try again."));
    }

    const session = createVoiceSession(callSid, MOCK_TENANT.id, body.From || undefined);
    const greeting = `Welcome to ${MOCK_TENANT.name}! I can help you book, reschedule, or cancel an appointment. What would you like to do?`;
    session.lastPrompt = greeting;

    return reply.type('text/xml').send(buildGatherTwiML({
      prompt: greeting,
      action: CONTINUE_URL,
      hints: 'book, reschedule, cancel, appointment',
    }));
  });

  // ── POST /twilio/voice/continue ──────────────────────────────
  app.post('/twilio/voice/continue', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const query = (req.query ?? {}) as Record<string, string>;
    const callSid = body.CallSid;
    const speechResult = body.SpeechResult ?? '';
    const isTimeout = query.timeout === 'true';

    if (!callSid) {
      return reply.type('text/xml').send(buildSayHangupTwiML("Error."));
    }

    const session = getVoiceSession(callSid);
    if (!session) {
      return reply.type('text/xml').send(buildSayHangupTwiML("I lost our conversation. Please call back."));
    }

    console.log(`[voice-mock] Turn ${session.turnCount + 1} | State: ${session.state} | Speech: "${speechResult}"`);

    try {
      const twiml = await processVoiceTurn(session, speechResult, isTimeout);
      if (session.state === 'completed' || session.state === 'error') {
        setTimeout(() => deleteVoiceSession(callSid), 300_000);
      }
      return reply.type('text/xml').send(twiml);
    } catch (err) {
      console.error(`[voice-mock] Error:`, err);
      deleteVoiceSession(callSid);
      return reply.type('text/xml').send(buildSayHangupTwiML("Something went wrong. Goodbye."));
    }
  });

  // ── POST /twilio/status ──────────────────────────────────────
  app.post('/twilio/status', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    console.log(`[voice-mock] Status: ${body.CallSid} → ${body.CallStatus}`);
    if (body.CallSid && ['completed', 'failed'].includes(body.CallStatus)) {
      deleteVoiceSession(body.CallSid);
    }
    return reply.send({ received: true });
  });

  // ── GET /twilio/voice/sessions (debug) ───────────────────────
  app.get('/twilio/voice/sessions', async (_req, reply) => {
    const sessions = getAllVoiceSessions();
    const list = Array.from(sessions.values()).map((s) => ({
      callSid: s.callSid,
      state: s.state,
      intent: s.intent,
      turnCount: s.turnCount,
      retries: s.retries,
      service: s.service,
      date: s.date,
      clientName: s.clientName,
      holdId: s.holdId,
      referenceCode: s.referenceCode,
      callerPhone: s.callerPhone,
    }));
    return reply.send(list);
  });

  // ── POST /handoff/sms ───────────────────────────────────────
  app.post('/handoff/sms', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const callSid = body.callSid || body.CallSid;
    const toPhone = body.to || body.To;

    if (!callSid) {
      return reply.code(400).send({ error: 'Missing callSid' });
    }

    const session = getVoiceSession(callSid);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    const recipient = toPhone || session.callerPhone;
    if (!recipient) {
      return reply.code(400).send({ error: 'No phone number available' });
    }

    const token = createHandoffToken(session);
    const resumeUrl = `http://localhost:5173?handoff=${encodeURIComponent(token)}`;

    console.log(`[voice-mock] 📱 SMS Handoff API called`);
    console.log(`[voice-mock] 📱 To: ${recipient}`);
    console.log(`[voice-mock] 📱 Resume URL: ${resumeUrl}`);
    console.log(`[voice-mock] 📱 (SMS not actually sent — mock mode)`);

    return reply.send({
      success: true,
      message: 'SMS handoff link generated (mock — not actually sent)',
      token,
      resumeUrl,
    });
  });

  // ── GET /handoff/resume ─────────────────────────────────────
  app.get('/handoff/resume', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, string>;
    const token = query.token;

    if (!token) {
      return reply.code(400).send({ error: 'Missing token' });
    }

    const payload = consumeHandoffToken(token);
    if (!payload) {
      return reply.code(410).send({
        error: 'Token invalid or expired',
        message: 'This link has expired or has already been used.',
      });
    }

    console.log(`[voice-mock] 📱 Handoff token consumed for call ${payload.callSid}`);

    // Build resume message
    const parts: string[] = ['Continuing from your phone call.'];
    if (payload.intent === 'book') {
      parts.push("You were booking an appointment.");
      if (payload.partial.service) parts.push(`Service: ${payload.partial.service}.`);
      if (payload.partial.date) parts.push(`Date: ${payload.partial.date}.`);
      if (payload.partial.clientName) parts.push(`Name: ${payload.partial.clientName}.`);
    } else if (payload.intent === 'cancel' || payload.intent === 'reschedule') {
      parts.push(`You were ${payload.intent === 'cancel' ? 'cancelling' : 'rescheduling'} an appointment.`);
      if (payload.partial.referenceCode) parts.push(`Reference: ${payload.partial.referenceCode}.`);
    }
    parts.push("Let's pick up where we left off!");

    return reply.send({
      success: true,
      context: {
        tenantId: payload.tenantId,
        tenantName: MOCK_TENANT.name,
        sessionId: payload.sessionId,
        intent: payload.intent,
        voiceState: payload.voiceState,
        partial: payload.partial,
        resumeMessage: parts.join(' '),
      },
    });
  });

  // ── GET /handoff/status (debug) ─────────────────────────────
  app.get('/handoff/status', async (_req, reply) => {
    return reply.send(getTokenStoreStats());
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\n🎙️  Voice Mock Server running on http://0.0.0.0:${PORT}`);
  console.log(`📞 Test: npx tsx tests/voice-simulator.ts --scenario=book`);
  console.log(`� SMS Handoff: npx tsx tests/voice-simulator.ts --scenario=handoff`);
  console.log(`�📞 Pre-seeded booking: APT-ABC123 (for cancel/reschedule tests)\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
