-- ============================================================
-- Migration 022: Rebrand default tenant to Gomomo
--
-- Idempotent: uses WHERE clause to only update rows that still
-- carry old branding (gomomo Demo Clinic, Demo Clinic, etc.).
-- Safe to run multiple times — no-op after first application.
-- ============================================================

-- Rename canonical tenant (00000000-...-000000000001) to Gomomo
UPDATE tenants
   SET name = 'Gomomo',
       slug = 'gomomo'
 WHERE id = '00000000-0000-4000-a000-000000000001'
   AND (name != 'Gomomo' OR slug != 'gomomo');

-- Clean up any secondary "Demo Clinic" / "demo-clinic" tenant
-- that the old seed may have created (optional row — may not exist)
DELETE FROM tenants
 WHERE slug = 'demo-clinic'
   AND id != '00000000-0000-4000-a000-000000000001';
