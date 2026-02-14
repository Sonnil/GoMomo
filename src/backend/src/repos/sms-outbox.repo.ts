// ============================================================
// SMS Outbox Repository
//
// Manages queued outbound SMS messages — those deferred by
// quiet hours or awaiting retry after transport failure.
// ============================================================

import { query } from '../db/client.js';

export interface SmsOutboxEntry {
  id: string;
  tenant_id: string;
  phone: string;
  body: string;
  message_type: string;
  booking_id: string | null;
  scheduled_at: Date;
  idempotency_key: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'aborted';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  abort_reason: string | null;
  source_job_id: string | null;
  /** Twilio Message SID (e.g. SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) */
  message_sid: string | null;
  /** Last delivery status from Twilio StatusCallback (queued/sent/delivered/undelivered/failed) */
  provider_status: string | null;
  /** Twilio numeric error code (e.g. 30006) — populated by StatusCallback on undelivered/failed */
  error_code: number | null;
  created_at: Date;
  updated_at: Date;
}

export const smsOutboxRepo = {
  /**
   * Queue a new outbound SMS (or return existing if idempotency key matches).
   */
  async enqueue(data: {
    tenant_id: string;
    phone: string;
    body: string;
    message_type: string;
    booking_id?: string | null;
    scheduled_at: Date;
    idempotency_key: string;
    max_attempts?: number;
    source_job_id?: string | null;
  }): Promise<SmsOutboxEntry> {
    const { rows } = await query<SmsOutboxEntry>(
      `INSERT INTO sms_outbox
         (tenant_id, phone, body, message_type, booking_id, scheduled_at,
          idempotency_key, max_attempts, source_job_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (idempotency_key) WHERE status IN ('queued', 'sending')
       DO NOTHING
       RETURNING *`,
      [
        data.tenant_id,
        data.phone,
        data.body,
        data.message_type,
        data.booking_id ?? null,
        data.scheduled_at.toISOString(),
        data.idempotency_key,
        data.max_attempts ?? 3,
        data.source_job_id ?? null,
      ],
    );

    // ON CONFLICT DO NOTHING returns no rows — fetch the existing one
    if (rows.length === 0) {
      const existing = await query<SmsOutboxEntry>(
        `SELECT * FROM sms_outbox WHERE idempotency_key = $1 AND status IN ('queued', 'sending')`,
        [data.idempotency_key],
      );
      return existing.rows[0];
    }

    return rows[0];
  },

  /**
   * Claim a batch of messages ready to send (scheduled_at <= NOW).
   * Uses FOR UPDATE SKIP LOCKED to prevent double-claiming.
   */
  async claimBatch(limit: number): Promise<SmsOutboxEntry[]> {
    const { rows } = await query<SmsOutboxEntry>(
      `UPDATE sms_outbox
       SET status = 'sending', attempts = attempts + 1, updated_at = NOW()
       WHERE id IN (
         SELECT id FROM sms_outbox
         WHERE status = 'queued'
           AND scheduled_at <= NOW()
         ORDER BY scheduled_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    );
    return rows;
  },

  /**
   * Mark a message as successfully sent.
   * Optionally stores the Twilio Message SID for delivery tracking.
   */
  async markSent(id: string, messageSid?: string): Promise<void> {
    await query(
      `UPDATE sms_outbox
       SET status = 'sent', message_sid = COALESCE($2, message_sid), updated_at = NOW()
       WHERE id = $1`,
      [id, messageSid ?? null],
    );
  },

  /**
   * Mark a message for retry at a specific time.
   * Sets status back to 'queued' with a new scheduled_at.
   */
  async scheduleRetry(id: string, retryAt: Date, error: string): Promise<void> {
    await query(
      `UPDATE sms_outbox
       SET status = 'queued', scheduled_at = $2, last_error = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, retryAt.toISOString(), error],
    );
  },

  /**
   * Mark a message as permanently failed (max retries exhausted).
   * Optionally stores the Twilio error code.
   */
  async markFailed(id: string, error: string, errorCode?: number): Promise<void> {
    await query(
      `UPDATE sms_outbox
       SET status = 'failed', last_error = $2, error_code = COALESCE($3, error_code), updated_at = NOW()
       WHERE id = $1`,
      [id, error, errorCode ?? null],
    );
  },

  /**
   * Abort a message (opt-out, booking change, quiet hours re-enter).
   */
  async abort(id: string, reason: string): Promise<void> {
    await query(
      `UPDATE sms_outbox SET status = 'aborted', abort_reason = $2, updated_at = NOW() WHERE id = $1`,
      [id, reason],
    );
  },

  /**
   * Abort all queued/sending messages for a given booking_id.
   * Called when a booking is cancelled or rescheduled.
   * Returns count of aborted messages.
   */
  async abortByBooking(bookingId: string, reason: string): Promise<number> {
    const { rowCount } = await query(
      `UPDATE sms_outbox
       SET status = 'aborted', abort_reason = $2, updated_at = NOW()
       WHERE booking_id = $1 AND status IN ('queued', 'sending')`,
      [bookingId, reason],
    );
    return rowCount ?? 0;
  },

  /**
   * Find a queued/sending entry by ID.
   */
  async findById(id: string): Promise<SmsOutboxEntry | null> {
    const { rows } = await query<SmsOutboxEntry>(
      'SELECT * FROM sms_outbox WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  },

  /**
   * Find an entry by Twilio Message SID (for StatusCallback lookups).
   */
  async findByMessageSid(messageSid: string): Promise<SmsOutboxEntry | null> {
    const { rows } = await query<SmsOutboxEntry>(
      'SELECT * FROM sms_outbox WHERE message_sid = $1',
      [messageSid],
    );
    return rows[0] ?? null;
  },

  /**
   * Update provider delivery status from Twilio StatusCallback.
   * Called when Twilio POSTs status updates (sent/delivered/undelivered/failed).
   * Returns the updated row, or null if message_sid not found.
   */
  async updateProviderStatus(
    messageSid: string,
    providerStatus: string,
    errorCode?: number | null,
  ): Promise<SmsOutboxEntry | null> {
    const { rows } = await query<SmsOutboxEntry>(
      `UPDATE sms_outbox
       SET provider_status = $2,
           error_code = COALESCE($3, error_code),
           updated_at = NOW()
       WHERE message_sid = $1
       RETURNING *`,
      [messageSid, providerStatus, errorCode ?? null],
    );
    return rows[0] ?? null;
  },

  /**
   * Find queued entries for a booking (for abort checks).
   */
  async findQueuedByBooking(bookingId: string): Promise<SmsOutboxEntry[]> {
    const { rows } = await query<SmsOutboxEntry>(
      `SELECT * FROM sms_outbox WHERE booking_id = $1 AND status IN ('queued', 'sending')`,
      [bookingId],
    );
    return rows;
  },

  /**
   * Health stats: queue depth + oldest pending age + last error category.
   * Returns aggregated data (no PII).
   */
  async healthStats(): Promise<{
    queue_depth: number;
    oldest_pending_age_seconds: number | null;
    last_error_category: string | null;
  }> {
    const depthResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sms_outbox WHERE status IN ('queued', 'sending')`,
    );
    const queue_depth = parseInt(depthResult.rows[0]?.count ?? '0', 10);

    const ageResult = await query<{ age_seconds: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(scheduled_at)))::int AS age_seconds
       FROM sms_outbox WHERE status = 'queued'`,
    );
    const oldest_pending_age_seconds = ageResult.rows[0]?.age_seconds
      ? parseInt(ageResult.rows[0].age_seconds, 10)
      : null;

    const errorResult = await query<{ last_error: string | null }>(
      `SELECT last_error FROM sms_outbox
       WHERE status = 'failed' AND last_error IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    );
    // Categorize error (strip PII) — just the first word/phrase
    const rawError = errorResult.rows[0]?.last_error ?? null;
    const last_error_category = rawError
      ? categorizeError(rawError)
      : null;

    return { queue_depth, oldest_pending_age_seconds, last_error_category };
  },
};

/**
 * Categorize an error string into a PII-safe category.
 */
function categorizeError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('timeout')) return 'timeout';
  if (lower.includes('rate')) return 'rate_limit';
  if (lower.includes('opt')) return 'opt_out';
  if (lower.includes('invalid')) return 'invalid_request';
  if (lower.includes('auth')) return 'auth_failure';
  if (lower.includes('max retries')) return 'max_retries_exhausted';
  if (lower.includes('transport')) return 'transport_failure';
  return 'unknown';
}
