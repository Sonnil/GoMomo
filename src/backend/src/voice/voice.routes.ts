/**
 * Twilio Voice Webhook Routes
 *
 * POST /twilio/voice/incoming  — Twilio calls this when a call comes in
 * POST /twilio/voice/continue  — Twilio calls this with each speech result
 * POST /twilio/status          — Twilio calls this when call status changes
 *
 * Uses Twilio's native <Gather speech> for STT and <Say> for TTS.
 * All booking operations go through the SAME backend tools as web chat.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { tenantRepo } from '../repos/tenant.repo.js';
import { auditRepo } from '../repos/audit.repo.js';
import { markPublic, requireAdminKey } from '../auth/middleware.js';
import {
  createVoiceSession,
  getVoiceSession,
  deleteVoiceSession,
  countActiveSessions,
} from './session-manager.js';
import { processVoiceTurn } from './conversation-engine.js';
import { buildGatherTwiML, buildSayHangupTwiML } from './twiml-builder.js';
import { validateTwilioSignature } from './twilio-signature.js';

/** Mask phone for logs: "+15551234567" → "***4567" */
function maskPhoneForLog(phone: string | undefined): string {
  if (!phone) return '(unknown)';
  return phone.length >= 4 ? `***${phone.slice(-4)}` : '***';
}

/** Mask speech for logs: truncate + strip digits that look like PII */
function maskSpeechForLog(speech: string): string {
  if (!speech) return '(empty)';
  // Replace sequences of 4+ digits (phone fragments, CC numbers) with ***
  const masked = speech.replace(/\d{4,}/g, '***');
  // Truncate long speech
  return masked.length > 60 ? masked.slice(0, 60) + '…' : masked;
}

// ── Route Registration ──────────────────────────────────────────

interface TwilioVoiceBody {
  CallSid: string;
  From: string;
  To: string;
  CallStatus: string;
  SpeechResult?: string;
  Confidence?: string;
  Digits?: string;
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  // Twilio sends form-encoded POST bodies
  // @fastify/formbody is already in package.json deps

  // ── POST /twilio/voice/incoming ─────────────────────────────
  app.post('/twilio/voice/incoming', { preHandler: markPublic }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!validateTwilioSignature(req, reply)) return;

    const body = (req.body ?? {}) as TwilioVoiceBody;
    const callSid = body.CallSid;

    if (!callSid) {
      return reply
        .code(400)
        .type('text/xml')
        .send(buildSayHangupTwiML("Sorry, an error occurred."));
    }

    console.log(`[voice] Incoming call: ${callSid} from ${maskPhoneForLog(body.From)}`);

    // Resolve tenant — for MVP, use VOICE_DEFAULT_TENANT_ID
    // In production, map Twilio phone number → tenant
    const tenantId = env.VOICE_DEFAULT_TENANT_ID;
    const tenant = await tenantRepo.findById(tenantId);

    if (!tenant) {
      console.error(`[voice] Tenant ${tenantId} not found`);
      return reply
        .type('text/xml')
        .send(buildSayHangupTwiML(
          "We're sorry, this phone line is not configured. Please try again later.",
        ));
    }

    // Rate limit: concurrent calls per tenant
    const active = countActiveSessions(tenantId);
    if (active >= 5) {
      console.warn(`[voice] Concurrent call limit reached for tenant ${tenantId}`);
      return reply
        .type('text/xml')
        .send(buildSayHangupTwiML(
          "All our lines are currently busy. Please try again in a few minutes.",
        ));
    }

    // Create voice session
    const session = createVoiceSession(callSid, tenantId, body.From || undefined);

    // ── Audit: voice.call_started ──
    await auditRepo.log({
      tenant_id: tenantId,
      event_type: 'voice.call_started',
      entity_type: 'voice_call',
      entity_id: callSid,
      actor: 'system',
      payload: { caller_masked: maskPhoneForLog(body.From) },
    });

    // Build greeting TwiML
    const greeting = `Welcome to ${tenant.name}! ` +
      `I can help you book, reschedule, or cancel an appointment. ` +
      `What would you like to do?`;

    session.lastPrompt = greeting;

    const twiml = buildGatherTwiML({
      prompt: greeting,
      action: `${env.TWILIO_WEBHOOK_BASE_URL}/twilio/voice/continue`,
      hints: 'book, reschedule, cancel, appointment, schedule',
    });

