// ============================================================
// Excel File Operations — Read/write .xlsx files using exceljs
//
// MVP: Local file operations for dev/testing.
// Future: Swap in Graph API for OneDrive/SharePoint.
// ============================================================

import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'date-fns';
import type { Appointment } from '../domain/types.js';

// ── Column definitions matching the design spec ─────────────────

export const EXCEL_COLUMNS = [
  { key: 'appt_id',      header: 'Appt ID',      width: 14 },
  { key: 'date',          header: 'Date',          width: 14 },
  { key: 'start_time',    header: 'Start Time',    width: 12 },
  { key: 'end_time',      header: 'End Time',      width: 12 },
  { key: 'service',       header: 'Service',       width: 20 },
  { key: 'client_name',   header: 'Client Name',   width: 22 },
  { key: 'client_email',  header: 'Client Email',  width: 28 },
  { key: 'client_phone',  header: 'Client Phone',  width: 16 },
  { key: 'notes',         header: 'Notes',         width: 30 },
  { key: 'status',        header: 'Status',        width: 14 },
  { key: 'booked_by',     header: 'Booked By',     width: 12 },
  { key: 'created_at',    header: 'Created At',    width: 22 },
  { key: 'modified_at',   header: 'Modified At',   width: 22 },
  { key: 'ver',           header: 'Ver',           width: 6 },
  { key: 'db_id',         header: 'DB ID',         width: 40 },
] as const;

export type ExcelColumnKey = typeof EXCEL_COLUMNS[number]['key'];

/**
 * Row data as it appears in the Excel file.
 */
export interface ExcelRow {
  appt_id: string;
  date: string;          // YYYY-MM-DD
  start_time: string;    // HH:mm
  end_time: string;      // HH:mm
  service: string;
  client_name: string;
  client_email: string;
  client_phone: string;
  notes: string;
  status: string;
  booked_by: string;
  created_at: string;    // ISO-8601
  modified_at: string;   // ISO-8601
  ver: number;
  db_id: string;         // UUID
}

// ── Conversion helpers ──────────────────────────────────────────

/**
 * Convert a domain Appointment to an Excel row.
 */
export function appointmentToExcelRow(
  appointment: Appointment,
  syncVersion: number = 1,
  bookedBy: string = 'ai-bot',
): ExcelRow {
  const startDate = new Date(appointment.start_time);
  const endDate = new Date(appointment.end_time);

  return {
    appt_id: appointment.reference_code,
    date: format(startDate, 'yyyy-MM-dd'),
    start_time: format(startDate, 'HH:mm'),
    end_time: format(endDate, 'HH:mm'),
    service: appointment.service ?? '',
    client_name: appointment.client_name,
    client_email: appointment.client_email,
    client_phone: '',  // Future: add client_phone to Appointment
    notes: appointment.client_notes ?? '',
    status: appointment.status,
    booked_by: bookedBy,
    created_at: new Date(appointment.created_at).toISOString(),
    modified_at: new Date(appointment.updated_at).toISOString(),
    ver: syncVersion,
    db_id: appointment.id,
  };
}

/**
 * Convert an Excel row back to partial appointment data (for inbound sync / reconciliation).
 */
export function excelRowToAppointmentData(row: ExcelRow): {
  reference_code: string;
  client_name: string;
  client_email: string;
  client_notes: string | null;
  service: string | null;
  date: string;
  start_time: string;
  end_time: string;
  status: string;
  sync_version: number;
  db_id: string;
} {
  return {
    reference_code: row.appt_id,
    client_name: row.client_name,
    client_email: row.client_email,
    client_notes: row.notes || null,
    service: row.service || null,
    date: row.date,
    start_time: row.start_time,
    end_time: row.end_time,
    status: row.status,
    sync_version: row.ver,
    db_id: row.db_id,
  };
}

// ── File operations ─────────────────────────────────────────────

/**
 * Create a new Excel workbook with the Appointments sheet + headers.
 * Used when connecting a tenant to Excel for the first time.
 */
