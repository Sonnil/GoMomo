-- ============================================================
-- Migration 012 — Safe Cancellation + SMS Reminders
--
-- Part A: Add client_phone to appointments (for SMS reminders)
-- Part B: Create appointment_reminders table (tracks scheduled
--         SMS reminder jobs so they can be cancelled)
-- ============================================================

-- ── Part A: client_phone on appointments ────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS client_phone TEXT;

-- Index for phone-based lookups (e.g. linking SMS sender to bookings)
CREATE INDEX IF NOT EXISTS idx_appointments_client_phone
  ON appointments(client_phone)
  WHERE client_phone IS NOT NULL;

-- ── Part B: appointment_reminders tracking ──────────────────
-- Links appointments to their scheduled reminder jobs so we
-- can cancel the job when the appointment is cancelled/rescheduled.
CREATE TABLE IF NOT EXISTS appointment_reminders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    appointment_id  UUID NOT NULL REFERENCES appointments(id),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    job_id          UUID NOT NULL REFERENCES jobs(id),
    reminder_type   TEXT NOT NULL DEFAULT 'sms_2h',
    phone           TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
    scheduled_at    TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_apt
  ON appointment_reminders(appointment_id);

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_job
  ON appointment_reminders(job_id);

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_pending
  ON appointment_reminders(status, scheduled_at)
  WHERE status = 'pending';