    return reply.type('text/xml').send(twiml);
  });

  // ── POST /twilio/voice/continue ─────────────────────────────
  app.post('/twilio/voice/continue', { preHandler: markPublic }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!validateTwilioSignature(req, reply)) return;

    const body = (req.body ?? {}) as TwilioVoiceBody;
    const query = (req.query ?? {}) as Record<string, string>;
    const callSid = body.CallSid;
    const speechResult = body.SpeechResult ?? '';
    const isTimeout = query.timeout === 'true';

    if (!callSid) {
      return reply
        .type('text/xml')
        .send(buildSayHangupTwiML("Sorry, an error occurred."));
    }

    const session = getVoiceSession(callSid);
    if (!session) {
      console.warn(`[voice] No session for CallSid: ${callSid}`);
      return reply
        .type('text/xml')
        .send(buildSayHangupTwiML(
          "I'm sorry, I lost track of our conversation. Please call back.",
        ));
    }

    console.log(`[voice] Turn ${session.turnCount + 1} | State: ${session.state} | Speech: "${maskSpeechForLog(speechResult)}" | Timeout: ${isTimeout}`);

    // ── Audit: voice.turn_received ──
    await auditRepo.log({
      tenant_id: session.tenantId,
      event_type: 'voice.turn_received',
      entity_type: 'voice_call',
      entity_id: callSid,
      actor: 'caller',
      payload: {
        turn: session.turnCount + 1,
        state: session.state,
        has_speech: !!speechResult,
        is_timeout: isTimeout,
        // No raw speech — PII safety
      },
    });

    // Resolve tenant
    const tenant = await tenantRepo.findById(session.tenantId);
    if (!tenant) {
      deleteVoiceSession(callSid);
      return reply
        .type('text/xml')
        .send(buildSayHangupTwiML("A system error occurred. Goodbye."));
    }

    try {
      const twiml = await processVoiceTurn(session, speechResult, tenant, isTimeout);

      // ── Audit: voice.turn_responded ──
      await auditRepo.log({
        tenant_id: session.tenantId,
        event_type: 'voice.turn_responded',
        entity_type: 'voice_call',
        entity_id: callSid,
        actor: 'system',
        payload: {
          turn: session.turnCount,
          new_state: session.state,
          intent: session.intent,
        },
      });

      // Clean up if completed
      if (session.state === 'completed' || session.state === 'error') {
        console.log(`[voice] Call ${callSid} completed. Outcome: ${session.intent}, state: ${session.state}`);

        // ── Audit: voice.call_ended ──
        await auditRepo.log({
          tenant_id: session.tenantId,
          event_type: 'voice.call_ended',
          entity_type: 'voice_call',
          entity_id: callSid,
          actor: 'system',
          payload: {
            outcome: session.intent,
            final_state: session.state,
            total_turns: session.turnCount,
            booking_id: session.bookingId ?? null,
            reference_code: session.referenceCode ?? null,
          },
        });

        // Keep session for 5 minutes for status callback, then auto-cleanup
        setTimeout(() => deleteVoiceSession(callSid), 300_000);
      }

      return reply.type('text/xml').send(twiml);
    } catch (err) {
      console.error(`[voice] Error processing turn for ${callSid}:`, err);
      deleteVoiceSession(callSid);
      return reply
        .type('text/xml')
        .send(buildSayHangupTwiML(
          "I'm sorry, something went wrong on our end. Please try again later. Goodbye.",
        ));
    }
  });

  // ── POST /twilio/status (optional — call lifecycle events) ──
  app.post('/twilio/status', { preHandler: markPublic }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as TwilioVoiceBody;
    const callSid = body.CallSid;
    const status = body.CallStatus;

    console.log(`[voice] Status update: ${callSid} → ${status}`);

    if (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer') {
      if (callSid) {
        const session = getVoiceSession(callSid);
        if (session) {
          console.log(`[voice] Cleaning up session for ${callSid} (status: ${status})`);
          deleteVoiceSession(callSid);
        }
      }
    }

    return reply.code(200).send({ received: true });
  });

  // ── GET /twilio/voice/sessions (debug endpoint) ─────────────
  if (env.NODE_ENV === 'development') {
    app.get('/twilio/voice/sessions', { preHandler: requireAdminKey }, async (_req: FastifyRequest, reply: FastifyReply) => {
      const { getAllVoiceSessions } = await import('./session-manager.js');
      const sessions = getAllVoiceSessions();
      const list = Array.from(sessions.values()).map((s) => ({
        callSid: s.callSid,
        state: s.state,
        intent: s.intent,
        turnCount: s.turnCount,
        retries: s.retries,
        service: s.service,
        holdId: s.holdId,
        bookingId: s.bookingId,
        referenceCode: s.referenceCode,
      }));
      return reply.send(list);
    });
  }
}