export async function createExcelTemplate(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'gomomo.ai';
  workbook.created = new Date();

  // ── Appointments sheet ──────────────────────────────────────
  const sheet = workbook.addWorksheet('Appointments', {
    properties: { defaultColWidth: 15 },
    views: [{ state: 'frozen', ySplit: 1 }], // Freeze header row
  });

  // Set columns
  sheet.columns = EXCEL_COLUMNS.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width,
  }));

  // Style the header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2E5090' }, // Dark blue
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 28;

  // Add data validation for Status column (J)
  const statusCol = EXCEL_COLUMNS.findIndex((c) => c.key === 'status') + 1;
  for (let row = 2; row <= 1000; row++) {
    sheet.getCell(row, statusCol).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"confirmed,cancelled,completed,no_show"'],
      showErrorMessage: true,
      errorTitle: 'Invalid Status',
      error: 'Status must be: confirmed, cancelled, completed, or no_show',
    };
  }

  // Mark read-only columns with a lighter header background
  const readOnlyCols = ['booked_by', 'created_at', 'modified_at', 'ver', 'db_id'];
  for (const colKey of readOnlyCols) {
    const colIdx = EXCEL_COLUMNS.findIndex((c) => c.key === colKey) + 1;
    const cell = headerRow.getCell(colIdx);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF808080' }, // Grey — indicates read-only
    };
  }

  // ── Config sheet (read-only info) ───────────────────────────
  const configSheet = workbook.addWorksheet('Config', {
    properties: { defaultColWidth: 25 },
  });
  configSheet.columns = [
    { header: 'Key', key: 'key', width: 25 },
    { header: 'Value', key: 'value', width: 40 },
  ];
  const configHeader = configSheet.getRow(1);
  configHeader.font = { bold: true };
  configHeader.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFDCE6F1' },
  };

  configSheet.addRow({ key: 'generated_by', value: 'gomomo.ai' });
  configSheet.addRow({ key: 'generated_at', value: new Date().toISOString() });
  configSheet.addRow({ key: 'version', value: '1.0' });
  configSheet.addRow({ key: 'note', value: 'Grey columns in Appointments sheet are read-only (system-managed)' });

  await workbook.xlsx.writeFile(filePath);
}

/**
 * Read all appointment rows from an Excel file.
 * Returns parsed ExcelRow objects. Skips the header row.
 */
export async function readExcelRows(filePath: string, sheetName = 'Appointments'): Promise<ExcelRow[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    return [];
  }

  const rows: ExcelRow[] = [];
  const headerMap = new Map<number, string>();

  // Build header→column index map from row 1
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const colDef = EXCEL_COLUMNS.find((c) => c.header === String(cell.value));
    if (colDef) {
      headerMap.set(colNumber, colDef.key);
    }
  });

  // Parse data rows (starting from row 2)
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // Skip header

    const data: Record<string, any> = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headerMap.get(colNumber);
      if (key) {
        data[key] = cell.value;
      }
    });

    // Only include rows that have at least an appt_id or db_id
    if (data.appt_id || data.db_id) {
      rows.push({
        appt_id: String(data.appt_id ?? ''),
        date: String(data.date ?? ''),
        start_time: String(data.start_time ?? ''),
        end_time: String(data.end_time ?? ''),
        service: String(data.service ?? ''),
        client_name: String(data.client_name ?? ''),
        client_email: String(data.client_email ?? ''),
        client_phone: String(data.client_phone ?? ''),
        notes: String(data.notes ?? ''),
        status: String(data.status ?? 'confirmed'),
        booked_by: String(data.booked_by ?? ''),
        created_at: String(data.created_at ?? ''),
        modified_at: String(data.modified_at ?? ''),
        ver: Number(data.ver) || 1,
        db_id: String(data.db_id ?? ''),
      });
    }
  });

  return rows;
}

/**
 * Upsert a single appointment row in the Excel file.
 * Finds existing row by DB ID; inserts at the end if not found.
 * Returns the row number where it was written.
 */
