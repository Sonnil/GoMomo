// ============================================================
// ExcelSyncWorker — Outbound sync: DB → Excel
//
// Listens for sync events emitted by ExcelSyncAdapter.
// Pushes appointment data to the Excel file (local for MVP).
// Handles retries and dead-letter queue for failures.
// ============================================================

import { EventEmitter } from 'node:events';
import { query } from '../db/client.js';
import type { SyncEvent, ExcelIntegrationConfig } from '../domain/interfaces.js';
import type { Appointment } from '../domain/types.js';
import {
  appointmentToExcelRow,
  upsertExcelRow,
} from './excel-file-ops.js';

// ── Sync event bus ──────────────────────────────────────────────

/**
 * In-process event emitter for sync events.
 * ExcelSyncAdapter emits → ExcelSyncWorker consumes.
 */
export const syncEmitter = new EventEmitter();

// Prevent memory leak warnings for tenants with many concurrent syncs
syncEmitter.setMaxListeners(50);

// ── Constants ───────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2000, 8000, 30000]; // Exponential backoff

// ── Worker state ────────────────────────────────────────────────

let isRunning = false;

/**
 * Start the sync worker. Subscribes to sync events and processes them.
 * Safe to call multiple times — idempotent.
 */
export function startSyncWorker(): void {
  if (isRunning) return;
  isRunning = true;

  syncEmitter.on('sync', async (event: SyncEvent) => {
    try {
      await processSyncEvent(event);
    } catch (err) {
      console.error('[excel-sync] Unhandled error processing sync event:', err);
    }
  });

  console.log('[excel-sync] Worker started — listening for sync events');
}

/**
 * Stop the sync worker. Removes all listeners.
 */
export function stopSyncWorker(): void {
  syncEmitter.removeAllListeners('sync');
  isRunning = false;
  console.log('[excel-sync] Worker stopped');
}

// ── Core processing ─────────────────────────────────────────────

/**
 * Process a single sync event. Looks up the tenant's Excel config
 * and pushes the appointment data to the Excel file.
 */
async function processSyncEvent(event: SyncEvent): Promise<void> {
  const { tenantId, appointment } = event;

  // 1. Get tenant's Excel config
  const config = await getTenantExcelConfig(tenantId);
  if (!config?.enabled || !config.file_path) {
    // Excel not configured for this tenant — skip silently
    return;
  }

  // 2. Attempt sync with retries
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      await syncAppointmentToExcel(appointment, config);

      // Mark as synced in DB
      await markSynced(appointment.id);

      console.log(
        `[excel-sync] ✓ Synced ${appointment.reference_code} to Excel (attempt ${attempt + 1})`,
      );
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[excel-sync] Attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS} failed for ${appointment.reference_code}:`,
        lastError.message,
      );

      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_DELAYS_MS[attempt] ?? 30000);
      }
    }
  }

  // All retries exhausted — dead letter
  await insertDeadLetter(
    tenantId,
    appointment.id,
    event.type === 'booking.created' ? 'create' : 'update',
    lastError?.message ?? 'Unknown error',
    appointment,
  );

  // Mark as failed in DB
  await markSyncFailed(appointment.id);

  console.error(
    `[excel-sync] ✗ Failed to sync ${appointment.reference_code} after ${MAX_RETRY_ATTEMPTS} attempts — added to dead letter`,
  );
}

/**
 * Write a single appointment to the Excel file.
 */
async function syncAppointmentToExcel(
  appointment: Appointment,
  config: ExcelIntegrationConfig,
): Promise<void> {
  if (!config.file_path) {
    throw new Error('Excel file path not configured');
  }

  // Get sync_version from DB (may have been incremented by trigger)
  const syncVersion = await getSyncVersion(appointment.id);

  const excelRow = appointmentToExcelRow(appointment, syncVersion, 'ai-bot');
  const rowNumber = await upsertExcelRow(
    config.file_path,
    excelRow,
    config.sheet_name ?? 'Appointments',
  );

  // Store the Excel row reference back in DB
  await updateExcelRowRef(appointment.id, String(rowNumber));
}

// ── Database helpers ────────────────────────────────────────────

async function getTenantExcelConfig(
  tenantId: string,
): Promise<ExcelIntegrationConfig | null> {
  const { rows } = await query(
    'SELECT excel_integration FROM tenants WHERE id = $1',
    [tenantId],
  );
  if (!rows[0]?.excel_integration) return null;
  return rows[0].excel_integration as ExcelIntegrationConfig;
}

async function getSyncVersion(appointmentId: string): Promise<number> {
  const { rows } = await query(
    'SELECT sync_version FROM appointments WHERE id = $1',
    [appointmentId],
  );
  return rows[0]?.sync_version ?? 1;
}

async function markSynced(appointmentId: string): Promise<void> {
  await query(
    `UPDATE appointments
     SET sync_status = 'synced', last_synced_at = NOW()
     WHERE id = $1`,
    [appointmentId],
  );
}

async function markSyncFailed(appointmentId: string): Promise<void> {
  await query(
    `UPDATE appointments SET sync_status = 'failed' WHERE id = $1`,
    [appointmentId],
  );
}

async function updateExcelRowRef(
  appointmentId: string,
  rowRef: string,
): Promise<void> {
  await query(
    'UPDATE appointments SET excel_row_ref = $1 WHERE id = $2',
    [rowRef, appointmentId],
  );
}

async function insertDeadLetter(
  tenantId: string,
  appointmentId: string,
  operation: string,
  errorMessage: string,
  appointment: Appointment,
): Promise<void> {
  await query(
    `INSERT INTO sync_dead_letter
     (tenant_id, appointment_id, operation, error_message, payload, attempts, last_failed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT DO NOTHING`,
    [
      tenantId,
      appointmentId,
      operation,
      errorMessage,
      JSON.stringify(appointmentToExcelRow(appointment)),
      MAX_RETRY_ATTEMPTS,
    ],
  );
}

// ── Utility ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
