-- ============================================================
-- Migration 014: SMS Kill Switches for Pilot Ops Readiness
--
-- Adds three tenant-level boolean flags for operational control:
--   sms_outbound_enabled  — master switch for all outbound SMS
--   sms_retry_enabled     — controls whether failed sends retry
--   sms_quiet_hours_enabled — controls quiet hours enforcement
--
-- All default TRUE (existing behavior unchanged).
-- ============================================================

-- Part A: Kill-switch columns on tenants
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS sms_outbound_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sms_retry_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sms_quiet_hours_enabled BOOLEAN NOT NULL DEFAULT TRUE;
