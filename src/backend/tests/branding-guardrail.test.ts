// ============================================================
// Branding Guardrail Tests — Gomomo is the ONLY identity
//
// Ensures all runtime-relevant sources use "Gomomo" branding
// and contain ZERO references to old identities (Bloom, clinic).
//
//  1. Migration 022 exists and renames to Gomomo
//  2. Seed script uses Gomomo branding (no Bloom/clinic)
//  3. Mock-server uses Gomomo branding
//  4. Demo-server uses Gomomo branding
//  5. Voice-mock-server uses Gomomo branding
//  6. System-prompt generator has no hardcoded old branding
//  7. Tenant fixture gomomo.json has Gomomo branding
//  8. Old tenant fixtures are deleted
// ============================================================

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(ROOT, '..', '..');
const BANNED_PATTERNS = [
  /Bloom\s*Wellness/i,
  /bloom-wellness/i,
  /Demo\s*Clinic/i,
  /demo-clinic/i,
  /gomomo\s*Demo\s*Clinic/i,
  /gomomo-demo/i,
];

/** Assert a source file contains no banned branding */
function expectClean(relPath: string) {
  const abs = path.resolve(ROOT, relPath);
  const content = fs.readFileSync(abs, 'utf-8');
  for (const pattern of BANNED_PATTERNS) {
    expect(content, `${relPath} still contains ${pattern}`).not.toMatch(pattern);
  }
  return content;
}

describe('Branding Guardrail — Gomomo only', () => {
  // ── 1. Migration 022 ──────────────────────────────────────

  it('migration 022 renames to Gomomo in DB', () => {
    const migrationPath = path.resolve(
      ROOT, 'src', 'db', 'migrations', '022_rebrand_to_gomomo.sql',
    );
    expect(fs.existsSync(migrationPath)).toBe(true);

    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toContain("name = 'Gomomo'");
    expect(sql).toContain("slug = 'gomomo'");
  });

  // ── 2. Seed script ────────────────────────────────────────

  it('seed.ts uses Gomomo branding', () => {
    const content = expectClean('src/db/seed.ts');
    expect(content).toContain("'Gomomo'");
    expect(content).toContain("'gomomo'");
  });

  // ── 3. Mock-server ────────────────────────────────────────

  it('mock-server.ts uses Gomomo branding', () => {
    const content = expectClean('src/mock-server.ts');
    expect(content).toContain("'Gomomo'");
  });

  // ── 4. Demo-server ────────────────────────────────────────

  it('demo-server.ts uses Gomomo branding', () => {
    const content = expectClean('src/demo-server.ts');
    expect(content).toContain("'Gomomo'");
  });

  // ── 5. Voice-mock-server ──────────────────────────────────

  it('voice-mock-server.ts uses Gomomo branding', () => {
    const content = expectClean('src/voice-mock-server.ts');
    expect(content).toContain("'Gomomo'");
  });

  // ── 6. System prompt generator ────────────────────────────

  it('system-prompt.ts has no hardcoded old branding', () => {
    const content = expectClean('src/agent/system-prompt.ts');
    expect(content).toContain('tenant.name');
  });

  // ── 7. Tenant fixture uses Gomomo branding ────────────────

  it('gomomo.json has Gomomo branding', () => {
    const fixturePath = path.resolve(PROJECT_ROOT, 'tenants', 'gomomo.json');
    expect(fs.existsSync(fixturePath)).toBe(true);

    const json = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    expect(json.name).toBe('Gomomo');
    expect(json.slug).toBe('gomomo');
    expect(json.persona.greeting).toContain('Gomomo');
    expect(json.persona.greeting).not.toMatch(/Bloom|[Cc]linic/);
    expect(json.branding.widget_title).toContain('Gomomo');
    expect(json.branding.widget_title).not.toMatch(/Bloom|[Cc]linic/);
  });

  // ── 8. Old fixtures are deleted ───────────────────────────

  it('old tenant fixtures no longer exist', () => {
    const oldPaths = [
      path.resolve(PROJECT_ROOT, 'tenants', 'demo-bloom-wellness.json'),
      path.resolve(PROJECT_ROOT, 'tenants', 'demo-gomomo-clinic.json'),
      path.resolve(PROJECT_ROOT, 'tenants', 'demo-clinic.json'),
    ];
    for (const p of oldPaths) {
      expect(fs.existsSync(p), `${path.basename(p)} should not exist`).toBe(false);
    }
  });
});
