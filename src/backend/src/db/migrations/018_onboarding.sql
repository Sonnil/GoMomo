-- ============================================================
-- Migration 018: SMB Onboarding — add service_description column
--
-- Adds a free-text service description field for the business
-- onboarding flow. This is displayed in the booking widget to
-- help customers understand what the business offers.
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS service_description TEXT NOT NULL DEFAULT '';
