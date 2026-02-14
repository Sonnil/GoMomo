/**
 * Inbound SMS Routes — First-Class Conversational Channel
 *
 * POST /twilio/sms/incoming  — Twilio calls this for every inbound SMS
 *
 * Flow:
 *   1. Validate Twilio signature (non-dev)
 *   2. Check for STOP/START commands → opt-out/opt-in
 *   3. Check opt-out status → reject if opted out (shouldn't happen, but defensive)
 *   4. Resolve phone → tenant → chat_session
 *   5. Run message through the same chat handler as web chat
 *   6. Reply via TwiML <Message>
 *   7. Audit log inbound + outbound
 *
 * The agent sees SMS messages the same way as web chat messages —
 * same system prompt, same tools, same booking invariants.
 * No duplicated booking logic.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { smsOptOutRepo } from '../repos/sms-opt-out.repo.js';
import { smsRateLimitRepo } from '../repos/sms-rate-limit.repo.js';
import { resolveSmsSession } from './sms-session-resolver.js';
import { handleChatMessage } from '../agent/chat-handler.js';
import { auditRepo } from '../repos/audit.repo.js';
import { sessionRepo } from '../repos/session.repo.js';
import { markPublic, requireAdminKey } from '../auth/middleware.js';
import { validateTwilioSignature } from './twilio-signature.js';
import { normalizePhoneOrPassthrough } from './phone-normalizer.js';
import { smsMetricInc } from './sms-metrics.js';

// ── STOP / START / HELP keyword sets (carrier-standard) ─────
const STOP_KEYWORDS = new Set(['stop', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_KEYWORDS = new Set(['start', 'unstop', 'subscribe', 'resume']);
const HELP_KEYWORDS = new Set(['help', 'info']);

// ── SMS Body Types ──────────────────────────────────────────

// ── TwiML Response Helpers ──────────────────────────────────

function twimlMessage(text: string): string {
  // Truncate at 1500 chars (Twilio limit ~1600, leave margin)
  const truncated = text.length > 1500
    ? text.substring(0, 1497) + '...'
    : text;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(truncated)}</Message></Response>`;
}

function twimlEmpty(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Twilio Inbound SMS Body ─────────────────────────────────

interface TwilioSmsBody {
  MessageSid: string;
  From: string;
  To: string;
  Body: string;
  NumMedia?: string;
  AccountSid?: string;
}

// ── Route Registration ──────────────────────────────────────

export async function inboundSmsRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /twilio/sms/incoming
   *
   * Main inbound SMS handler. Every text message to a Twilio number
   * comes through here.
   */
  app.post('/twilio/sms/incoming', {
    preHandler: markPublic,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!validateTwilioSignature(req, reply)) return;

    const body = (req.body ?? {}) as TwilioSmsBody;
    const rawPhone = body.From ?? '';
    const toPhone = body.To ?? '';
    const messageBody = (body.Body ?? '').trim();
    const messageSid = body.MessageSid ?? 'unknown';

    // Normalize caller phone to E.164 before any storage/lookup
    const fromPhone = rawPhone ? normalizePhoneOrPassthrough(rawPhone) : '';

    if (!fromPhone || !messageBody) {
      return reply.type('text/xml').send(twimlEmpty());
    }

    console.log(`[sms-inbound] From: ${fromPhone} To: ${toPhone} Body: "${messageBody.substring(0, 50)}…" SID: ${messageSid}`);

    // ── 1. STOP / START handling ────────────────────────────
    const normalizedBody = messageBody.toLowerCase().trim();

    if (STOP_KEYWORDS.has(normalizedBody)) {
      // Resolve tenant for this phone number (best-effort for per-tenant opt-out)
      let tenantId: string | null = null;
      try {
        const resolution = await resolveSmsSession(fromPhone, toPhone);
        tenantId = resolution?.tenant.id ?? null;
      } catch { /* best-effort */ }

      await smsOptOutRepo.optOut(fromPhone, tenantId);

      smsMetricInc('stop');

      await auditRepo.log({
        tenant_id: tenantId,
        event_type: 'sms.opt_out',
        entity_type: 'phone',
        entity_id: null,
        actor: 'customer',
        payload: { phone: fromPhone, keyword: normalizedBody },
      });

      console.log(`[sms-inbound] Opt-out recorded for ${fromPhone}`);

      return reply
        .type('text/xml')
        .send(twimlMessage(
          'You have been unsubscribed and will no longer receive text messages from us. Reply START to re-subscribe.',
        ));
    }

    if (START_KEYWORDS.has(normalizedBody)) {
      let tenantId: string | null = null;
      try {
        const resolution = await resolveSmsSession(fromPhone, toPhone);
        tenantId = resolution?.tenant.id ?? null;
      } catch { /* best-effort */ }

      await smsOptOutRepo.optIn(fromPhone, tenantId);

      smsMetricInc('start');

      await auditRepo.log({
        tenant_id: tenantId,
        event_type: 'sms.opt_in',
        entity_type: 'phone',
        entity_id: null,
        actor: 'customer',
        payload: { phone: fromPhone, keyword: normalizedBody },
      });

      console.log(`[sms-inbound] Opt-in recorded for ${fromPhone}`);

      return reply
        .type('text/xml')
        .send(twimlMessage(
          'You have been re-subscribed! You can now text us to book, reschedule, or cancel appointments. Reply STOP at any time to unsubscribe.',
        ));
    }

    // ── 1b. HELP keyword ────────────────────────────────────
    if (HELP_KEYWORDS.has(normalizedBody)) {
      // Check opt-out: if opted out, only START should work — don't reply to HELP
      let isOptedOut = false;
      try {
        const resolution = await resolveSmsSession(fromPhone, toPhone);
        if (resolution) {
          isOptedOut = await smsOptOutRepo.isOptedOut(fromPhone, resolution.tenant.id);
        }
      } catch { /* best-effort */ }

      if (isOptedOut) {
        // Silently ignore HELP from opted-out users (only START re-enables)
        return reply.type('text/xml').send(twimlEmpty());
      }

      smsMetricInc('help');

      console.log(`[sms-inbound] HELP requested by ${fromPhone.slice(0, 6)}…`);

      return reply
        .type('text/xml')
        .send(twimlMessage(
          'To book: tell me a day/time. To cancel: send Ref + Full Name. To reschedule: send Ref + Full Name + new time. STOP to opt out.',
        ));
    }

    // ── 2. Resolve session (phone → tenant → chat_session) ──
    let resolution;
    try {
      resolution = await resolveSmsSession(fromPhone, toPhone);
    } catch (err) {
      console.error('[sms-inbound] Session resolution error:', err);
      return reply
        .type('text/xml')
        .send(twimlMessage(
          'Sorry, we encountered an issue. Please try again in a moment.',
        ));
    }

    if (!resolution) {
      console.warn(`[sms-inbound] Could not resolve tenant for To: ${toPhone}`);
      return reply
        .type('text/xml')
        .send(twimlMessage(
          'Sorry, this number is not configured for messaging. Please contact us through our website.',
        ));
    }

    const { tenant, sessionId, isNew, returningContext } = resolution;

    // ── 3. Check opt-out (defensive — STOP should have been handled above) ──
    const optedOut = await smsOptOutRepo.isOptedOut(fromPhone, tenant.id);
    if (optedOut) {
      console.log(`[sms-inbound] Ignoring message from opted-out phone ${fromPhone}`);
      return reply.type('text/xml').send(twimlEmpty());
    }

    // ── 4. Rate limit check (inbound — prevent abuse) ───────
    const rl = await smsRateLimitRepo.checkInbound(fromPhone);
    if (!rl.allowed) {
      console.warn(`[sms-inbound] Rate limit exceeded for ${fromPhone} (${rl.count} inbound messages in window)`);
      return reply
        .type('text/xml')
        .send(twimlMessage(
          'You\'ve sent too many messages. Please wait a bit and try again, or visit our website to book online.',
        ));
    }

    // Record inbound rate limit event immediately
    await smsRateLimitRepo.record(fromPhone, tenant.id, 'inbound');

    // ── 5. Audit inbound message ────────────────────────────
    await auditRepo.log({
      tenant_id: tenant.id,
      event_type: 'sms.inbound',
      entity_type: 'session',
      entity_id: sessionId,
      actor: 'customer',
      payload: {
        phone: fromPhone,
        message_sid: messageSid,
        is_new_session: isNew,
        // Body NOT logged (PII)
      },
    });

    // ── 5b. Seed session metadata with caller's phone ───────
    // So confirm_booking can auto-inject client_phone for SMS reminders
    try {
      const session = await sessionRepo.findOrCreate(sessionId, tenant.id);
      const meta = (session.metadata ?? {}) as Record<string, unknown>;
      if (!meta.client_phone) {
        await sessionRepo.updateMetadata(sessionId, {
          ...meta,
          client_phone: fromPhone,
        });
      }
    } catch { /* best-effort — phone seeding is non-critical */ }

    // ── 6. Run through chat handler (same as web chat) ──────
    let responseText: string;
    let toolsUsed: string[] = [];
    let hasAsyncJob = false;
    try {
      const { response, meta } = await handleChatMessage(
        sessionId,
        tenant.id,
        messageBody,
        tenant,
        { customerContext: returningContext, channel: 'sms' },
      );
      responseText = response;
      toolsUsed = meta.tools_used;
      hasAsyncJob = meta.has_async_job;

      // Audit the outbound reply
      await auditRepo.log({
        tenant_id: tenant.id,
        event_type: 'sms.outbound',
        entity_type: 'session',
        entity_id: sessionId,
        actor: 'agent',
        payload: {
          phone: fromPhone,
          tools_used: toolsUsed,
          has_async_job: hasAsyncJob,
          response_length: responseText.length,
          // Response body NOT logged (may contain PII)
        },
      });
    } catch (err) {
      console.error('[sms-inbound] Chat handler error:', err);
      responseText = 'Sorry, I encountered an issue processing your message. Please try again or visit our website.';
    }

    // ── 7. SMS debug logging (PII-safe) ───────────────────
    if (env.SMS_DEBUG === 'true') {
      const toolsSummary = toolsUsed.length > 0
        ? toolsUsed.join(',')
        : 'none';
      console.log(`[sms-debug] ${fromPhone.slice(0, 6)}... → tools:[${toolsSummary}] async:${hasAsyncJob} len:${responseText.length}`);
    }

    // ── 8. Reply via TwiML ──────────────────────────────────
    // Split long responses into multiple <Message> elements
    // (Twilio supports up to 10 <Message> elements per response)
    if (responseText.length <= 1500) {
      return reply.type('text/xml').send(twimlMessage(responseText));
    }

    // For long responses, split at sentence boundaries
    const chunks = splitMessage(responseText, 1500);
    const messagesXml = chunks.map((c) => `<Message>${escapeXml(c)}</Message>`).join('');
    return reply
      .type('text/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response>${messagesXml}</Response>`);
  });

  // ── Debug endpoint (dev only) ─────────────────────────────
  if (env.NODE_ENV === 'development') {
    app.get('/twilio/sms/sessions', { preHandler: requireAdminKey }, async (_req: FastifyRequest, reply: FastifyReply) => {
      const { query: q } = await import('../db/client.js');
      const { rows } = await q(
        `SELECT ps.phone, ps.tenant_id, ps.session_id, ps.updated_at,
                t.name AS tenant_name
         FROM sms_phone_sessions ps
         JOIN tenants t ON t.id = ps.tenant_id
         ORDER BY ps.updated_at DESC
         LIMIT 50`,
      );
      return reply.send(rows);
    });

    app.get('/twilio/sms/opt-outs', { preHandler: requireAdminKey }, async (_req: FastifyRequest, reply: FastifyReply) => {
      const { query: q } = await import('../db/client.js');
      const { rows } = await q(
        `SELECT phone, tenant_id, opted_out_at FROM sms_opt_outs ORDER BY opted_out_at DESC LIMIT 50`,
      );
      return reply.send(rows);
    });
  }
}

// ── Message Splitting ───────────────────────────────────────

/**
 * Split a long message into chunks, breaking at sentence boundaries
 * when possible. Falls back to hard truncation at maxLen.
 */
function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to break at a sentence boundary
    let breakAt = remaining.lastIndexOf('. ', maxLen);
    if (breakAt === -1 || breakAt < maxLen * 0.5) {
      // Try newline
      breakAt = remaining.lastIndexOf('\n', maxLen);
    }
    if (breakAt === -1 || breakAt < maxLen * 0.5) {
      // Hard break
      breakAt = maxLen;
    } else {
      breakAt += 1; // Include the period/newline
    }

    chunks.push(remaining.substring(0, breakAt).trim());
    remaining = remaining.substring(breakAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.slice(0, 10); // Twilio max 10 <Message> elements
}
