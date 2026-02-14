// ============================================================
// PostgresBookingStore — BookingStore backed by appointmentRepo
//
// This is a 1:1 wrapper around the existing appointmentRepo,
// conforming to the BookingStore interface. Zero behavior change.
// ============================================================

import type { Appointment, AppointmentStatus } from '../domain/types.js';
import type { BookingStore, AppointmentCreateData, TransactionClient } from '../domain/interfaces.js';
import { appointmentRepo } from '../repos/appointment.repo.js';

export class PostgresBookingStore implements BookingStore {
  // ── Reads ──────────────────────────────────────────────────

  async findById(
    id: string,
    tenantId: string,
    txClient?: TransactionClient,
  ): Promise<Appointment | null> {
    return appointmentRepo.findById(id, tenantId, txClient);
  }

  async findByReference(
    referenceCode: string,
    tenantId: string,
  ): Promise<Appointment | null> {
    return appointmentRepo.findByReference(referenceCode, tenantId);
  }

  async findByEmail(email: string, tenantId: string): Promise<Appointment[]> {
    return appointmentRepo.findByEmail(email, tenantId);
  }

  async findBySourceHold(
    holdId: string,
    txClient?: TransactionClient,
  ): Promise<Appointment | null> {
    return appointmentRepo.findBySourceHold(holdId, txClient);
  }

  async listByTenantAndRange(
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<Appointment[]> {
    return appointmentRepo.listByTenantAndRange(tenantId, start, end);
  }

  async listByTenant(
    tenantId: string,
    limit?: number,
    offset?: number,
  ): Promise<Appointment[]> {
    return appointmentRepo.listByTenant(tenantId, limit, offset);
  }

  // ── Writes ─────────────────────────────────────────────────

  async create(
    data: AppointmentCreateData,
    txClient?: TransactionClient,
  ): Promise<Appointment> {
    return appointmentRepo.create(data, txClient);
  }

  async updateStatus(
    id: string,
    tenantId: string,
    status: AppointmentStatus,
    txClient?: TransactionClient,
  ): Promise<Appointment | null> {
    return appointmentRepo.updateStatus(id, tenantId, status, txClient);
  }

  async updateGoogleEventId(
    id: string,
    googleEventId: string,
  ): Promise<void> {
    return appointmentRepo.updateGoogleEventId(id, googleEventId);
  }
}
