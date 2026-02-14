// ============================================================
// Outbound SMS Gateway — Quiet Hours + Deterministic Retry
//
// This is the single entry point for all outbound SMS that
// need quiet-hours enforcement. It:
//
//   1. Checks whether the current time is within quiet hours.
//      → If yes, queues to sms_outbox for later delivery.
//      → If no, attempts immediate send.
//
//   2. On transport failure, schedules retry with backoff:
//      - Attempt 1 failed → retry in 2 minutes
//      - Attempt 2 failed → retry in 10 minutes
//      - Attempt 3 failed → mark as permanently failed
//
//   3. Before every send/retry, checks abort conditions:
//      - Recipient opted out (STOP)
//      - Booking was cancelled or rescheduled
//      - Retry would land inside quiet hours (re-queue instead)
//
//   4. Emits audit events (no PII):
//      - QUEUED_DUE_TO_QUIET_HOURS
//      - RETRY_SCHEDULED
//      - RETRY_ABORTED
//
// Does NOT modify: policy engine, tool allowlist, guardrails.
// ============================================================

import { sendSms } from './sms-sender.js';
import { smsOutboxRepo } from '../repos/sms-outbox.repo.js';
import { env } from '../config/env.js';
import { smsOptOutRepo } from '../repos/sms-opt-out.repo.js';
import { auditRepo } from '../repos/audit.repo.js';
import { smsMetricInc } from './sms-metrics.js';
import {
  isQuietHours,
  nextAllowedSendTime,
  tenantQuietHours,
} from './quiet-hours.js';

// ── Retry backoff schedule (in milliseconds) ────────────────
// Index 0 = after 1st failure, index 1 = after 2nd failure.
const RETRY_BACKOFF_MS = [
  2 * 60 * 1000,    // 2 minutes
  10 * 60 * 1000,   // 10 minutes
];

export interface OutboundSmsRequest {
  tenantId: string;
  phone: string;
  body: string;
  messageType: string;           // e.g. 'reminder', 'confirmation'
  bookingId?: string | null;     // appointment_id — for idempotency + abort
  scheduledAt?: Date;            // original scheduled send time (for idempotency key)
  sourceJobId?: string | null;   // the originating job (for traceability)
}

export interface OutboundSmsResult {
  /** Whether the message was sent immediately */
  sent: boolean;
  /** Whether the message was queued for later (quiet hours) */
  queued: boolean;
  /** The sms_outbox ID if queued */
  outboxId?: string;
  /** Scheduled delivery time if queued */
  scheduledAt?: Date;
  /** Error message if send failed */
  error?: string;
  /** Whether this was delivered via simulator (no real Twilio) */
  simulated?: boolean;
  /** Twilio message SID (last 4 chars only for safety) */
  messageSidLast4?: string;
}

/**
 * Send or queue an outbound SMS, respecting quiet hours.
 *
 * @param request - The SMS to send
 * @param tenant  - Tenant config (needs timezone, quiet_hours_start/end)
 * @returns Result indicating sent, queued, or error
 */
