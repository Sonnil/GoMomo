-- ============================================================
-- Migration 008: Inbound SMS Channel
--
-- Adds:
--   1. sms_opt_outs        — STOP/unsubscribe compliance
--   2. sms_rate_limits     — DB-backed per-phone rate limiting
--   3. sms_phone_sessions  — phone → chat_session mapping
--   4. tenants.sms_phone_number — per-tenant Twilio number
-- ============================================================

-- 1. SMS Opt-Out Tracking ────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT NOT NULL,               -- E.164 format
  tenant_id     UUID REFERENCES tenants(id),  -- NULL = global opt-out
  opted_out_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (phone, tenant_id)
);

-- Allow quick lookup by phone
CREATE INDEX IF NOT EXISTS idx_sms_opt_outs_phone ON sms_opt_outs (phone);

-- 2. DB-Backed SMS Rate Limits ───────────────────────────────
-- One row per SMS send event; query with a time window for rate limiting.
-- Replaces the in-memory Map that was lost on restart.
CREATE TABLE IF NOT EXISTS sms_rate_limits (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      TEXT NOT NULL,                  -- E.164 format
  tenant_id  UUID REFERENCES tenants(id),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_rate_limits_phone_sent
  ON sms_rate_limits (phone, sent_at DESC);

-- Auto-cleanup: rows older than 24h are safe to delete (max window is 60min)
-- A periodic job can do: DELETE FROM sms_rate_limits WHERE sent_at < NOW() - INTERVAL '24 hours';

-- 3. Phone → Chat Session Mapping ────────────────────────────
-- Maps an E.164 phone number to a persistent chat_session so that
-- multi-turn SMS conversations resume the same session.
CREATE TABLE IF NOT EXISTS sms_phone_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT NOT NULL,                  -- E.164
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  session_id  UUID NOT NULL,                  -- References chat_sessions.id (text UUID)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (phone, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_sms_phone_sessions_phone
  ON sms_phone_sessions (phone, tenant_id);

-- 4. Per-Tenant SMS Phone Number ─────────────────────────────
-- Allows routing inbound SMS to the correct tenant.
-- NULL means "use VOICE_DEFAULT_TENANT_ID" (dev mode fallback).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenants' AND column_name = 'sms_phone_number'
  ) THEN
    ALTER TABLE tenants ADD COLUMN sms_phone_number TEXT;
  END IF;
END $$;
