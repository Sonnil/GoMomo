// ============================================================
// Default Tenant Drift Guard — Unit Tests
//
// Verifies the boot-time guard that auto-corrects the default tenant
// row when it drifts from the expected defaults.  All tests inject
// a mock query function so no real database is needed.
//
//  1. Mismatch (old branding) → row updated, diff returned
//  2. Match (correct Gomomo branding) → status 'ok', no UPDATE
//  3. Production env → skipped (reason: 'production')
//  4. Guard disabled → skipped (reason: 'disabled')
//  5. Tenant row missing → status 'not_found'
//  6. Only default tenant targeted (UPDATE WHERE id = DEFAULT_TENANT_ID)
//  7. Logs warning on update
//  8. No log when already correct
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import {
  checkDefaultTenantDrift,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_DEFAULTS,
} from '../src/db/default-tenant-drift-guard.js';

// ── Helpers ──────────────────────────────────────────────────

/** Build a mock query function that returns the given rows for SELECT */
function mockQuery(selectRows: Record<string, unknown>[]) {
  const calls: { text: string; params: unknown[] }[] = [];

  const q = async (text: string, params?: unknown[]) => {
    calls.push({ text, params: params ?? [] });
    if (text.trim().toUpperCase().startsWith('SELECT')) {
      return { rows: selectRows };
    }
    return { rows: [] };
  };

  return { q, calls };
}

const DEV_ENV   = 'development';
const PROD_ENV  = 'production';
const ENABLED   = 'true';
const DISABLED  = 'false';

describe('Default Tenant Drift Guard', () => {
  // ── 1. Mismatch → updated ──────────────────────────────────

  it('detects mismatch and updates the row', async () => {
    const staleRow = {
      name: 'gomomo Demo Clinic',
      slug: 'gomomo-demo',
      service_catalog_mode: 'free_text',
    };
    const { q, calls } = mockQuery([staleRow]);

    const result = await checkDefaultTenantDrift({
      nodeEnv: DEV_ENV,
      guardFlag: ENABLED,
      query: q,
    });

    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.diff).toEqual({
        name: { was: 'gomomo Demo Clinic', now: DEFAULT_TENANT_DEFAULTS.name },
        slug: { was: 'gomomo-demo', now: DEFAULT_TENANT_DEFAULTS.slug },
      });
    }

    const updateCall = calls.find((c) => c.text.trim().toUpperCase().startsWith('UPDATE'));
    expect(updateCall).toBeDefined();
  });

  // ── 2. Match → ok ──────────────────────────────────────────

  it('returns ok when row already matches defaults', async () => {
    const correctRow = { ...DEFAULT_TENANT_DEFAULTS };
    const { q, calls } = mockQuery([correctRow]);

    const result = await checkDefaultTenantDrift({
      nodeEnv: DEV_ENV,
      guardFlag: ENABLED,
      query: q,
    });

    expect(result.status).toBe('ok');

    const updateCall = calls.find((c) => c.text.trim().toUpperCase().startsWith('UPDATE'));
    expect(updateCall).toBeUndefined();
  });

  // ── 3. Production → skipped ────────────────────────────────

  it('skips in production', async () => {
    const { q, calls } = mockQuery([]);

    const result = await checkDefaultTenantDrift({
      nodeEnv: PROD_ENV,
      guardFlag: ENABLED,
      query: q,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'production' });
    expect(calls).toHaveLength(0);
  });

  // ── 4. Guard disabled → skipped ────────────────────────────

  it('skips when guard is disabled', async () => {
    const { q, calls } = mockQuery([]);

    const result = await checkDefaultTenantDrift({
      nodeEnv: DEV_ENV,
      guardFlag: DISABLED,
      query: q,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  // ── 5. Not found → not_found ───────────────────────────────

  it('returns not_found when tenant row is missing', async () => {
    const { q } = mockQuery([]);

    const result = await checkDefaultTenantDrift({
      nodeEnv: DEV_ENV,
      guardFlag: ENABLED,
      query: q,
    });

    expect(result.status).toBe('not_found');
  });

  // ── 6. Only default tenant targeted ────────────────────────

  it('targets only the default tenant UUID in queries', async () => {
    const staleRow = {
      name: 'Old Name',
      slug: 'old-slug',
      service_catalog_mode: 'structured',
    };
    const { q, calls } = mockQuery([staleRow]);

    await checkDefaultTenantDrift({
      nodeEnv: DEV_ENV,
      guardFlag: ENABLED,
      query: q,
    });

    for (const call of calls) {
      expect(call.params).toContain(DEFAULT_TENANT_ID);
    }
  });

  // ── 7. Logs warning on update ──────────────────────────────

  it('logs a warning when correcting drift', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const staleRow = {
      name: 'Wrong Name',
      slug: DEFAULT_TENANT_DEFAULTS.slug,
      service_catalog_mode: DEFAULT_TENANT_DEFAULTS.service_catalog_mode,
    };
    const { q } = mockQuery([staleRow]);

    await checkDefaultTenantDrift({
      nodeEnv: DEV_ENV,
      guardFlag: ENABLED,
      query: q,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('Default tenant updated'),
    );
    spy.mockRestore();
  });

  // ── 8. No log when already correct ─────────────────────────

  it('does not log when tenant already matches', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const correctRow = { ...DEFAULT_TENANT_DEFAULTS };
    const { q } = mockQuery([correctRow]);

    await checkDefaultTenantDrift({
      nodeEnv: DEV_ENV,
      guardFlag: ENABLED,
      query: q,
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
