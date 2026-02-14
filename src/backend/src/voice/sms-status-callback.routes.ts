/**
 * Twilio SMS Status Callback Routes
 *
 * POST /webhooks/twilio/status
 *
 * Twilio POSTs delivery status updates for each outbound SMS when
 * StatusCallback is configured. Statuses include:
 *   queued → sent → delivered           (success path)
 *   queued → sent → undelivered         (carrier rejection, bad number)
 *   queued → failed                     (Twilio-level failure)
 *
 * We store provider_status + error_code on the sms_outbox row and
 * log a PII-safe audit event.
 *
 * IMPORTANT:
 *   - Always return 2xx (Twilio retries on non-2xx)
 *   - No PII in logs or audit (no phone, no body — just SID + status)
 *   - Unknown MessageSid → 200 (idempotent, don't error)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { smsOutboxRepo } from '../repos/sms-outbox.repo.js';
import { auditRepo } from '../repos/audit.repo.js';
import { markPublic } from '../auth/middleware.js';

// Twilio StatusCallback POST body fields we care about
interface TwilioStatusBody {
  MessageSid?: string;
  MessageStatus?: string;
  ErrorCode?: string;
  // Twilio also sends To, From, AccountSid etc. — we ignore those (PII)
}

export async function smsStatusCallbackRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /webhooks/twilio/status
   *
   * Twilio sends application/x-www-form-urlencoded with:
   *   MessageSid, MessageStatus, ErrorCode (optional), To, From, AccountSid, etc.
   *
   * We only use MessageSid, MessageStatus, ErrorCode.
   */
  app.post<{ Body: TwilioStatusBody }>(
    '/webhooks/twilio/status',
    { preHandler: markPublic },
    async (req: FastifyRequest<{ Body: TwilioStatusBody }>, reply: FastifyReply) => {
      const { MessageSid, MessageStatus, ErrorCode } = req.body ?? {};

      // Validate minimum required fields
      if (!MessageSid || !MessageStatus) {
        // Still return 200 — don't trigger Twilio retries for malformed posts
        return reply.code(200).send({ ok: true, warning: 'missing MessageSid or MessageStatus' });
      }

      const errorCode = ErrorCode ? parseInt(ErrorCode, 10) : null;
      const errorCodeSafe = errorCode && !isNaN(errorCode) ? errorCode : null;

      try {
        // Update the outbox row — returns null if message_sid not found
        const updated = await smsOutboxRepo.updateProviderStatus(
          MessageSid,
          MessageStatus,
          errorCodeSafe,
        );

        // Audit log — PII-safe (no phone, no body)
        await auditRepo.log({
          tenant_id: updated?.tenant_id ?? null,
          event_type: 'sms.provider_status_update',
          entity_type: 'sms_outbox',
          entity_id: updated?.id ?? null,
          actor: 'twilio_status_callback',
          payload: {
            message_sid_last4: MessageSid.slice(-4),
            provider_status: MessageStatus,
            error_code: errorCodeSafe,
            matched: !!updated,
          },
        });

        if (!updated) {
          // Unknown SID — could be from a message sent before migration 016,
          // or a SID from a different system. Log but don't error.
          console.log(`[twilio-status] Unknown message_sid …${MessageSid.slice(-4)} — status=${MessageStatus} (ignored)`);
        } else {
          console.log(`[twilio-status] ${updated.id.slice(0, 8)}… → ${MessageStatus}${errorCodeSafe ? ` (error: ${errorCodeSafe})` : ''}`);
        }
      } catch (err) {
        // Log but still return 200 — never trigger Twilio retries for DB errors
        console.error('[twilio-status] Error processing callback:', err);
      }

      return reply.code(200).send({ ok: true });
    },
  );
}