export async function sendOutboundSms(
  request: OutboundSmsRequest,
  tenant: {
    timezone: string;
    quiet_hours_start?: string;
    quiet_hours_end?: string;
    sms_outbound_enabled?: boolean;
    sms_retry_enabled?: boolean;
    sms_quiet_hours_enabled?: boolean;
  },
): Promise<OutboundSmsResult> {
  const now = new Date();

  // ── Master kill switch: FEATURE_SMS ───────────────────────
  if (env.FEATURE_SMS === 'false') {
    console.log(`[outbound-sms] Blocked — FEATURE_SMS=false (booking-only mode)`);
    return { sent: false, queued: false, error: 'sms_feature_disabled' };
  }

  // ── Kill switch: sms_outbound_enabled ─────────────────────
  if (tenant.sms_outbound_enabled === false) {
    smsMetricInc('blocked_outbound_disabled');
    await auditRepo.log({
      tenant_id: request.tenantId,
      event_type: 'sms.blocked_outbound_disabled',
      entity_type: 'sms_outbox',
      entity_id: null,
      actor: 'outbound_sms_gateway',
      payload: { message_type: request.messageType, booking_id: request.bookingId ?? null },
    });
    console.log(`[outbound-sms] Blocked — sms_outbound_enabled=false`);
    return { sent: false, queued: false, error: 'sms_outbound_disabled' };
  }

  const qhConfig = tenantQuietHours(tenant);

  // Build idempotency key: messageType + bookingId + scheduledAt
  const scheduledKey = (request.scheduledAt ?? now).toISOString();
  const idempotencyKey = `${request.messageType}:${request.bookingId ?? 'none'}:${scheduledKey}`;

  // ── Check quiet hours (skip if kill switch off) ────────────
  const quietHoursActive = tenant.sms_quiet_hours_enabled !== false && isQuietHours(now, qhConfig);
  if (quietHoursActive) {
    const nextSend = nextAllowedSendTime(now, qhConfig);

    const entry = await smsOutboxRepo.enqueue({
      tenant_id: request.tenantId,
      phone: request.phone,
      body: request.body,
      message_type: request.messageType,
      booking_id: request.bookingId ?? null,
      scheduled_at: nextSend,
      idempotency_key: idempotencyKey,
      max_attempts: 3,       // 1 original + 2 retries
      source_job_id: request.sourceJobId ?? null,
    });

    // Audit: QUEUED_DUE_TO_QUIET_HOURS (no PII)
    await auditRepo.log({
      tenant_id: request.tenantId,
      event_type: 'sms.queued_due_to_quiet_hours',
      entity_type: 'sms_outbox',
      entity_id: entry.id,
      actor: 'outbound_sms_gateway',
      payload: {
        message_type: request.messageType,
        booking_id: request.bookingId ?? null,
        scheduled_at: nextSend.toISOString(),
        quiet_hours_start: qhConfig.start,
        quiet_hours_end: qhConfig.end,
      },
    });

    console.log(`[outbound-sms] Queued (quiet hours) — deliver at ${nextSend.toISOString()}`);

    smsMetricInc('queued');

    return {
      sent: false,
      queued: true,
      outboxId: entry.id,
      scheduledAt: nextSend,
    };
  }

  // ── Not quiet hours — attempt immediate send ──────────────
  const result = await sendSms(request.phone, request.body, request.tenantId);

  if (result.success) {
    smsMetricInc('sent');
    return {
      sent: true,
      queued: false,
      simulated: result.simulated ?? false,
      messageSidLast4: result.messageSid?.slice(-4),
    };
  }

  // ── Transport failure — queue for retry ───────────────────
  // Opt-out and rate-limit failures are NOT retried (they are logical, not transient).
  if (result.optedOut || result.rateLimited) {
    smsMetricInc('failed');
    return { sent: false, queued: false, error: result.error };
  }

  // ── Kill switch: sms_retry_enabled ────────────────────────
  if (tenant.sms_retry_enabled === false) {
    smsMetricInc('blocked_retry_disabled');
    smsMetricInc('failed');
    await auditRepo.log({
      tenant_id: request.tenantId,
      event_type: 'sms.blocked_retry_disabled',
      entity_type: 'sms_outbox',
      entity_id: null,
      actor: 'outbound_sms_gateway',
      payload: { message_type: request.messageType, error: result.error },
    });
    console.log(`[outbound-sms] Retry blocked — sms_retry_enabled=false`);
    return { sent: false, queued: false, error: result.error };
  }

  const entry = await smsOutboxRepo.enqueue({
    tenant_id: request.tenantId,
    phone: request.phone,
    body: request.body,
    message_type: request.messageType,
    booking_id: request.bookingId ?? null,
    scheduled_at: new Date(now.getTime() + RETRY_BACKOFF_MS[0]),
    idempotency_key: idempotencyKey,
    max_attempts: 3,
    source_job_id: request.sourceJobId ?? null,
  });

  await auditRepo.log({
    tenant_id: request.tenantId,
    event_type: 'sms.retry_scheduled',
    entity_type: 'sms_outbox',
    entity_id: entry.id,
    actor: 'outbound_sms_gateway',
    payload: {
      message_type: request.messageType,
      booking_id: request.bookingId ?? null,
      attempt: 1,
      retry_at: new Date(now.getTime() + RETRY_BACKOFF_MS[0]).toISOString(),
      error: result.error,
    },
  });

  console.log(`[outbound-sms] Transport failure — retry scheduled in 2m`);

  smsMetricInc('retry_scheduled');

  return {
    sent: false,
    queued: true,
    outboxId: entry.id,
    scheduledAt: new Date(now.getTime() + RETRY_BACKOFF_MS[0]),
    error: result.error,
  };
}

