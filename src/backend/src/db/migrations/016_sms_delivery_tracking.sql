-- 016_sms_delivery_tracking.sql
--
-- Add delivery-tracking columns to sms_outbox:
--   message_sid     — Twilio Message SID (e.g. SMxxxxxx)
--   provider_status — last status from Twilio StatusCallback
--                     (queued/sent/delivered/undelivered/failed)
--   error_code      — Twilio numeric error code (e.g. 30006)
--
-- These enable:
--   1. Correlating StatusCallback webhooks to outbox rows
--   2. Surfacing delivery status + error codes in /debug/ceo-test/last-sms
--   3. Diagnosing "undelivered" SMS without manual Twilio console lookup

ALTER TABLE sms_outbox
  ADD COLUMN IF NOT EXISTS message_sid     TEXT,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS error_code      INTEGER;

-- Index for StatusCallback lookups: Twilio posts with MessageSid
CREATE INDEX IF NOT EXISTS idx_sms_outbox_message_sid
  ON sms_outbox (message_sid)
  WHERE message_sid IS NOT NULL;
