/**
 * SMS Handoff Routes
 *
 * POST /handoff/sms       — Trigger SMS handoff from voice call
 * GET  /handoff/resume     — Web client redeems token and gets session context
 * GET  /handoff/status     — Debug: check token store stats
 *
 * Flow:
 * 1. Voice call struggles → conversation engine calls POST /handoff/sms internally
 *    (or caller says "text me a link")
 * 2. Server creates handoff token, sends SMS with link to web chat
 * 3. Caller opens link → GET /handoff/resume validates & consumes token
 * 4. Returns partial context → web widget pre-fills and continues conversation
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { markPublic, requireAdminKey } from '../auth/middleware.js';
import {
  createHandoffToken,
  consumeHandoffToken,
  getTokenStoreStats,
} from './handoff-token.js';
import { sendHandoffSms, isValidE164 } from './sms-sender.js';
import { getVoiceSession } from './session-manager.js';
import { tenantRepo } from '../repos/tenant.repo.js';

// ── Route Registration ──────────────────────────────────────────

export async function handoffRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /handoff/sms
   *
   * Triggered when a voice session should hand off to web chat.
   * Can be called:
   *   (a) Internally by the conversation engine (callSid in body)
   *   (b) Via API for testing (callSid + to phone in body)
   *
   * Body: { callSid: string, to?: string }
   *   - callSid: the active Twilio call to snapshot
   *   - to: recipient phone (defaults to From number on the session)
   */
  app.post('/handoff/sms', { preHandler: requireAdminKey }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const callSid = body.callSid || body.CallSid;
    const toPhone = body.to || body.To;

    if (!callSid) {
      return reply.code(400).send({
        error: 'Missing callSid',
        message: 'Provide the CallSid of the active voice session.',
      });
    }

    // Find the active voice session
    const session = getVoiceSession(callSid);
    if (!session) {
      return reply.code(404).send({
        error: 'Session not found',
        message: 'No active voice session found for this CallSid.',
      });
    }

    // Resolve recipient phone number
    const recipient = toPhone || (body.From as string);
    if (!recipient || !isValidE164(recipient)) {
      return reply.code(400).send({
        error: 'Invalid phone number',
        message: 'Provide a valid E.164 phone number in the "to" field.',
      });
    }

    // Create handoff token
    const token = createHandoffToken(session);

    // Build the web chat resume URL
    const frontendBaseUrl = env.SMS_HANDOFF_WEB_URL || env.CORS_ORIGIN.split(',')[0].trim();
    const resumeUrl = `${frontendBaseUrl}?handoff=${encodeURIComponent(token)}`;

    // Resolve tenant name for SMS message
    const tenant = await tenantRepo.findById(session.tenantId).catch(() => null);
    const tenantName = tenant?.name ?? 'Your booking agent';

    // Send the SMS
    const smsResult = await sendHandoffSms(recipient, tenantName, resumeUrl);

    if (!smsResult.success) {
      console.error(`[handoff] SMS failed for ${callSid}:`, smsResult.error);

      if (smsResult.rateLimited) {
        return reply.code(429).send({
          error: 'Rate limited',
          message: smsResult.error,
        });
      }

      return reply.code(502).send({
        error: 'SMS delivery failed',
        message: smsResult.error,
      });
    }

    console.log(`[handoff] SMS sent for call ${callSid} to ${recipient} — token created`);

    return reply.send({
      success: true,
      message: 'SMS handoff link sent successfully.',
      messageSid: smsResult.messageSid,
      // Return token for testing/debug (not in production)
      ...(env.NODE_ENV === 'development' ? { token, resumeUrl } : {}),
    });
  });

  /**
   * GET /handoff/resume?token=<handoff-token>
   *
   * Called by the web frontend when the user clicks the SMS link.
   * Validates and consumes the one-time token, returns partial session context
   * for the web chat to resume from.
   *
   * The frontend uses this response to:
   * 1. Connect to Socket.IO with the right tenant_id
   * 2. Inject a system context message about the handoff
   * 3. Pre-fill known fields (service, date, name, etc.)
   */
  app.get('/handoff/resume', { preHandler: markPublic }, async (req: FastifyRequest, reply: FastifyReply) => {
    const query = (req.query ?? {}) as Record<string, string>;
    const token = query.token;

    if (!token) {
      return reply.code(400).send({
        error: 'Missing token',
        message: 'Provide the handoff token as a query parameter.',
      });
    }

    // Consume the token (one-time use)
    const payload = consumeHandoffToken(token);

    if (!payload) {
      return reply.code(410).send({
        error: 'Token invalid or expired',
        message: 'This link has expired or has already been used. Please call back for a new link.',
      });
    }

    // Resolve tenant for frontend context
    const tenant = await tenantRepo.findById(payload.tenantId).catch(() => null);

    console.log(`[handoff] Token consumed for call ${payload.callSid} — resuming as web session`);

    // Return the context the web frontend needs
    return reply.send({
      success: true,
      context: {
        tenantId: payload.tenantId,
        tenantName: tenant?.name ?? null,
        sessionId: payload.sessionId,
        intent: payload.intent,
        voiceState: payload.voiceState,
        partial: payload.partial,
        // Summary message the web chat can display
        resumeMessage: buildResumeMessage(payload),
      },
    });
  });

  /**
   * GET /handoff/status (debug — development only)
   */
  if (env.NODE_ENV === 'development') {
    app.get('/handoff/status', { preHandler: requireAdminKey }, async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send(getTokenStoreStats());
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Build a human-readable summary of what was collected on the phone.
 */
function buildResumeMessage(payload: { intent: string; partial: Record<string, any> }): string {
  const parts: string[] = ['Continuing from your phone call.'];
  const p = payload.partial;

  if (payload.intent === 'book') {
    parts.push("You were booking an appointment.");
    if (p.service) parts.push(`Service: ${p.service}.`);
    if (p.date) parts.push(`Date: ${p.date}.`);
    if (p.clientName) parts.push(`Name: ${p.clientName}.`);
  } else if (payload.intent === 'reschedule') {
    parts.push("You were rescheduling an appointment.");
    if (p.referenceCode) parts.push(`Reference: ${p.referenceCode}.`);
  } else if (payload.intent === 'cancel') {
    parts.push("You were cancelling an appointment.");
    if (p.referenceCode) parts.push(`Reference: ${p.referenceCode}.`);
  }

  parts.push("Let's pick up where we left off!");
  return parts.join(' ');
}
