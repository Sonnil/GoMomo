// ============================================================
// Excel Adapter — Integration Tests (Vitest)
//
// Tests:
//   1. Template creation
//   2. Row upsert (single + batch)
//   3. Row read-back
//   4. ExcelSyncAdapter decorator pattern
//   5. Concurrency simulation (parallel writes)
//   6. Reconciliation (detect missing rows)
//   7. File created on demand
//
// Does NOT require a running Postgres DB — tests file operations
// and adapter patterns in isolation.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Appointment, AppointmentStatus } from '../src/domain/types.js';
import type { BookingStore, AppointmentCreateData, SyncEvent, TransactionClient } from '../src/domain/interfaces.js';
import {
  createExcelTemplate,
  readExcelRows,
  upsertExcelRow,
  batchUpsertExcelRows,
  appointmentToExcelRow,
  getExcelRowCount,
} from '../src/integrations/excel-file-ops.js';
import { ExcelSyncAdapter } from '../src/stores/excel-sync-adapter.js';

// ── Shared helpers ──────────────────────────────────────────────

const TEST_DIR = path.resolve(import.meta.dirname, '..', 'data', 'test-excel');

function makeAppointment(overrides: Partial<Appointment> = {}): Appointment {
  const now = new Date();
  return {
    id: uuid(),
    tenant_id: 'test-tenant-001',
    reference_code: `APT-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
    client_name: 'Test Client',
    client_email: 'test@example.com',
    client_phone: null,
    client_notes: null,
    service: 'Deep Tissue Massage',
    start_time: new Date(now.getTime() + 86400000),
    end_time: new Date(now.getTime() + 86400000 + 3600000),
    timezone: 'America/New_York',
    status: 'confirmed' as AppointmentStatus,
    google_event_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ── Mock BookingStore for ExcelSyncAdapter tests ────────────────

class MockBookingStore implements BookingStore {
  private appointments = new Map<string, Appointment>();

  async findById(id: string, _tenantId: string, _txClient?: TransactionClient): Promise<Appointment | null> {
    return this.appointments.get(id) ?? null;
  }
  async findByReference(ref: string, _tenantId: string): Promise<Appointment | null> {
    return [...this.appointments.values()].find((a) => a.reference_code === ref) ?? null;
  }
  async findByEmail(email: string, _tenantId: string): Promise<Appointment[]> {
    return [...this.appointments.values()].filter((a) => a.client_email === email);
  }
  async findBySourceHold(_holdId: string, _txClient?: TransactionClient): Promise<Appointment | null> {
    return null;
  }
  async listByTenantAndRange(_tenantId: string, _start: Date, _end: Date): Promise<Appointment[]> {
    return [...this.appointments.values()];
  }
  async listByTenant(_tenantId: string, _limit?: number, _offset?: number): Promise<Appointment[]> {
    return [...this.appointments.values()];
  }
  async create(data: AppointmentCreateData, _txClient?: TransactionClient): Promise<Appointment> {
    const apt = makeAppointment({
      tenant_id: data.tenant_id,
      client_name: data.client_name,
      client_email: data.client_email,
      service: data.service ?? null,
      start_time: data.start_time,
      end_time: data.end_time,
    });
    this.appointments.set(apt.id, apt);
    return apt;
  }
  async updateStatus(id: string, _tenantId: string, status: AppointmentStatus, _txClient?: TransactionClient): Promise<Appointment | null> {
    const apt = this.appointments.get(id);
    if (!apt) return null;
    apt.status = status;
    apt.updated_at = new Date();
    return apt;
  }
  async updateGoogleEventId(id: string, eventId: string): Promise<void> {
    const apt = this.appointments.get(id);
    if (apt) apt.google_event_id = eventId;
  }
}

// ── Suite ────────────────────────────────────────────────────────

describe('Excel Adapter', () => {
  beforeAll(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  // ── 1. Template creation ────────────────────────────────────

  describe('Template creation', () => {
    it('creates an xlsx file with no data rows', async () => {
      const filePath = path.join(TEST_DIR, 'test-template.xlsx');
      await createExcelTemplate(filePath);

      expect(fs.existsSync(filePath)).toBe(true);

      const rows = await readExcelRows(filePath);
      expect(rows.length).toBe(0);

      const rowCount = await getExcelRowCount(filePath);
      expect(rowCount).toBe(0);
    });
  });

  // ── 2. Single row upsert ───────────────────────────────────

  describe('Single row upsert', () => {
    const filePath = path.join(TEST_DIR, 'test-single-upsert.xlsx');
    let apt: Appointment;

    beforeAll(async () => {
      await createExcelTemplate(filePath);
      apt = makeAppointment();
    });

    it('inserts a row after the header', async () => {
      const excelRow = appointmentToExcelRow(apt, 1, 'ai-bot');
      const rowNum = await upsertExcelRow(filePath, excelRow);
      expect(rowNum).toBeGreaterThan(1);
    });

    it('reads back matching data', async () => {
      const rows = await readExcelRows(filePath);
      expect(rows.length).toBe(1);
      expect(rows[0].db_id).toBe(apt.id);
      expect(rows[0].appt_id).toBe(apt.reference_code);
      expect(rows[0].client_name).toBe(apt.client_name);
      expect(rows[0].status).toBe('confirmed');
    });

    it('upsert overwrites the same row on update', async () => {
      const excelRow = appointmentToExcelRow(apt, 1, 'ai-bot');
      const updatedRow = { ...excelRow, status: 'cancelled', ver: 2 };
      await upsertExcelRow(filePath, updatedRow);

      const rows = await readExcelRows(filePath);
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('cancelled');
      expect(rows[0].ver).toBe(2);
    });
  });

  // ── 3. Batch upsert ────────────────────────────────────────

  describe('Batch upsert', () => {
    const filePath = path.join(TEST_DIR, 'test-batch-upsert.xlsx');
    let appointments: Appointment[];
    let excelRows: ReturnType<typeof appointmentToExcelRow>[];

    beforeAll(async () => {
      await createExcelTemplate(filePath);
      appointments = Array.from({ length: 5 }, (_, i) =>
        makeAppointment({
          client_name: `Client ${i + 1}`,
          client_email: `client${i + 1}@test.com`,
          service: i % 2 === 0 ? 'Facial Treatment' : 'Deep Tissue Massage',
        }),
      );
      excelRows = appointments.map((apt, i) =>
        appointmentToExcelRow(apt, 1, i < 3 ? 'ai-bot' : 'admin'),
      );
    });

    it('inserts all 5 rows', async () => {
      const resultMap = await batchUpsertExcelRows(filePath, excelRows);
      expect(resultMap.size).toBe(5);

      const rows = await readExcelRows(filePath);
      expect(rows.length).toBe(5);

      const count = await getExcelRowCount(filePath);
      expect(count).toBe(5);
    });

    it('updates 2 rows and adds 1 new in a single batch', async () => {
      const newApt = makeAppointment({ client_name: 'New Client 6' });
      const updatedRows = [
        { ...excelRows[0], status: 'cancelled', ver: 2 },
        { ...excelRows[2], client_name: 'Updated Client 3', ver: 2 },
        appointmentToExcelRow(newApt, 1, 'admin'),
      ];

      const result2 = await batchUpsertExcelRows(filePath, updatedRows);
      expect(result2.size).toBe(3);

      const finalRows = await readExcelRows(filePath);
      expect(finalRows.length).toBe(6);

      const cancelledRow = finalRows.find((r) => r.db_id === appointments[0].id);
      expect(cancelledRow?.status).toBe('cancelled');
    });
  });

  // ── 4. ExcelSyncAdapter decorator ──────────────────────────

  describe('ExcelSyncAdapter decorator', () => {
    it('emits sync events on create and updateStatus', async () => {
      const mockStore = new MockBookingStore();
      const adapter = new ExcelSyncAdapter(mockStore, 'test-tenant-001');

      const { syncEmitter } = await import('../src/integrations/excel-sync-worker.js');
      const events: SyncEvent[] = [];
      const listener = (event: SyncEvent) => events.push(event);
      syncEmitter.on('sync', listener);

      try {
        // create
        const apt = await adapter.create({
          tenant_id: 'test-tenant-001',
          client_name: 'Adapter Test',
          client_email: 'adapter@test.com',
          start_time: new Date(),
          end_time: new Date(Date.now() + 3600000),
          timezone: 'America/New_York',
        });

        expect(apt).not.toBeNull();
        expect(apt.client_name).toBe('Adapter Test');

        await new Promise((r) => setImmediate(r));
        expect(events.length).toBe(1);
        expect(events[0].type).toBe('booking.created');
        expect(events[0].tenantId).toBe('test-tenant-001');

        // updateStatus
        const updated = await adapter.updateStatus(apt.id, 'test-tenant-001', 'cancelled');
        expect(updated).not.toBeNull();
        expect(updated?.status).toBe('cancelled');

        await new Promise((r) => setImmediate(r));
        expect(events.length).toBe(2);
        expect(events[1].type).toBe('booking.statusChanged');
      } finally {
        syncEmitter.off('sync', listener);
      }
    });

    it('does not emit events for read operations', async () => {
      const mockStore = new MockBookingStore();
      const adapter = new ExcelSyncAdapter(mockStore, 'test-tenant-001');

      const { syncEmitter } = await import('../src/integrations/excel-sync-worker.js');
      const events: SyncEvent[] = [];
      const listener = (event: SyncEvent) => events.push(event);
      syncEmitter.on('sync', listener);

      try {
        // Create one so reads have something to find
        const apt = await adapter.create({
          tenant_id: 'test-tenant-001',
          client_name: 'Read Test',
          client_email: 'read@test.com',
          start_time: new Date(),
          end_time: new Date(Date.now() + 3600000),
          timezone: 'America/New_York',
        });
        await new Promise((r) => setImmediate(r));
        const createCount = events.length;

        // Reads
        await adapter.findById(apt.id, 'test-tenant-001');
        await adapter.findByEmail('read@test.com', 'test-tenant-001');
        await adapter.listByTenant('test-tenant-001');
        await adapter.updateGoogleEventId(apt.id, 'gcal-event-123');

        await new Promise((r) => setImmediate(r));
        expect(events.length).toBe(createCount); // no new events
      } finally {
        syncEmitter.off('sync', listener);
      }
    });
  });

  // ── 5. Concurrent writes simulation ────────────────────────

  describe('Concurrent writes', () => {
    const filePath = path.join(TEST_DIR, 'test-concurrent.xlsx');
    let appointments: Appointment[];

    beforeAll(async () => {
      await createExcelTemplate(filePath);
      appointments = Array.from({ length: 10 }, (_, i) =>
        makeAppointment({
          client_name: `Concurrent Client ${i + 1}`,
          client_email: `concurrent${i + 1}@test.com`,
        }),
      );
    });

    it('writes 10 sequential rows without data loss', async () => {
      for (const apt of appointments) {
        const excelRow = appointmentToExcelRow(apt, 1, 'ai-bot');
        await upsertExcelRow(filePath, excelRow);
      }

      const rows = await readExcelRows(filePath);
      expect(rows.length).toBe(10);

      const ids = new Set(rows.map((r) => r.db_id));
      expect(ids.size).toBe(10);
    });

    it('last writer wins on version conflict', async () => {
      const apt1 = appointments[0];
      const v1 = appointmentToExcelRow(apt1, 2, 'ai-bot');
      const v2 = appointmentToExcelRow(apt1, 3, 'ai-bot');
      v2.status = 'cancelled';

      await upsertExcelRow(filePath, v1);
      await upsertExcelRow(filePath, v2);

      const finalRows = await readExcelRows(filePath);
      expect(finalRows.length).toBe(10);

      const updatedRow = finalRows.find((r) => r.db_id === apt1.id);
      expect(updatedRow?.status).toBe('cancelled');
      expect(updatedRow?.ver).toBe(3);
    });
  });

  // ── 6. Reconciliation detection ────────────────────────────

  describe('Reconciliation detection', () => {
    it('detects and fills missing rows', async () => {
      const filePath = path.join(TEST_DIR, 'test-reconciliation.xlsx');
      await createExcelTemplate(filePath);

      // Write 3 appointments
      const appointments = Array.from({ length: 3 }, (_, i) =>
        makeAppointment({ client_name: `Recon Client ${i + 1}` }),
      );
      const excelRows = appointments.map((apt) => appointmentToExcelRow(apt, 1, 'ai-bot'));
      await batchUpsertExcelRows(filePath, excelRows);

      const excelData = await readExcelRows(filePath);
      expect(excelData.length).toBe(3);

      // Simulate 2 DB appointments missing from Excel
      const dbAppointments = [
        ...appointments,
        makeAppointment({ client_name: 'Missing Client 4' }),
        makeAppointment({ client_name: 'Missing Client 5' }),
      ];

      const excelDbIds = new Set(excelData.map((r) => r.db_id));
      const missingFromExcel = dbAppointments.filter((apt) => !excelDbIds.has(apt.id));
      expect(missingFromExcel.length).toBe(2);

      // Push missing rows
      const missingRows = missingFromExcel.map((apt) => appointmentToExcelRow(apt, 1, 'ai-bot'));
      await batchUpsertExcelRows(filePath, missingRows);

      const finalRows = await readExcelRows(filePath);
      expect(finalRows.length).toBe(5);
    });
  });

  // ── 7. File created on demand ──────────────────────────────

  describe('File created on demand', () => {
    it('auto-creates xlsx file on first upsert', async () => {
      const filePath = path.join(TEST_DIR, 'test-on-demand.xlsx');
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      expect(fs.existsSync(filePath)).toBe(false);

      const apt = makeAppointment({ client_name: 'On Demand Client' });
      const excelRow = appointmentToExcelRow(apt, 1, 'ai-bot');
      await upsertExcelRow(filePath, excelRow);

      expect(fs.existsSync(filePath)).toBe(true);

      const rows = await readExcelRows(filePath);
      expect(rows.length).toBe(1);
      expect(rows[0].client_name).toBe('On Demand Client');
    });
  });
});
