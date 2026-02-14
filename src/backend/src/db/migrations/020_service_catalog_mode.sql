-- Migration 020: Service catalog mode
-- Adds a tenant-level setting controlling how the AI agent handles service selection.
--
-- Modes:
--   'catalog_only' (default) — Agent only accepts services from the tenant's service list.
--   'free_text'              — Agent accepts ANY service description the customer provides.
--   'hybrid'                 — Agent shows the catalog but also accepts free-text services.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS service_catalog_mode TEXT NOT NULL DEFAULT 'catalog_only';
