// ============================================================
// BookingStore Interface — Abstraction over appointment persistence
//
// Implementations:
//   PostgresBookingStore  — default (wraps appointmentRepo)
//   ExcelSyncAdapter      — Hybrid decorator: Postgres + Excel mirror
// ============================================================

import type { Appointment, AppointmentStatus } from './types.js';

/**
 * Data required to create a new appointment.
 * Mirrors the INSERT columns without auto-generated fields.
 */
export interface AppointmentCreateData {
  tenant_id: string;
  client_name: string;
  client_email: string;
  client_notes?: string;
  client_phone?: string;
  service?: string;
  start_time: Date;
  end_time: Date;
  timezone: string;
  google_event_id?: string;
  source_hold_id?: string;
}

/**
 * Opaque transaction client. In Postgres this is pg.PoolClient.
 * Other implementations may ignore it (or pass it through).
 */
export type TransactionClient = any;

/**
 * Abstract interface for appointment persistence.
 *
 * All reads return domain `Appointment` objects.
 * All writes accept an optional `TransactionClient` so callers
 * can compose multiple operations inside a single SERIALIZABLE transaction.
 */
export interface BookingStore {
  // ── Reads ──────────────────────────────────────────────────
  findById(id: string, tenantId: string, txClient?: TransactionClient): Promise<Appointment | null>;
  findByReference(referenceCode: string, tenantId: string): Promise<Appointment | null>;
  findByEmail(email: string, tenantId: string): Promise<Appointment[]>;
  findBySourceHold(holdId: string, txClient?: TransactionClient): Promise<Appointment | null>;
  listByTenantAndRange(tenantId: string, start: Date, end: Date): Promise<Appointment[]>;
  listByTenant(tenantId: string, limit?: number, offset?: number): Promise<Appointment[]>;

  // ── Writes ─────────────────────────────────────────────────
  create(data: AppointmentCreateData, txClient?: TransactionClient): Promise<Appointment>;
  updateStatus(id: string, tenantId: string, status: AppointmentStatus, txClient?: TransactionClient): Promise<Appointment | null>;
  updateGoogleEventId(id: string, googleEventId: string): Promise<void>;
}

/**
 * Sync event types emitted by ExcelSyncAdapter for the sync worker.
 */
export interface SyncEvent {
  type: 'booking.created' | 'booking.statusChanged';
  tenantId: string;
  appointment: Appointment;
  timestamp: string; // ISO-8601
}

/**
 * Excel integration configuration stored in tenant.excel_integration JSONB.
 */
export interface ExcelIntegrationConfig {
  enabled: boolean;
  /** For local dev: path to the .xlsx file */
  file_path?: string;
  /** For OneDrive/SharePoint: Graph API drive ID */
  drive_id?: string;
  /** For OneDrive/SharePoint: Graph API file ID */
  file_id?: string;
  /** Worksheet name (default: "Appointments") */
  sheet_name?: string;
  /** Last known ETag for change detection */
  last_etag?: string;
  /** Last reconciliation timestamp */
  last_reconciliation_at?: string;
  /** Sync interval in seconds (default: 30) */
  sync_interval_seconds?: number;
  /** Graph API auth tokens (future — OneDrive/SharePoint) */
  auth_tokens?: {
    access_token: string;
    refresh_token: string;
    expires_at: string;
  };
}
