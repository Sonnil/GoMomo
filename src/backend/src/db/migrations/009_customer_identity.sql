-- ============================================================
-- Migration 009: Customer Identity + Session Continuity
--
-- Adds:
--   1. customers           — persistent customer identity (phone/email)
--   2. chat_sessions       — add customer_id FK + channel column
--   3. customer lookup indexes for cross-channel resolution
--
-- Design principles:
--   - Phone and email are both optional — at least one required at app layer
--   - Phone stored in E.164 format, email stored lowercase
--   - Preferences stored as JSONB for flexible schema evolution
--   - Soft-delete via deleted_at (NULL = active)
--   - One customer per (phone|email, tenant) — not globally unique
-- ============================================================

-- 1. Customers Table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  phone           TEXT,                                -- E.164 format, nullable
  email           TEXT,                                -- lowercase, nullable
  display_name    TEXT,                                -- last known name
  preferences     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {timezone, preferred_service, practitioner, contact_preference}
  booking_count   INTEGER NOT NULL DEFAULT 0,          -- lifetime bookings
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,                         -- soft-delete
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint: one customer per phone+tenant (active only)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_tenant
  ON customers (phone, tenant_id)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;

-- Unique constraint: one customer per email+tenant (active only)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_tenant
  ON customers (email, tenant_id)
  WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Lookup by tenant
CREATE INDEX IF NOT EXISTS idx_customers_tenant
  ON customers (tenant_id)
  WHERE deleted_at IS NULL;

-- 2. Link chat_sessions to customer ──────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_sessions' AND column_name = 'customer_id'
  ) THEN
    ALTER TABLE chat_sessions ADD COLUMN customer_id UUID REFERENCES customers(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_sessions' AND column_name = 'channel'
  ) THEN
    ALTER TABLE chat_sessions ADD COLUMN channel TEXT NOT NULL DEFAULT 'web'
      CHECK (channel IN ('web', 'sms', 'voice'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_customer
  ON chat_sessions (customer_id)
  WHERE customer_id IS NOT NULL;