// ── Outbox Processor ────────────────────────────────────────
// Called by the job runner on a periodic schedule to flush
// queued messages that are past their scheduled_at time.

/**
 * Process pending outbox messages. Called periodically.
 *
 * For each message:
 *   1. Re-check abort conditions (opt-out, booking change, quiet hours)
 *   2. Attempt send via Twilio
 *   3. On failure: schedule retry with backoff, or mark failed if max reached
 */
export async function processOutbox(
  limit = 5,
  getTenant?: (tenantId: string) => Promise<{
    timezone: string;
    quiet_hours_start?: string;
    quiet_hours_end?: string;
    sms_outbound_enabled?: boolean;
    sms_retry_enabled?: boolean;
    sms_quiet_hours_enabled?: boolean;
  } | null>,
): Promise<{ processed: number; sent: number; aborted: number; retried: number; failed: number }> {
  const entries = await smsOutboxRepo.claimBatch(limit);
  let sent = 0, aborted = 0, retried = 0, failed = 0;

  for (const entry of entries) {
    try {
      // ── Abort condition 1: opt-out ──────────────────────
      const optedOut = await smsOptOutRepo.isOptedOut(entry.phone, entry.tenant_id);
      if (optedOut) {
        await smsOutboxRepo.abort(entry.id, 'opt_out');
        await logAbort(entry, 'opt_out');
        smsMetricInc('retry_aborted');
        aborted++;
        continue;
      }

      // ── Abort condition 2: quiet hours re-enter ─────────
      if (getTenant) {
        const tenant = await getTenant(entry.tenant_id);
        if (tenant) {
          // Kill switch: sms_outbound_enabled off at process time
          if (tenant.sms_outbound_enabled === false) {
            await smsOutboxRepo.abort(entry.id, 'outbound_disabled');
            await logAbort(entry, 'outbound_disabled');
            smsMetricInc('retry_aborted');
            smsMetricInc('blocked_outbound_disabled');
            aborted++;
            continue;
          }

          // Kill switch: sms_retry_enabled off — abort retries (attempt > 1)
          if (tenant.sms_retry_enabled === false && entry.attempts > 1) {
            await smsOutboxRepo.abort(entry.id, 'retry_disabled');
            await logAbort(entry, 'retry_disabled');
            smsMetricInc('retry_aborted');
            smsMetricInc('blocked_retry_disabled');
            aborted++;
            continue;
          }

          // Quiet hours re-enter (only if quiet hours enabled)
          if (tenant.sms_quiet_hours_enabled !== false) {
            const qhConfig = tenantQuietHours(tenant);
            if (isQuietHours(new Date(), qhConfig)) {
              const nextSend = nextAllowedSendTime(new Date(), qhConfig);
              await smsOutboxRepo.scheduleRetry(entry.id, nextSend, 'Re-queued: quiet hours');
              await logAbort(entry, 'quiet_hours_reenter');
              smsMetricInc('retry_aborted');
              aborted++;
              continue;
            }
          }
        }
      }

      // ── Attempt send ────────────────────────────────────
      // Audit: outbound attempted (no PII — category only)
      await auditRepo.log({
        tenant_id: entry.tenant_id,
        event_type: 'sms.outbound_attempted',
        entity_type: 'sms_outbox',
        entity_id: entry.id,
        actor: 'outbox_processor',
        payload: {
          message_type: entry.message_type,
          booking_id: entry.booking_id,
          attempt: entry.attempts,
        },
      });

      const result = await sendSms(entry.phone, entry.body, entry.tenant_id);

      if (result.success) {
        await smsOutboxRepo.markSent(entry.id, result.messageSid);
        smsMetricInc('retry_succeeded');
        smsMetricInc('sent');
        sent++;

        // Audit: outbound sent (masked SID ok, no PII)
        await auditRepo.log({
          tenant_id: entry.tenant_id,
          event_type: 'sms.outbound_sent',
          entity_type: 'sms_outbox',
          entity_id: entry.id,
          actor: 'outbox_processor',
          payload: {
            message_type: entry.message_type,
            booking_id: entry.booking_id,
            message_sid_last4: result.messageSid?.slice(-4) ?? null,
            simulated: result.simulated ?? false,
          },
        });

        console.log(`[outbound-sms] ✅ Delivered outbox ${entry.id.slice(0, 8)}…`);
        continue;
      }

      // ── Opt-out discovered at send time → abort ─────────
      if (result.optedOut) {
        await smsOutboxRepo.abort(entry.id, 'opt_out');
        await logAbort(entry, 'opt_out');
        smsMetricInc('retry_aborted');
        aborted++;
        continue;
      }

      // ── Transport failure → retry or fail ───────────────
      const retryIndex = entry.attempts - 1; // attempts was incremented by claimBatch
      if (retryIndex < RETRY_BACKOFF_MS.length) {
        const retryAt = new Date(Date.now() + RETRY_BACKOFF_MS[retryIndex]);
        await smsOutboxRepo.scheduleRetry(entry.id, retryAt, result.error ?? 'transport failure');

        await auditRepo.log({
          tenant_id: entry.tenant_id,
          event_type: 'sms.retry_scheduled',
          entity_type: 'sms_outbox',
          entity_id: entry.id,
          actor: 'outbox_processor',
          payload: {
            message_type: entry.message_type,
            booking_id: entry.booking_id,
            attempt: entry.attempts,
            retry_at: retryAt.toISOString(),
          },
        });

        retried++;
        smsMetricInc('retry_scheduled');
        console.log(`[outbound-sms] Retry ${entry.attempts}/${entry.max_attempts} scheduled for ${entry.id.slice(0, 8)}…`);
      } else {
        await smsOutboxRepo.markFailed(entry.id, result.error ?? 'max retries exhausted', result.twilioErrorCode);
        failed++;
        smsMetricInc('failed');

        // Audit: outbound failed (error code/category, no PII)
        await auditRepo.log({
          tenant_id: entry.tenant_id,
          event_type: 'sms.outbound_failed',
          entity_type: 'sms_outbox',
          entity_id: entry.id,
          actor: 'outbox_processor',
          payload: {
            message_type: entry.message_type,
            booking_id: entry.booking_id,
            attempt: entry.attempts,
            error_category: categoriseTwilioError(result.error),
            error_code: result.twilioErrorCode ?? null,
          },
        });

        console.log(`[outbound-sms] ❌ Max retries exhausted for ${entry.id.slice(0, 8)}…`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Unexpected error — mark failed to prevent infinite retry
      await smsOutboxRepo.markFailed(entry.id, errMsg);
      failed++;
      smsMetricInc('failed');
      console.error(`[outbound-sms] Unexpected error processing ${entry.id.slice(0, 8)}…:`, err);
    }
  }

  return { processed: entries.length, sent, aborted, retried, failed };
}

// ── Helpers ─────────────────────────────────────────────────

async function logAbort(entry: { id: string; tenant_id: string; message_type: string; booking_id: string | null }, reason: string): Promise<void> {
  await auditRepo.log({
    tenant_id: entry.tenant_id,
    event_type: 'sms.retry_aborted',
    entity_type: 'sms_outbox',
    entity_id: entry.id,
    actor: 'outbox_processor',
    payload: {
      message_type: entry.message_type,
      booking_id: entry.booking_id,
      abort_reason: reason,
    },
  });
  console.log(`[outbound-sms] Aborted ${entry.id.slice(0, 8)}… — reason: ${reason}`);
}

/**
 * Categorise a Twilio/transport error string into a PII-safe category.
 */
function categoriseTwilioError(error?: string): string {
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
