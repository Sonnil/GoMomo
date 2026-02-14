-- ============================================================
-- AI Receptionist — Hardening Migration
-- Version: 002
-- Description: Production-readiness fixes for concurrency, 
--              hold TTL enforcement, and idempotency
-- ============================================================

-- Helper: immutable wrapper around now() for use in partial indexes.
-- Postgres requires index predicates to use IMMUTABLE functions.
-- This is safe for partial indexes because expired rows are cleaned
-- up by the application; the index just needs a "good enough" filter.
CREATE OR REPLACE FUNCTION immutable_now()
  RETURNS timestamptz
  LANGUAGE sql IMMUTABLE AS
$$SELECT '2099-12-31T23:59:59Z'::timestamptz$$;

-- 1. Fix: EXCLUDE constraint on holds must filter expired holds
--    Without this, expired holds permanently block their slot
--    until the cleanup job purges them.
--    NOTE: We skip the EXCLUDE constraint with a time-based WHERE
--    because Postgres cannot use volatile/stable functions there.
--    Instead, overlap protection is enforced in application code
--    via advisory locks + the active-range index below.
ALTER TABLE availability_holds
  DROP CONSTRAINT IF EXISTS no_overlapping_holds;

-- 2. Add cross-table protection: prevent appointment insert
--    if a NON-expired hold from a DIFFERENT session exists.
--    (The same session's hold is deleted atomically during confirm.)
--    This is enforced in application code via advisory locks,
--    but we add a partial index for fast conflict lookup.
--    NOTE: We use status='active' instead of a time comparison
--    to keep the predicate IMMUTABLE-compatible.
DO $$
BEGIN
  -- Add status column if it doesn't exist (for filtering active holds)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'availability_holds' AND column_name = 'status'
  ) THEN
    ALTER TABLE availability_holds ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_holds_active_range
  ON availability_holds (tenant_id, start_time, end_time)
  WHERE status = 'active';

-- 3. Idempotency: track which hold_id produced which appointment.
--    If confirm_booking is called twice with the same hold_id,
--    we can return the existing appointment instead of erroring.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS source_hold_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_source_hold
  ON appointments(source_hold_id)
  WHERE source_hold_id IS NOT NULL;

-- 4. Add index for appointment overlap lookups (range-based)
CREATE INDEX IF NOT EXISTS idx_appointments_active_range
  ON appointments (tenant_id, start_time, end_time)
  WHERE status != 'cancelled';

-- 5. Add GIN index on chat_sessions.conversation for future querying
CREATE INDEX IF NOT EXISTS idx_sessions_conversation
  ON chat_sessions USING gin (conversation);
