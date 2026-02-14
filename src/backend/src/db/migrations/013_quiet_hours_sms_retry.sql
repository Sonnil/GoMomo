-- ============================================================
-- Migration 013 — Quiet Hours + Outbound SMS Retry
--
-- Part A: Add quiet hours config to tenants (default 21:00–08:00)
-- Part B: Create sms_outbox table for queued/retried outbound SMS
-- ============================================================

-- ── Part A: Quiet hours columns on tenants ──────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS quiet_hours_start TEXT NOT NULL DEFAULT '21:00',
  ADD COLUMN IF NOT EXISTS quiet_hours_end   TEXT NOT NULL DEFAULT '08:00';

-- Quiet hours use the existing tenants.timezone column for TZ context.
-- '21:00' to '08:00' means: no outbound SMS from 9 PM to 8 AM tenant-local.

-- ── Part B: sms_outbox — queued outbound SMS ────────────────
-- Messages land here when quiet hours block immediate send,
-- or when a transport failure triggers retry scheduling.
CREATE TABLE IF NOT EXISTS sms_outbox (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id),
    phone             TEXT NOT NULL,
    body              TEXT NOT NULL,
    message_type      TEXT NOT NULL DEFAULT 'reminder',
    booking_id        TEXT,                                     -- appointment_id for idempotency
    scheduled_at      TIMESTAMPTZ NOT NULL,                     -- when to (re-)attempt delivery
    idempotency_key   TEXT NOT NULL,                            -- message_type + booking_id + scheduled_at
    status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'aborted')),
    attempts          INTEGER NOT NULL DEFAULT 0,
    max_attempts      INTEGER NOT NULL DEFAULT 3,               -- 1 original + 2 retries
    last_error        TEXT,
    abort_reason      TEXT,                                     -- opt_out | booking_changed | quiet_hours_reenter
    source_job_id     UUID,                                     -- links back to the originating job
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency: prevent duplicate queued messages for the same booking+time
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_outbox_idempotency
  ON sms_outbox(idempotency_key)
  WHERE status IN ('queued', 'sending');

-- Polling: find messages ready to send
CREATE INDEX IF NOT EXISTS idx_sms_outbox_pending
  ON sms_outbox(status, scheduled_at)
  WHERE status = 'queued';

-- Lookup by booking for abort-on-cancel/reschedule
CREATE INDEX IF NOT EXISTS idx_sms_outbox_booking
  ON sms_outbox(booking_id)
  WHERE status IN ('queued', 'sending');
