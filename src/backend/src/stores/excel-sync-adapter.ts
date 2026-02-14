// ============================================================
// ExcelSyncAdapter — Decorator over PostgresBookingStore
//
// All reads delegate to the inner store (Postgres).
// All writes delegate to Postgres first, then emit a sync event
// so the ExcelSyncWorker can push the change to Excel.
//
// Key principle: Excel is NEVER consulted during reads or writes.
// It's an async, best-effort mirror.
// ============================================================

import type { Appointment, AppointmentStatus } from '../domain/types.js';
import type {
  BookingStore,
  AppointmentCreateData,
  TransactionClient,
  SyncEvent,
} from '../domain/interfaces.js';
import { syncEmitter } from '../integrations/excel-sync-worker.js';

export class ExcelSyncAdapter implements BookingStore {
  private inner: BookingStore;
  private tenantId: string;

  constructor(inner: BookingStore, tenantId: string) {
    this.inner = inner;
    this.tenantId = tenantId;
  }

  // ── Reads — Pure delegation, zero Excel involvement ─────────

  async findById(
    id: string,
    tenantId: string,
    txClient?: TransactionClient,
  ): Promise<Appointment | null> {
    return this.inner.findById(id, tenantId, txClient);
  }

  async findByReference(
    referenceCode: string,
    tenantId: string,
  ): Promise<Appointment | null> {
    return this.inner.findByReference(referenceCode, tenantId);
  }

  async findByEmail(email: string, tenantId: string): Promise<Appointment[]> {
    return this.inner.findByEmail(email, tenantId);
  }

  async findBySourceHold(
    holdId: string,
    txClient?: TransactionClient,
  ): Promise<Appointment | null> {
    return this.inner.findBySourceHold(holdId, txClient);
  }

  async listByTenantAndRange(
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<Appointment[]> {
    return this.inner.listByTenantAndRange(tenantId, start, end);
  }

  async listByTenant(
    tenantId: string,
    limit?: number,
    offset?: number,
  ): Promise<Appointment[]> {
    return this.inner.listByTenant(tenantId, limit, offset);
  }

  // ── Writes — Delegate to Postgres, then emit sync event ─────

  async create(
    data: AppointmentCreateData,
    txClient?: TransactionClient,
  ): Promise<Appointment> {
    // 1. Postgres write (SERIALIZABLE + EXCLUDE constraint still apply)
    const appointment = await this.inner.create(data, txClient);

    // 2. Emit async sync event (non-blocking, fire-and-forget)
    this.emitSyncEvent('booking.created', appointment);

    return appointment;
  }

  async updateStatus(
    id: string,
    tenantId: string,
    status: AppointmentStatus,
    txClient?: TransactionClient,
  ): Promise<Appointment | null> {
    // 1. Postgres write
    const appointment = await this.inner.updateStatus(id, tenantId, status, txClient);

    // 2. Emit async sync event (only if update succeeded)
    if (appointment) {
      this.emitSyncEvent('booking.statusChanged', appointment);
    }

    return appointment;
  }

  async updateGoogleEventId(
    id: string,
    googleEventId: string,
  ): Promise<void> {
    // No sync needed — this is metadata, not visible in Excel
    return this.inner.updateGoogleEventId(id, googleEventId);
  }

  // ── Sync event emission ─────────────────────────────────────

  private emitSyncEvent(
    type: SyncEvent['type'],
    appointment: Appointment,
  ): void {
    const event: SyncEvent = {
      type,
      tenantId: this.tenantId,
      appointment,
      timestamp: new Date().toISOString(),
    };

    // Async emit — the worker processes this in the background.
    // We use setImmediate to avoid blocking the current call stack
    // (especially important when this runs inside a SERIALIZABLE transaction).
    setImmediate(() => {
      syncEmitter.emit('sync', event);
    });
  }
}
