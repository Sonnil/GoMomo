/**
 * CEO Pilot Test Routes — Dev-only introspection for end-to-end GUI testing.
 *
 * Only registered when CEO_TEST_MODE=true OR NODE_ENV=development.
 * Protected by X-CEO-TEST-TOKEN header (must match env CEO_TEST_TOKEN).
 * Every request is audit-logged.
 *
 * GET /debug/ceo-test/last-booking?tenant_id=...
 *   → Returns the most recent confirmed booking for the tenant.
 *   → PII-safe: phone masked to last 2 digits, email masked.
 *   → Includes: reference_code, start_time, timezone, sms_enabled,
 *     reminder_job_status.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/client.js';
import { auditRepo } from '../repos/audit.repo.js';
import { env } from '../config/env.js';
import { AUTH_TAG_KEY } from '../auth/middleware.js';
import { getTwilioVerifyResult, twilioHttpsGet } from '../voice/sms-sender.js';
import { smsOutboxRepo } from '../repos/sms-outbox.repo.js';

// ── PII Masking Helpers ─────────────────────────────────────

/** Categorise SMS error string into a PII-safe category (mirrors outbound-sms.ts) */
function categorizeSmsError(error?: string | null): string {
  if (!error) return 'unknown';
  const lower = error.toLowerCase();
  if (lower.includes('timeout') || lower.includes('network')) return 'network';
  if (lower.includes('rate')) return 'rate_limit';
  if (lower.includes('opt') || lower.includes('unsubscribed')) return 'opt_out';
  if (lower.includes('invalid') || lower.includes('21211')) return 'invalid_number';
  if (lower.includes('auth') || lower.includes('20003')) return 'auth_failure';
  if (lower.includes('undelivered') || lower.includes('30')) return 'undelivered';
  if (lower.includes('max retries')) return 'max_retries';
  if (lower.includes('queue') || lower.includes('21610')) return 'blocked';
  if (lower.includes('simulator')) return 'simulator';
  return 'unknown';
}

/** Mask phone: "+1555123**67" → "***67" */
export function maskPhone(phone: string | null): string {
  if (!phone) return '(none)';
  return '***' + phone.slice(-2);
}

