/**
 * Default Tenant Drift Guard
 *
 * On backend boot (non-production only), verifies the default tenant row
 * matches expected repo defaults.  If a mismatch is detected the row
 * is auto-corrected so stale seed data cannot reintroduce old branding.
 *
 * Controlled by:
 *   DEMO_TENANT_DRIFT_GUARD=true|false  (default: true)
 *   NODE_ENV — guard is skipped entirely in production.
 */
import { pool } from './client.js';
import { env } from '../config/env.js';

// ── Expected defaults — single source of truth ───────────────────
export const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

export const DEFAULT_TENANT_DEFAULTS = {
  name: 'Gomomo',
  slug: 'gomomo',
  service_catalog_mode: 'free_text',
} as const;

export type DriftCheckResult =
  | { status: 'skipped'; reason: string }
  | { status: 'ok' }
  | { status: 'updated'; diff: Record<string, { was: string; now: string }> }
  | { status: 'not_found' };

/**
 * Check the default tenant row and auto-correct if drifted.
 *
 * @param opts.nodeEnv   — override for NODE_ENV  (tests)
 * @param opts.guardFlag — override for DEMO_TENANT_DRIFT_GUARD (tests)
 * @param opts.query     — injectable query runner (tests)
 */
export async function checkDefaultTenantDrift(opts?: {
  nodeEnv?: string;
  guardFlag?: string;
  query?: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<DriftCheckResult> {
  const nodeEnv   = opts?.nodeEnv   ?? env.NODE_ENV;
  const guardFlag = opts?.guardFlag ?? env.DEMO_TENANT_DRIFT_GUARD;
  const q         = opts?.query     ?? ((text: string, params?: unknown[]) => pool.query(text, params));

  // ── Gate: production or disabled → skip ─────────────────────
  if (nodeEnv === 'production') {
    return { status: 'skipped', reason: 'production' };
  }
  if (guardFlag !== 'true') {
    return { status: 'skipped', reason: 'disabled' };
  }

  // ── Read current row ────────────────────────────────────────
  const { rows } = await q(
    `SELECT name, slug, service_catalog_mode FROM tenants WHERE id = $1`,
    [DEFAULT_TENANT_ID],
  );

  if (rows.length === 0) {
    return { status: 'not_found' };
  }

  const row = rows[0];
  const diff: Record<string, { was: string; now: string }> = {};

  for (const [key, expected] of Object.entries(DEFAULT_TENANT_DEFAULTS)) {
    const actual = String(row[key] ?? '');
    if (actual !== expected) {
      diff[key] = { was: actual, now: expected };
    }
  }

  if (Object.keys(diff).length === 0) {
    return { status: 'ok' };
  }

  // ── Apply correction ────────────────────────────────────────
  await q(
    `UPDATE tenants
        SET name                 = $1,
            slug                 = $2,
            service_catalog_mode = $3
      WHERE id = $4`,
    [
      DEFAULT_TENANT_DEFAULTS.name,
      DEFAULT_TENANT_DEFAULTS.slug,
      DEFAULT_TENANT_DEFAULTS.service_catalog_mode,
      DEFAULT_TENANT_ID,
    ],
  );

  console.log('⚠️  Default tenant updated to match defaults');

  return { status: 'updated', diff };
}
