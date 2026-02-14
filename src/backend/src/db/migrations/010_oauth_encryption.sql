-- ============================================================
-- Migration 010: OAuth token encryption at rest
--
-- Changes google_oauth_tokens from JSONB to TEXT to support
-- AES-256-GCM encrypted values. The app layer handles
-- encryption/decryption transparently.
--
-- Legacy unencrypted JSONB values are auto-detected and
-- handled during reads (migration-compatible).
-- ============================================================

-- Step 1: Convert existing JSONB data to TEXT (preserves JSON string)
ALTER TABLE tenants
  ALTER COLUMN google_oauth_tokens TYPE TEXT
  USING google_oauth_tokens::TEXT;

-- Step 2: Add a comment documenting the encryption
COMMENT ON COLUMN tenants.google_oauth_tokens IS
  'AES-256-GCM encrypted OAuth tokens (enc:v1:... format). Legacy plain JSON is auto-detected on read.';
