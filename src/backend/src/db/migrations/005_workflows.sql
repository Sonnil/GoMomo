-- ============================================================
-- AI Receptionist — Workflows Migration
-- Version: 005
-- Description: Waitlist entries table for Workflow B.
--              Other workflows (A, C, D) reuse existing jobs +
--              notification_outbox tables from migration 004.
-- ============================================================

-- ============================================================
-- WAITLIST ENTRIES
-- When no availability matches a user's request, they can be
-- added to a waitlist. When a slot opens (cancellation/reschedule),
-- the orchestrator scans for matching waitlist entries and notifies.
-- ============================================================
CREATE TABLE waitlist_entries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    session_id      TEXT,                                       -- chat session that created the entry
    client_name     TEXT NOT NULL,
    client_email    TEXT NOT NULL,
    preferred_service TEXT,                                     -- NULL = any service
    preferred_days  JSONB DEFAULT '[]'::jsonb,                 -- e.g. ["monday","wednesday"]
    preferred_time_range JSONB DEFAULT '{}'::jsonb,            -- e.g. {"start":"09:00","end":"12:00"}
    status          TEXT NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'notified', 'booked', 'expired', 'cancelled')),
    notified_at     TIMESTAMPTZ,                               -- when last notification was sent
    matched_slot    JSONB,                                     -- slot that matched (for audit)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_waitlist_tenant ON waitlist_entries(tenant_id);
CREATE INDEX idx_waitlist_status ON waitlist_entries(status) WHERE status = 'waiting';
CREATE INDEX idx_waitlist_email ON waitlist_entries(client_email);

CREATE TRIGGER set_updated_at_waitlist
    BEFORE UPDATE ON waitlist_entries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
