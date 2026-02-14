-- ============================================================
-- Migration 006: Push Events (Feature 3 — Proactive UI Push)
--
-- Stores proactive push events (waitlist matches, calendar retry
-- confirmations) for delivery to active chat sessions via
-- WebSocket, with REST polling fallback.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_events (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    session_id  TEXT NOT NULL,                           -- chat session to deliver to
    type        TEXT NOT NULL CHECK (type IN ('waitlist_match', 'calendar_retry_success')),
    payload     JSONB NOT NULL DEFAULT '{}',             -- typed payload (slots, booking details)
    delivered   BOOLEAN NOT NULL DEFAULT FALSE,          -- true once WS delivery confirmed
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup: pending events for a session (REST polling fallback)
CREATE INDEX idx_push_events_session_pending
    ON push_events (session_id, delivered)
    WHERE delivered = FALSE;

-- Tenant scoping
CREATE INDEX idx_push_events_tenant
    ON push_events (tenant_id);

-- Cooldown check: recent pushes per session+type (prevent spam)
CREATE INDEX idx_push_events_cooldown
    ON push_events (session_id, type, created_at DESC);
