-- Migration 021: Rebrand demo tenant from "Bloom Wellness Studio" to "gomomo Demo Clinic"
--
-- Root cause: the original seed created the demo tenant as "Bloom Wellness Studio".
-- The seed script uses INSERT-if-not-exists, so re-running seed never updated the
-- existing row.  This migration fixes the live DB row in-place.
--
-- Safe to re-run: the WHERE clause is narrow and idempotent.

UPDATE tenants
SET    name = 'gomomo Demo Clinic',
       slug = 'gomomo-demo'
WHERE  id   = '00000000-0000-4000-a000-000000000001'
  AND  (name = 'Bloom Wellness Studio' OR slug = 'bloom-wellness');
