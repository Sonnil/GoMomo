-- ============================================================
-- DEV-ONLY: Clean Bloom-Contaminated Chat Sessions
-- ============================================================
-- Run this ONCE against your LOCAL dev database to remove
-- chat sessions where the LLM hallucinated legacy brand names.
--
-- This prevents old session history from re-introducing the
-- "Bloom" token into conversation context on follow-up messages.
--
-- ⚠ DO NOT run this in production without review.
-- ============================================================

-- 1. Preview: count contaminated sessions
SELECT COUNT(*) AS contaminated_sessions
FROM chat_sessions
WHERE conversation::text ILIKE '%bloom%';

-- 2. Delete contaminated sessions (dev-only)
DELETE FROM chat_sessions
WHERE conversation::text ILIKE '%bloom%';

-- 3. Also clean any audit test sessions
DELETE FROM chat_sessions
WHERE id LIKE 'audit-%';

-- 4. Verify cleanup
SELECT COUNT(*) AS remaining_bloom_sessions
FROM chat_sessions
WHERE conversation::text ILIKE '%bloom%';
-- Expected: 0
