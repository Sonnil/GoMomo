// ============================================================
// Excel Template Generator
//
// Standalone script to create a sample Excel file with the
// standard AI Receptionist column layout.
//
// Usage:
//   npx tsx scripts/generate-excel-template.ts [output-path]
//
// Default output: ./data/appointments-template.xlsx
// ============================================================

import { createExcelTemplate } from '../src/integrations/excel-file-ops.js';
import path from 'node:path';

const outputPath = process.argv[2]
  || path.resolve(import.meta.dirname, '..', 'data', 'appointments-template.xlsx');

async function main() {
  console.log(`Generating Excel template at: ${outputPath}`);
  await createExcelTemplate(outputPath);
  console.log('✓ Template created successfully');
  console.log('');
  console.log('Columns:');
  console.log('  A: Appt ID       (APT-XXXXXX)');
  console.log('  B: Date           (YYYY-MM-DD)');
  console.log('  C: Start Time     (HH:mm)');
  console.log('  D: End Time       (HH:mm)');
  console.log('  E: Service');
  console.log('  F: Client Name');
  console.log('  G: Client Email');
  console.log('  H: Client Phone');
  console.log('  I: Notes');
  console.log('  J: Status         (dropdown: confirmed/cancelled/completed/no_show)');
  console.log('  K: Booked By      (read-only: ai-bot/admin/phone)');
  console.log('  L: Created At     (read-only: ISO-8601)');
  console.log('  M: Modified At    (read-only: ISO-8601)');
  console.log('  N: Ver            (read-only: sync version)');
  console.log('  O: DB ID          (read-only: UUID)');
}

main().catch((err) => {
  console.error('Failed to generate template:', err);
  process.exit(1);
});
