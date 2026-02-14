-- Migration 019: Trial usage tracking columns
-- Adds per-session counters for trial abuse protection.
-- user_message_count: incremented only for messages that pass the email gate.
-- booking_count: incremented after a successful confirm_booking.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS user_message_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS booking_count INTEGER NOT NULL DEFAULT 0;
