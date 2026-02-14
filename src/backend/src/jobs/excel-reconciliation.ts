// ============================================================
// Excel Reconciliation Job — Detect and fix DB↔Excel drift
//
// MVP scope (outbound-only):
//   - Find DB appointments with sync_status != 'synced'
//   - Re-push them to Excel
//   - Retry dead-letter entries
//
// Future (Phase 2): Inbound reconciliation — detect admin edits
// in Excel and apply them to Postgres.
// ============================================================

import { query } from '../db/client.js';
import type { Appointment } from '../domain/types.js';
import type { ExcelIntegrationConfig } from '../domain/interfaces.js';
import {
  appointmentToExcelRow,
  batchUpsertExcelRows,
  readExcelRows,
  type ExcelRow,
} from '../integrations/excel-file-ops.js';

// ── Job state ───────────────────────────────────────────────────

let reconciliationTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the reconciliation job on a fixed interval.
 * @param intervalMs - Milliseconds between runs (default: 300000 = 5 min)
 */
export function startReconciliationJob(intervalMs = 300000): void {
  if (reconciliationTimer) return; // Already running

  // Run once immediately, then on interval
  runReconciliation().catch((err) =>
    console.error('[excel-reconciliation] Initial run failed:', err),
  );

  reconciliationTimer = setInterval(async () => {
    try {
      await runReconciliation();
    } catch (err) {
      console.error('[excel-reconciliation] Scheduled run failed:', err);
    }
  }, intervalMs);

  // Don't keep the process alive just for this timer
  reconciliationTimer.unref();

  console.log(`[excel-reconciliation] Job started — interval: ${intervalMs}ms`);
}

/**
 * Stop the reconciliation job.
 */
export function stopReconciliationJob(): void {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
    console.log('[excel-reconciliation] Job stopped');
  }
}

// ── Core reconciliation logic ───────────────────────────────────

/**
 * Run a single reconciliation cycle across all Excel-enabled tenants.
 */
async function runReconciliation(): Promise<void> {
  // 1. Find all tenants with Excel integration enabled
  const tenants = await getExcelEnabledTenants();
  if (tenants.length === 0) return;

  for (const tenant of tenants) {
    try {
      await reconcileTenant(tenant.id, tenant.config);
    } catch (err) {
      console.error(
        `[excel-reconciliation] Failed for tenant ${tenant.id}:`,
        err,
      );
    }
  }
}

/**
 * Reconcile a single tenant's DB state with their Excel file.
 */
async function reconcileTenant(
  tenantId: string,
  config: ExcelIntegrationConfig,
): Promise<void> {
  if (!config.file_path) return;

  // ── Step 1: Push unsynced DB appointments to Excel ──────────
  const unsyncedAppointments = await getUnsyncedAppointments(tenantId);

  if (unsyncedAppointments.length > 0) {
    const excelRows = unsyncedAppointments.map((apt) =>
      appointmentToExcelRow(apt, apt.sync_version ?? 1, 'ai-bot'),
    );

    try {
      const resultMap = await batchUpsertExcelRows(
        config.file_path,
        excelRows,
        config.sheet_name ?? 'Appointments',
      );

      // Mark synced and update row references
      for (const [dbId, rowNum] of resultMap) {
        await markAppointmentSynced(dbId, String(rowNum));
      }

      console.log(
        `[excel-reconciliation] Pushed ${unsyncedAppointments.length} unsynced row(s) for tenant ${tenantId}`,
      );
    } catch (err) {
      console.error(
        `[excel-reconciliation] Failed to push unsynced rows for tenant ${tenantId}:`,
        err,
      );
    }
  }

  // ── Step 2: Retry dead-letter entries ───────────────────────
  const deadLetterEntries = await getDeadLetterEntries(tenantId);

  if (deadLetterEntries.length > 0) {
    let resolved = 0;
    for (const entry of deadLetterEntries) {
      try {
        // Re-fetch the current appointment state
        const apt = await getAppointmentById(entry.appointment_id);
        if (!apt) {
          // Appointment was deleted — resolve the dead letter
          await resolveDeadLetter(entry.id);
          resolved++;
          continue;
        }

        const excelRow = appointmentToExcelRow(apt, apt.sync_version ?? 1, 'ai-bot');
        const rowNum = await batchUpsertExcelRows(
          config.file_path,
          [excelRow],
          config.sheet_name ?? 'Appointments',
        );

        const rowNumber = rowNum.get(apt.id);
        if (rowNumber) {
          await markAppointmentSynced(apt.id, String(rowNumber));
        }
        await resolveDeadLetter(entry.id);
        resolved++;
      } catch (err) {
        // Increment attempt count
        await incrementDeadLetterAttempt(entry.id, String(err));
      }
    }

    if (resolved > 0) {
      console.log(
        `[excel-reconciliation] Resolved ${resolved}/${deadLetterEntries.length} dead-letter entries for tenant ${tenantId}`,
      );
    }
  }

  // ── Step 3: Find DB appointments missing from Excel ─────────
  const dbAppointments = await getConfirmedAppointments(tenantId);
  if (dbAppointments.length === 0) return;

  let existingExcelRows: ExcelRow[];
  try {
    existingExcelRows = await readExcelRows(
      config.file_path,
      config.sheet_name ?? 'Appointments',
    );
  } catch {
    // File might not exist or be corrupt — skip this check
    return;
  }

  const excelDbIds = new Set(existingExcelRows.map((r) => r.db_id));
  const missingFromExcel = dbAppointments.filter((apt) => !excelDbIds.has(apt.id));

  if (missingFromExcel.length > 0) {
    const excelRows = missingFromExcel.map((apt) =>
      appointmentToExcelRow(apt, apt.sync_version ?? 1, 'ai-bot'),
    );

    try {
      const resultMap = await batchUpsertExcelRows(
        config.file_path,
        excelRows,
        config.sheet_name ?? 'Appointments',
      );

      for (const [dbId, rowNum] of resultMap) {
        await markAppointmentSynced(dbId, String(rowNum));
      }

      console.log(
        `[excel-reconciliation] Backfilled ${missingFromExcel.length} missing row(s) for tenant ${tenantId}`,
      );
    } catch (err) {
      console.error(
        `[excel-reconciliation] Failed to backfill missing rows for tenant ${tenantId}:`,
        err,
      );
    }
  }

  // Update last reconciliation timestamp
  await updateLastReconciliation(tenantId);
}

