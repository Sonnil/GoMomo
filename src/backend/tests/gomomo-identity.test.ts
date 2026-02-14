// ============================================================
// Gomomo Identity Verification Test
//
// Asserts that the default business identity is "Gomomo" across
// ALL source layers and that NO Bloom/clinic/wellness references
// remain in runtime code.
//
//  1. Drift guard exports correct Gomomo defaults
//  2. Seed mentions only Gomomo (no clinic)
//  3. Drift guard file has no banned branding
//  4. Default tenant ID is canonical UUID
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_DEFAULTS,
} from '../src/db/default-tenant-drift-guard.js';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(__dirname, '..');

const BANNED_WORDS = [
  /Bloom/i,
  /[Cc]linic/,
  /[Ww]ellness\s*[Ss]tudio/,
];

describe('Gomomo Identity Verification', () => {
  it('DEFAULT_TENANT_ID is the canonical UUID', () => {
    expect(DEFAULT_TENANT_ID).toBe('00000000-0000-4000-a000-000000000001');
  });

  it('DEFAULT_TENANT_DEFAULTS.name is "Gomomo"', () => {
    expect(DEFAULT_TENANT_DEFAULTS.name).toBe('Gomomo');
  });

  it('DEFAULT_TENANT_DEFAULTS.slug is "gomomo"', () => {
    expect(DEFAULT_TENANT_DEFAULTS.slug).toBe('gomomo');
  });

  it('drift guard source has no banned branding', () => {
    const src = fs.readFileSync(
      path.resolve(ROOT, 'src', 'db', 'default-tenant-drift-guard.ts'),
      'utf-8',
    );
    for (const pattern of BANNED_WORDS) {
      expect(src, `drift guard still contains ${pattern}`).not.toMatch(pattern);
    }
  });

  it('seed.ts has no banned branding', () => {
    const src = fs.readFileSync(
      path.resolve(ROOT, 'src', 'db', 'seed.ts'),
      'utf-8',
    );
    for (const pattern of BANNED_WORDS) {
      expect(src, `seed.ts still contains ${pattern}`).not.toMatch(pattern);
    }
    expect(src).toContain("'Gomomo'");
    expect(src).toContain("'gomomo'");
  });

  it('mock-server has no banned branding', () => {
    const src = fs.readFileSync(
      path.resolve(ROOT, 'src', 'mock-server.ts'),
      'utf-8',
    );
    for (const pattern of BANNED_WORDS) {
      expect(src, `mock-server.ts still contains ${pattern}`).not.toMatch(pattern);
    }
  });
});
