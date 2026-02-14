-- ============================================================
-- AI Receptionist — Database Schema Migration
-- Version: 001
-- Description: Initial schema — tenants, appointments, holds, audit
-- Requires: PostgreSQL 16+ with btree_gist extension
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ============================================================
-- TENANTS
-- ============================================================
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    timezone        TEXT NOT NULL DEFAULT 'America/New_York',  -- IANA timezone
    slot_duration   INTEGER NOT NULL DEFAULT 30,               -- minutes
    business_hours  JSONB NOT NULL DEFAULT '{
        "monday":    {"start": "09:00", "end": "17:00"},
        "tuesday":   {"start": "09:00", "end": "17:00"},
        "wednesday": {"start": "09:00", "end": "17:00"},
        "thursday":  {"start": "09:00", "end": "17:00"},
        "friday":    {"start": "09:00", "end": "17:00"},
        "saturday":  null,
        "sunday":    null
    }'::jsonb,
    services        JSONB NOT NULL DEFAULT '[]'::jsonb,        -- [{name, duration, description}]
    google_calendar_id TEXT,
    google_oauth_tokens JSONB,                                  -- encrypted at app layer
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug ON tenants(slug);

-- ============================================================
-- APPOINTMENTS
-- ============================================================
CREATE TABLE appointments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    reference_code  TEXT NOT NULL UNIQUE,                       -- human-readable e.g. APT-XXXX
    client_name     TEXT NOT NULL,
    client_email    TEXT NOT NULL,
    client_notes    TEXT,
    service         TEXT,
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ NOT NULL,
    timezone        TEXT NOT NULL,                              -- IANA timezone for display
    status          TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
    google_event_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- CRITICAL: Prevent overlapping appointments for the same tenant
    -- Only applies to non-cancelled appointments
    CONSTRAINT no_overlapping_appointments
        EXCLUDE USING gist (
            tenant_id WITH =,
            tstzrange(start_time, end_time) WITH &&
        ) WHERE (status != 'cancelled')
);

CREATE INDEX idx_appointments_tenant ON appointments(tenant_id);
CREATE INDEX idx_appointments_tenant_time ON appointments(tenant_id, start_time, end_time);
CREATE INDEX idx_appointments_email ON appointments(client_email);
CREATE INDEX idx_appointments_reference ON appointments(reference_code);

-- ============================================================
-- AVAILABILITY HOLDS
-- ============================================================
CREATE TABLE availability_holds (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    session_id      TEXT NOT NULL,                              -- chat session that placed the hold
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,                      -- TTL expiration
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- CRITICAL: Prevent overlapping holds for the same tenant
    CONSTRAINT no_overlapping_holds
        EXCLUDE USING gist (
            tenant_id WITH =,
            tstzrange(start_time, end_time) WITH &&
        )
);

CREATE INDEX idx_holds_tenant ON availability_holds(tenant_id);
CREATE INDEX idx_holds_expires ON availability_holds(expires_at);
CREATE INDEX idx_holds_session ON availability_holds(session_id);

-- ============================================================
-- CHAT SESSIONS
-- ============================================================
CREATE TABLE chat_sessions (
    id              TEXT PRIMARY KEY,                           -- socket/session ID
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    conversation    JSONB NOT NULL DEFAULT '[]'::jsonb,         -- message history
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_tenant ON chat_sessions(tenant_id);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID REFERENCES tenants(id),
    event_type      TEXT NOT NULL,                              -- e.g. 'appointment.booked', 'hold.created'
    entity_type     TEXT NOT NULL,                              -- e.g. 'appointment', 'hold'
    entity_id       TEXT,
    actor           TEXT NOT NULL DEFAULT 'system',             -- 'system', 'ai_agent', 'user', 'admin'
    payload         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_tenant ON audit_log(tenant_id);
CREATE INDEX idx_audit_event ON audit_log(event_type);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ============================================================
-- Updated-at trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_tenants
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at_appointments
    BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at_sessions
    BEFORE UPDATE ON chat_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