// ── Database helpers ────────────────────────────────────────────

interface TenantExcelInfo {
  id: string;
  config: ExcelIntegrationConfig;
}

async function getExcelEnabledTenants(): Promise<TenantExcelInfo[]> {
  const { rows } = await query<{ id: string; excel_integration: ExcelIntegrationConfig }>(
    `SELECT id, excel_integration FROM tenants
     WHERE excel_integration IS NOT NULL
       AND (excel_integration->>'enabled')::boolean = true`,
  );
  return rows.map((r) => ({ id: r.id, config: r.excel_integration }));
}

interface AppointmentWithSync extends Appointment {
  sync_version?: number;
}

async function getUnsyncedAppointments(tenantId: string): Promise<AppointmentWithSync[]> {
  const { rows } = await query<AppointmentWithSync>(
    `SELECT *, sync_version FROM appointments
     WHERE tenant_id = $1
       AND sync_status IN ('pending', 'failed')
     ORDER BY updated_at ASC
     LIMIT 100`,
    [tenantId],
  );
  return rows;
}

async function getConfirmedAppointments(tenantId: string): Promise<AppointmentWithSync[]> {
  const { rows } = await query<AppointmentWithSync>(
    `SELECT *, sync_version FROM appointments
     WHERE tenant_id = $1
       AND status IN ('confirmed', 'cancelled')
     ORDER BY start_time DESC
     LIMIT 500`,
    [tenantId],
  );
  return rows;
}

async function getAppointmentById(id: string): Promise<AppointmentWithSync | null> {
  const { rows } = await query<AppointmentWithSync>(
    'SELECT *, sync_version FROM appointments WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

async function markAppointmentSynced(appointmentId: string, rowRef: string): Promise<void> {
  await query(
    `UPDATE appointments
     SET sync_status = 'synced', excel_row_ref = $1, last_synced_at = NOW()
     WHERE id = $2`,
    [rowRef, appointmentId],
  );
}

interface DeadLetterEntry {
  id: string;
  appointment_id: string;
  operation: string;
  error_message: string;
  attempts: number;
}

async function getDeadLetterEntries(tenantId: string): Promise<DeadLetterEntry[]> {
  const { rows } = await query<DeadLetterEntry>(
    `SELECT id, appointment_id, operation, error_message, attempts
     FROM sync_dead_letter
     WHERE tenant_id = $1
       AND resolved = false
       AND attempts < 10
     ORDER BY last_failed_at ASC
     LIMIT 50`,
    [tenantId],
  );
  return rows;
}

async function resolveDeadLetter(id: string): Promise<void> {
  await query(
    `UPDATE sync_dead_letter SET resolved = true, resolved_at = NOW() WHERE id = $1`,
    [id],
  );
}

async function incrementDeadLetterAttempt(id: string, error: string): Promise<void> {
  await query(
    `UPDATE sync_dead_letter
     SET attempts = attempts + 1, last_failed_at = NOW(), error_message = $1
     WHERE id = $2`,
    [error, id],
  );
}

async function updateLastReconciliation(tenantId: string): Promise<void> {
  await query(
    `UPDATE tenants
     SET excel_integration = jsonb_set(
       COALESCE(excel_integration, '{}'::jsonb),
       '{last_reconciliation_at}',
       to_jsonb(NOW()::text)
     )
     WHERE id = $1`,
    [tenantId],
  );
}
