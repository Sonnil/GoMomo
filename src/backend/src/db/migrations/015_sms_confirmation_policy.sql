-- ============================================================
-- Migration 015: Add missing SMS confirmation policy rule
--
-- ROOT CAUSE FIX: The on-booking-created handler calls
-- policyEngine.evaluate('send_sms_confirmation', ...) but no
-- matching rule existed in policy_rules. With the DEFAULT DENY
-- policy engine, all SMS booking confirmations were silently
-- blocked — never enqueued to sms_outbox.
--
-- This adds an ALLOW rule for send_sms_confirmation with
-- channel=sms, matching the pattern used by send_contact_followup.
-- ============================================================

INSERT INTO policy_rules (tenant_id, action, effect, conditions, priority)
VALUES (NULL, 'send_sms_confirmation', 'allow', '{"channel":"sms"}', 10)
ON CONFLICT DO NOTHING;
