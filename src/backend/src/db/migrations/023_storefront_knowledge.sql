-- ============================================================
-- Migration 023: Storefront Knowledge System tables
-- ============================================================
-- Creates tables for the FAQ self-improvement loop:
--   1. unanswered_faqs — logs questions the agent couldn't answer
--   2. approved_faqs — human-approved answers for deterministic reuse
-- ============================================================

-- ── 1. Unanswered FAQs ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS unanswered_faqs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question      TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count         INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'proposed', 'approved', 'dismissed')),
  proposed_answer TEXT,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for status-based queries (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_unanswered_faqs_status
  ON unanswered_faqs (status);

-- Index for dedup lookups (lowercase question)
CREATE INDEX IF NOT EXISTS idx_unanswered_faqs_question
  ON unanswered_faqs (lower(question));

-- ── 2. Approved FAQs ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_faqs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  source_faq_id UUID REFERENCES unanswered_faqs(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for lookup by question text (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_approved_faqs_question
  ON approved_faqs (lower(question));
