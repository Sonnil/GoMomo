-- ============================================================
-- Migration 011: SMS Channel Elevation
--
-- Adds:
--   1. direction column on sms_rate_limits (inbound vs outbound)
--   2. channel column on chat_sessions (web, sms, voice)
--
-- This enables separate rate limits for inbound conversational
-- SMS (high: 20/hr) vs outbound proactive SMS (low: 3/hr).
-- ============================================================

-- 1. Add direction to sms_rate_limits ─────────────────────────
ALTER TABLE sms_rate_limits
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound';

-- Update index to include direction for efficient filtering
CREATE INDEX IF NOT EXISTS idx_sms_rate_limits_phone_dir_sent
  ON sms_rate_limits (phone, direction, sent_at DESC);

-- 2. Add channel to chat_sessions (if not exists) ────────────
ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'web';

-- Index for channel-based queries
CREATE INDEX IF NOT EXISTS idx_chat_sessions_channel
  ON chat_sessions (channel);