export async function upsertExcelRow(
  filePath: string,
  excelRow: ExcelRow,
  sheetName = 'Appointments',
): Promise<number> {
  // Create file if it doesn't exist
  if (!fs.existsSync(filePath)) {
    await createExcelTemplate(filePath);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  let sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    // Sheet was deleted — recreate it
    sheet = workbook.addWorksheet(sheetName);
    sheet.columns = EXCEL_COLUMNS.map((col) => ({
      header: col.header,
      key: col.key,
      width: col.width,
    }));
  }

  // Build header→column index map
  const headerMap = new Map<number, string>();
  const keyToCol = new Map<string, number>();
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const colDef = EXCEL_COLUMNS.find((c) => c.header === String(cell.value));
    if (colDef) {
      headerMap.set(colNumber, colDef.key);
      keyToCol.set(colDef.key, colNumber);
    }
  });

  // Find existing row by db_id
  const dbIdCol = keyToCol.get('db_id');
  let targetRowNumber: number | null = null;

  if (dbIdCol) {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const cellValue = String(row.getCell(dbIdCol).value ?? '');
      if (cellValue === excelRow.db_id) {
        targetRowNumber = rowNumber;
      }
    });
  }

  // Write the row
  const rowValues = EXCEL_COLUMNS.map((col) => excelRow[col.key as ExcelColumnKey]);

  if (targetRowNumber) {
    // Update existing row
    const row = sheet.getRow(targetRowNumber);
    rowValues.forEach((val, idx) => {
      row.getCell(idx + 1).value = val as any;
    });
    row.commit();
  } else {
    // Append new row
    const newRow = sheet.addRow(rowValues);
    targetRowNumber = newRow.number;
    newRow.commit();
  }

  await workbook.xlsx.writeFile(filePath);
  return targetRowNumber;
}

/**
 * Write multiple appointment rows to the Excel file (batch).
 * Uses upsert logic for each row. More efficient than individual calls
 * because it reads/writes the file once.
 */
export async function batchUpsertExcelRows(
  filePath: string,
  excelRows: ExcelRow[],
  sheetName = 'Appointments',
): Promise<Map<string, number>> {
  if (excelRows.length === 0) return new Map();

  // Create file if it doesn't exist
  if (!fs.existsSync(filePath)) {
    await createExcelTemplate(filePath);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  let sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    sheet = workbook.addWorksheet(sheetName);
    sheet.columns = EXCEL_COLUMNS.map((col) => ({
      header: col.header,
      key: col.key,
      width: col.width,
    }));
  }

  // Build column maps
  const keyToCol = new Map<string, number>();
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const colDef = EXCEL_COLUMNS.find((c) => c.header === String(cell.value));
    if (colDef) {
      keyToCol.set(colDef.key, colNumber);
    }
  });

  // Build existing row index by db_id
  const dbIdCol = keyToCol.get('db_id');
  const existingRows = new Map<string, number>();
  if (dbIdCol) {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const cellValue = String(row.getCell(dbIdCol).value ?? '');
      if (cellValue) {
        existingRows.set(cellValue, rowNumber);
      }
    });
  }

  // Upsert each row
  const resultMap = new Map<string, number>(); // db_id → row number

  for (const excelRow of excelRows) {
    const rowValues = EXCEL_COLUMNS.map((col) => excelRow[col.key as ExcelColumnKey]);
    const existingRowNum = existingRows.get(excelRow.db_id);

    if (existingRowNum) {
      const row = sheet.getRow(existingRowNum);
      rowValues.forEach((val, idx) => {
        row.getCell(idx + 1).value = val as any;
      });
      row.commit();
      resultMap.set(excelRow.db_id, existingRowNum);
    } else {
      const newRow = sheet.addRow(rowValues);
      resultMap.set(excelRow.db_id, newRow.number);
      existingRows.set(excelRow.db_id, newRow.number); // For dedup within batch
      newRow.commit();
    }
  }

  await workbook.xlsx.writeFile(filePath);
  return resultMap;
}

/**
 * Get the count of data rows (excluding header) in the Appointments sheet.
 */
export async function getExcelRowCount(filePath: string, sheetName = 'Appointments'): Promise<number> {
  if (!fs.existsSync(filePath)) return 0;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) return 0;

  // rowCount includes the header row, and exceljs can over-count
  // Count actual data rows
  let count = 0;
  sheet.eachRow({ includeEmpty: false }, (_, rowNumber) => {
    if (rowNumber > 1) count++;
  });

  return count;
}
