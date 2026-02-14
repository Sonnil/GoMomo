-- ============================================================
-- AI Receptionist — Agent Runtime Migration
-- Version: 004
-- Description: Autonomous agent runtime tables — policy rules,
--              persistent job queue, notification outbox.
-- ============================================================

-- ============================================================
-- POLICY RULES
-- Defines what the autonomous agent is allowed to do.
-- Default: deny-all (no rule = denied).
-- ============================================================
CREATE TABLE policy_rules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID REFERENCES tenants(id),               -- NULL = global rule
    action          TEXT NOT NULL,                              -- e.g. 'send_confirmation', 'send_reminder'
    effect          TEXT NOT NULL DEFAULT 'deny'
                    CHECK (effect IN ('allow', 'deny')),
    conditions      JSONB NOT NULL DEFAULT '{}'::jsonb,        -- e.g. {"min_lead_time_minutes": 60}
    priority        INTEGER NOT NULL DEFAULT 0,                -- higher wins on conflict
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active rule per (tenant, action) pair at each priority level
CREATE UNIQUE INDEX idx_policy_rules_unique
  ON policy_rules (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'), action, priority)
  WHERE is_active = true;

CREATE INDEX idx_policy_rules_action ON policy_rules(action) WHERE is_active = true;
CREATE INDEX idx_policy_rules_tenant ON policy_rules(tenant_id) WHERE is_active = true;

CREATE TRIGGER set_updated_at_policy_rules
    BEFORE UPDATE ON policy_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- JOBS (persistent queue)
-- Orchestrator enqueues work here. Job Runner polls and executes.
-- ============================================================
CREATE TABLE jobs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    type            TEXT NOT NULL,                              -- e.g. 'send_confirmation_email', 'retry_calendar_sync'
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,        -- PII-redacted at write time
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled')),
    priority        INTEGER NOT NULL DEFAULT 0,                -- higher = more urgent
    run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),        -- scheduled execution time
    claimed_at      TIMESTAMPTZ,                               -- when a worker claimed it
    completed_at    TIMESTAMPTZ,                               -- when processing finished
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    last_error      TEXT,
    source_event    TEXT,                                       -- domain event that spawned this job
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup for claiming: pending jobs ordered by priority + run_at
CREATE INDEX idx_jobs_claimable
  ON jobs (run_at, priority DESC)
  WHERE status = 'pending';

-- Stale job recovery: find claimed jobs that may have timed out
CREATE INDEX idx_jobs_stale
  ON jobs (claimed_at)
  WHERE status = 'claimed';

CREATE INDEX idx_jobs_tenant ON jobs(tenant_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_type ON jobs(type);

-- ============================================================
-- NOTIFICATION OUTBOX
-- Records of all notifications sent by the agent.
-- Used for audit, deduplication, and retry.
-- ============================================================
CREATE TABLE notification_outbox (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    job_id          UUID REFERENCES jobs(id),                  -- source job (nullable for manual sends)
    channel         TEXT NOT NULL                               -- 'email', 'sms', 'webhook'
                    CHECK (channel IN ('email', 'sms', 'webhook')),
    recipient       TEXT NOT NULL,                              -- PII: redacted in audit logs
    subject         TEXT,
    body            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed')),
    sent_at         TIMESTAMPTZ,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_outbox_tenant ON notification_outbox(tenant_id);
CREATE INDEX idx_notification_outbox_job ON notification_outbox(job_id);
CREATE INDEX idx_notification_outbox_status ON notification_outbox(status) WHERE status = 'pending';

