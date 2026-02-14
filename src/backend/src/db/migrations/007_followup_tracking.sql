-- ============================================================
-- AI Receptionist — Follow-Up Tracking Migration
-- Version: 007
-- Description: Tracks follow-up contacts per session for
--              rate-limiting and cooldown enforcement.
-- ============================================================

CREATE TABLE followup_contacts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    session_id      TEXT NOT NULL,
    client_email    TEXT NOT NULL,
    client_phone    TEXT,
    channel         TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
    reason          TEXT,
    job_id          UUID REFERENCES jobs(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup: how many follow-ups in this session?
CREATE INDEX idx_followup_contacts_session
  ON followup_contacts (session_id);

-- Fast lookup: recent follow-ups to a recipient (for cooldown)
CREATE INDEX idx_followup_contacts_recipient
  ON followup_contacts (client_email, created_at DESC);

-- Tenant scoping
CREATE INDEX idx_followup_contacts_tenant
  ON followup_contacts (tenant_id);
