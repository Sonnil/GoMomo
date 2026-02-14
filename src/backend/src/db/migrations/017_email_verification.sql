-- ============================================================
-- Migration 017 — Email Verification + Lead Capture
--
-- Adds:
--   1. email_verifications table — OTP codes for email gating
--   2. newsletter_opt_in column on customers
--   3. email_verified_at column on customers
--   4. message_count column on chat_sessions (tracks user msgs per session)
-- ============================================================

-- ── Email Verification Codes ────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT NOT NULL,
    code            TEXT NOT NULL,               -- 6-digit OTP
    session_id      TEXT NOT NULL,               -- chat session requesting verification
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    attempts        INTEGER NOT NULL DEFAULT 0,  -- failed verification attempts
    verified_at     TIMESTAMPTZ,                 -- set when code is confirmed
    expires_at      TIMESTAMPTZ NOT NULL,        -- code expiry (10 min)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_email
    ON email_verifications(email, tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_session
    ON email_verifications(session_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_expires
    ON email_verifications(expires_at)
    WHERE verified_at IS NULL;

-- ── Customer extensions ─────────────────────────────────────
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS newsletter_opt_in BOOLEAN NOT NULL DEFAULT true;

-- ── Session message counter ─────────────────────────────────
ALTER TABLE chat_sessions
    ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
