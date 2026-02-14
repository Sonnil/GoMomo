-- ============================================================
-- AI Receptionist — Excel Sync Migration
-- Version: 003
-- Description: Add sync tracking columns to appointments,
--              Excel integration config to tenants, and
--              sync dead letter queue for failed operations.
-- ============================================================

-- ── 1. Appointment sync tracking ───────────────────────────────

-- sync_version: Monotonically increasing counter. Incremented on
-- every DB write. Used by the ExcelSyncAdapter to detect conflicts
-- when the admin edits a row the bot just updated.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS sync_version INTEGER NOT NULL DEFAULT 1;

-- sync_status: Tracks whether this row is in sync with the Excel
-- mirror. Values: 'synced' | 'pending' | 'failed'
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS sync_status VARCHAR(20) NOT NULL DEFAULT 'synced';

-- excel_row_ref: The Excel row number (e.g., "15") where this
-- appointment is stored. NULL if never synced.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS excel_row_ref TEXT;

-- last_synced_at: When this row was last successfully pushed to Excel.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

-- Index for reconciliation queries (find unsynced rows)
CREATE INDEX IF NOT EXISTS idx_appointments_sync_status
  ON appointments (sync_status)
  WHERE sync_status != 'synced';

-- ── 2. Tenant Excel integration config ─────────────────────────

-- Stores per-tenant Excel integration settings as JSONB:
-- {
--   "enabled": true,
--   "file_path": "/path/to/local/file.xlsx",   (dev mode)
--   "drive_id": "b!XXXXX",                      (OneDrive/SharePoint)
--   "file_id": "01XXXXXX",                      (OneDrive/SharePoint)
--   "sheet_name": "Appointments",
--   "last_etag": "\"abc123\"",
--   "last_reconciliation_at": "2026-02-06T00:00:00Z",
--   "sync_interval_seconds": 30,
--   "auth_tokens": { "access_token": "...", "refresh_token": "...", "expires_at": "..." }
-- }
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS excel_integration JSONB;

-- ── 3. Sync dead letter queue ──────────────────────────────────

-- Stores sync failures for retry. The reconciliation job picks
-- these up and re-attempts the sync.
CREATE TABLE IF NOT EXISTS sync_dead_letter (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  appointment_id  UUID REFERENCES appointments(id),
  operation       VARCHAR(20) NOT NULL,  -- 'create' | 'update' | 'delete'
  error_message   TEXT,
  payload         JSONB,                 -- Serialized row data for retry
  attempts        INTEGER NOT NULL DEFAULT 0,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved        BOOLEAN NOT NULL DEFAULT false,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_unresolved
  ON sync_dead_letter (tenant_id, resolved)
  WHERE resolved = false;

CREATE INDEX IF NOT EXISTS idx_dead_letter_appointment
  ON sync_dead_letter (appointment_id);

-- ── 4. Auto-increment sync_version on appointment updates ──────

-- Trigger function: bump sync_version on every UPDATE and set
-- sync_status to 'pending' so the sync worker knows to push.
CREATE OR REPLACE FUNCTION bump_sync_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.sync_version := OLD.sync_version + 1;
  NEW.updated_at := NOW();
  -- Only mark pending if Excel integration exists for the tenant
  -- (checked at application layer, but we set pending by default
  --  so the worker can filter by status)
  IF NEW.sync_status = 'synced' THEN
    NEW.sync_status := 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only fire on meaningful column changes (not on sync metadata updates)
DROP TRIGGER IF EXISTS trg_bump_sync_version ON appointments;
CREATE TRIGGER trg_bump_sync_version
  BEFORE UPDATE OF status, client_name, client_email, client_notes,
                   service, start_time, end_time, timezone
  ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION bump_sync_version();
