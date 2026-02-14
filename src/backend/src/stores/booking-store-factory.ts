// ============================================================
// BookingStore Factory — Resolves the correct store per tenant
//
// If the tenant has Excel integration enabled → ExcelSyncAdapter
// Otherwise → PostgresBookingStore (default, zero overhead)
//
// Feature flags:
//   1. Global: EXCEL_ENABLED env var (kill switch)
//   2. Per-tenant: tenant.excel_integration.enabled
//   Both must be true for Excel sync to activate.
// ============================================================

import type { BookingStore, ExcelIntegrationConfig } from '../domain/interfaces.js';
import { PostgresBookingStore } from './postgres-booking-store.js';
import { ExcelSyncAdapter } from './excel-sync-adapter.js';
import { env } from '../config/env.js';

// ── Singleton instances ─────────────────────────────────────────

/**
 * Single shared PostgresBookingStore instance.
 * Stateless, so safe to share across tenants.
 */
const defaultStore = new PostgresBookingStore();

/**
 * Cache of ExcelSyncAdapter instances per tenant.
 * The adapter holds a tenant ID, so we need one per tenant.
 */
const adapterCache = new Map<string, ExcelSyncAdapter>();

// ── Factory function ────────────────────────────────────────────

/**
 * Get the appropriate BookingStore for a tenant.
 *
 * @param tenantId - The tenant UUID
 * @param excelConfig - The tenant's Excel integration config (from tenant record).
 *                      Pass null/undefined if not fetched yet — we'll use default store.
 * @returns BookingStore — either PostgresBookingStore or ExcelSyncAdapter
 */
export function getBookingStore(
  tenantId: string,
  excelConfig?: ExcelIntegrationConfig | null,
): BookingStore {
  // Global kill switch
  if (env.EXCEL_ENABLED !== 'true') {
    return defaultStore;
  }

  // Per-tenant check
  if (!excelConfig?.enabled) {
    return defaultStore;
  }

  // Return cached adapter or create new one
  let adapter = adapterCache.get(tenantId);
  if (!adapter) {
    adapter = new ExcelSyncAdapter(defaultStore, tenantId);
    adapterCache.set(tenantId, adapter);
  }

  return adapter;
}

/**
 * Get the default PostgresBookingStore (no Excel sync).
 * Used when caller knows Excel is not needed (e.g., internal operations).
 */
export function getDefaultStore(): BookingStore {
  return defaultStore;
}

/**
 * Clear the adapter cache. Used for testing or when tenant config changes.
 */
export function clearAdapterCache(): void {
  adapterCache.clear();
}