/** Mask email: "ceo@example.com" → "c***@e***.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const domParts = domain.split('.');
  const tld = domParts.pop() ?? '';
  return `${local[0]}***@${domain[0]}***.${tld}`;
}

// ── Token Gate Middleware ────────────────────────────────────

async function requireCeoTestToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Mark as auth-tagged so default-deny hook doesn't block it
  (request as any)[AUTH_TAG_KEY] = true;

  const token = request.headers['x-ceo-test-token'] as string | undefined;
  if (!token || token !== env.CEO_TEST_TOKEN) {
    return reply.code(403).send({ error: 'Forbidden — invalid or missing CEO test token.' });
  }
}

// ── Route Registration ──────────────────────────────────────

export async function ceoTestRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /debug/ceo-test/last-booking?tenant_id=...
   *
   * Returns the most recent confirmed booking for the tenant,
   * with PII masked and reminder status attached.
   */
  app.get<{ Querystring: { tenant_id?: string } }>(
    '/debug/ceo-test/last-booking',
    { preHandler: requireCeoTestToken },
    async (req, reply) => {
      const tenantId = req.query.tenant_id || '00000000-0000-4000-a000-000000000001';

      // Audit: log access
      try {
        await auditRepo.log({
          tenant_id: tenantId,
          event_type: 'ceo_test.last_booking_accessed',
          entity_type: 'debug',
          entity_id: 'ceo-test',
          actor: 'ceo-test-panel',
          payload: { ip: req.ip },
        });
      } catch { /* audit is best-effort */ }

      // Fetch latest confirmed booking
      const { rows: bookings } = await query<any>(
        `SELECT id, reference_code, start_time, end_time, timezone,
                client_phone, client_email, status, created_at
         FROM appointments
         WHERE tenant_id = $1 AND status = 'confirmed'
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId],
      );

      if (!bookings.length) {
        return reply.code(404).send({
          error: 'No confirmed bookings found for this tenant.',
        });
      }

      const booking = bookings[0];

      // Fetch reminder status
      const { rows: reminders } = await query<any>(
        `SELECT status, scheduled_at, reminder_type
         FROM appointment_reminders
         WHERE appointment_id = $1
         ORDER BY created_at DESC
         LIMIT 3`,
        [booking.id],
      );

      return {
        reference_code: booking.reference_code,
        start_time: booking.start_time,
        end_time: booking.end_time,
        timezone: booking.timezone,
        status: booking.status,
        sms_enabled: !!booking.client_phone,
        phone_masked: maskPhone(booking.client_phone),
        email_masked: maskEmail(booking.client_email),
        reminder_jobs: reminders.map((r: any) => ({
          type: r.reminder_type,
          status: r.status,
          scheduled_at: r.scheduled_at,
        })),
        created_at: booking.created_at,
      };
    },
  );

  /**
   * GET /debug/ceo-test/last-sms?tenant_id=...
   *
   * Returns the most recent outbound SMS state from sms_outbox + audit_log.
   * Two sections:
   *   outbox: real sms_outbox row state (status, created_at, etc.)
   *   audit_events: recent sms.* audit entries
   * No raw PII: no phone number, no message body.
   */
  app.get<{ Querystring: { tenant_id?: string; limit?: string } }>(
    '/debug/ceo-test/last-sms',
    { preHandler: requireCeoTestToken },
    async (req, reply) => {
      const tenantId = req.query.tenant_id || '00000000-0000-4000-a000-000000000001';
      const limit = Math.min(parseInt(req.query.limit ?? '5', 10) || 5, 20);

      // Audit: log access
      try {
        await auditRepo.log({
          tenant_id: tenantId,
          event_type: 'ceo_test.last_sms_accessed',
          entity_type: 'debug',
          entity_id: 'ceo-test',
          actor: 'ceo-test-panel',
          payload: { ip: req.ip },
        });
      } catch { /* audit is best-effort */ }

      // ── Section 1: Real outbox row state ─────────────────
      const { rows: outboxRows } = await query<any>(
        `SELECT id, status, message_type, booking_id, attempts, max_attempts,
                last_error, abort_reason, message_sid, provider_status, error_code,
                created_at, updated_at
         FROM sms_outbox
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [tenantId, limit],
      );

      // ── Section 2: Recent SMS audit events ───────────────
      const { rows: auditRows } = await query<any>(
        `SELECT event_type, entity_id, payload, created_at
         FROM audit_log
         WHERE tenant_id = $1
           AND event_type LIKE 'sms.%'
         ORDER BY created_at DESC
         LIMIT $2`,
        [tenantId, limit],
      );

      if (!outboxRows.length && !auditRows.length) {
        return reply.code(404).send({
          error: 'No SMS data found for this tenant.',
        });
      }

      // Determine Twilio config status (simulator vs real vs missing)
      const twilioConfigured = !!env.TWILIO_ACCOUNT_SID &&
        !!env.TWILIO_AUTH_TOKEN &&
        (!!env.TWILIO_PHONE_NUMBER || !!env.TWILIO_MESSAGING_SERVICE_SID);

      // Use live verification result if available
      const verifyResult = getTwilioVerifyResult();

      return {
        twilio_mode: verifyResult?.credentialMode ?? (twilioConfigured ? 'live' : 'simulator'),
        credential_verified: verifyResult?.verified ?? false,
        send_mode: verifyResult?.sendMode ?? null,
        outbox: outboxRows.map((o: any) => ({
          id: o.id,
          status: o.status,
          message_type: o.message_type,
          booking_id: o.booking_id,
          attempts: o.attempts,
          max_attempts: o.max_attempts,
          last_error: o.last_error,
          abort_reason: o.abort_reason,
          // Delivery tracking (populated by StatusCallback + sendSms)
          message_sid_last4: o.message_sid ? o.message_sid.slice(-4) : null,
          provider_status: o.provider_status ?? null,
          error_code: o.error_code ?? null,
          // Derived: error category from last_error (PII-safe)
          error_category: o.last_error ? categorizeSmsError(o.last_error) : null,
          created_at: o.created_at,
          updated_at: o.updated_at,
          // Explicitly NO phone, NO body
        })),
        audit_events: auditRows.map((e: any) => ({
          event_type: e.event_type,
          entity_id: e.entity_id,
          reference_code: e.payload?.reference_code ?? null,
          queued: e.payload?.queued ?? null,
          simulated: e.payload?.simulated ?? null,
          message_sid_last4: e.payload?.message_sid_last4 ?? null,
          error: e.payload?.error ?? null,
          error_category: e.payload?.error_category ?? null,
          error_code: e.payload?.error_code ?? null,
          created_at: e.created_at,
        })),
      };
    },
  );

  /**
   * POST /debug/ceo-test/poll-sms-status?tenant_id=...
   *
   * Polls the Twilio Messages API for delivery status of recent outbox entries
   * that have a message_sid but no terminal provider_status yet.
   *
   * Workaround for environments where StatusCallback webhooks are unreachable
   * (e.g. corporate proxy blocks ngrok/tunnels). Uses twilioHttpsGet with
   * rejectUnauthorized:false to tolerate proxy TLS interception.
   *
   * For each message_sid, fetches GET /Messages/{SID}.json and writes
   * provider_status + error_code back to sms_outbox via updateProviderStatus.
   *
   * Returns: array of { message_sid_last4, old_status, new_status, error_code }
   */
  app.post<{ Querystring: { tenant_id?: string; limit?: string } }>(
    '/debug/ceo-test/poll-sms-status',
    { preHandler: requireCeoTestToken },
    async (req, reply) => {
      const accountSid = env.TWILIO_ACCOUNT_SID;
      const authToken = env.TWILIO_AUTH_TOKEN;

      if (!accountSid || !authToken) {
        return reply.code(400).send({
          error: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required for polling.',
        });
      }

      const tenantId = req.query.tenant_id || '00000000-0000-4000-a000-000000000001';
      const limit = Math.min(parseInt(req.query.limit ?? '10', 10) || 10, 50);

      // Audit: log access
      try {
        await auditRepo.log({
          tenant_id: tenantId,
          event_type: 'ceo_test.poll_sms_status',
          entity_type: 'debug',
          entity_id: 'ceo-test',
          actor: 'ceo-test-panel',
          payload: { ip: req.ip },
        });
      } catch { /* audit is best-effort */ }

      // Find outbox entries with a message_sid that don't have a terminal status yet
      const { rows } = await query<{ id: string; message_sid: string; provider_status: string | null }>(
        `SELECT id, message_sid, provider_status
         FROM sms_outbox
         WHERE tenant_id = $1
           AND message_sid IS NOT NULL
           AND (provider_status IS NULL OR provider_status NOT IN ('delivered', 'undelivered', 'failed'))
         ORDER BY created_at DESC
         LIMIT $2`,
        [tenantId, limit],
      );

      if (!rows.length) {
        return reply.code(200).send({
          polled: 0,
          message: 'No outbox entries with pending message_sid found. Either no SMS was sent, or all statuses are already terminal.',
          results: [],
        });
      }

      const results: Array<{
        message_sid_last4: string;
        old_status: string | null;
        new_status: string;
        error_code: number | null;
        raw_twilio_status: string;
      }> = [];

      for (const row of rows) {
        try {
          const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${row.message_sid}.json`;
          const data = await twilioHttpsGet(url, accountSid, authToken);

          const twilioStatus = (data.status as string) ?? 'unknown';
          const twilioErrorCode = typeof data.error_code === 'number' && data.error_code !== 0
            ? data.error_code
            : null;

          // Write back to DB
          await smsOutboxRepo.updateProviderStatus(
            row.message_sid,
            twilioStatus,
            twilioErrorCode,
          );

          results.push({
            message_sid_last4: row.message_sid.slice(-4),
            old_status: row.provider_status,
            new_status: twilioStatus,
            error_code: twilioErrorCode,
            raw_twilio_status: twilioStatus,
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          results.push({
            message_sid_last4: row.message_sid.slice(-4),
            old_status: row.provider_status,
            new_status: `poll_error: ${errMsg}`,
            error_code: null,
            raw_twilio_status: 'poll_error',
          });
        }
      }

      return {
        polled: results.length,
        results,
        diagnosis: buildDiagnosis(results),
      };
    },
  );
}

/**
 * Build a human-readable diagnosis from polled Twilio statuses.
 * Maps error codes to recommended actions.
 */
function buildDiagnosis(
  results: Array<{ new_status: string; error_code: number | null }>,
): { summary: string; recommendations: string[] } {
  const recommendations: string[] = [];
  const statusCounts: Record<string, number> = {};

  for (const r of results) {
    statusCounts[r.new_status] = (statusCounts[r.new_status] ?? 0) + 1;

    if (r.error_code) {
      const rec = errorCodeRecommendation(r.error_code);
      if (rec && !recommendations.includes(rec)) {
        recommendations.push(rec);
      }
    }

    // Status-specific recommendations
    if (r.new_status === 'undelivered' && !r.error_code) {
      const rec = 'Undelivered with no error code — likely carrier filtering. Register for A2P 10DLC.';
      if (!recommendations.includes(rec)) recommendations.push(rec);
    }
  }

  const parts = Object.entries(statusCounts).map(([s, c]) => `${s}: ${c}`);
  const summary = `Polled ${results.length} message(s). ${parts.join(', ')}.`;

  if (!recommendations.length) {
    recommendations.push('All messages in expected state — no action needed.');
  }

  return { summary, recommendations };
}

/** Map Twilio error codes to actionable recommendations */
function errorCodeRecommendation(code: number): string | null {
  const map: Record<number, string> = {
    30001: 'Error 30001 — Queue overflow. Reduce send rate or increase throughput.',
    30002: 'Error 30002 — Account suspended. Check Twilio console for compliance issues.',
    30003: 'Error 30003 — Unreachable destination. Verify the phone number is active.',
    30004: 'Error 30004 — Message blocked by carrier. Register for A2P 10DLC or use a Toll-Free number.',
    30005: 'Error 30005 — Unknown destination. Phone number may be invalid or ported.',
    30006: 'Error 30006 — Landline or unreachable. Cannot send SMS to this number.',
    30007: 'Error 30007 — Carrier filtering. Register for A2P 10DLC campaign.',
    30008: 'Error 30008 — Unknown error. Retry or contact Twilio support.',
    30010: 'Error 30010 — Message price exceeds max price. Increase MaxPrice or check pricing.',
    30034: 'Error 30034 — Message blocked by Twilio. May contain prohibited content.',
    21211: 'Error 21211 — Invalid "To" phone number format. Ensure E.164.',
    21610: 'Error 21610 — Recipient has opted out (STOP). Cannot send until they re-subscribe.',
    21614: 'Error 21614 — "To" number not a valid mobile. Cannot receive SMS.',
  };
  return map[code] ?? `Error ${code} — see https://www.twilio.com/docs/api/errors/${code}`;
}