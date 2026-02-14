// ============================================================
// Policy Repository — CRUD for policy_rules table
// ============================================================

import { query } from '../db/client.js';
import type { PolicyRule } from '../domain/types.js';

export const policyRepo = {
  /**
   * Find all active rules for a given action, ordered by priority DESC.
   * Returns tenant-specific rules first, then global rules.
   */
  async findByAction(action: string, tenantId?: string): Promise<PolicyRule[]> {
    const { rows } = await query<PolicyRule>(
      `SELECT * FROM policy_rules
       WHERE action = $1
         AND is_active = true
         AND (tenant_id = $2 OR tenant_id IS NULL)
       ORDER BY
         CASE WHEN tenant_id IS NOT NULL THEN 0 ELSE 1 END,
         priority DESC`,
      [action, tenantId ?? null],
    );
    return rows;
  },

  /**
   * List all rules, optionally filtered by tenant.
   */
  async list(tenantId?: string, includeInactive = false): Promise<PolicyRule[]> {
    let sql = 'SELECT * FROM policy_rules WHERE 1=1';
    const params: any[] = [];

    if (tenantId) {
      params.push(tenantId);
      sql += ` AND (tenant_id = $${params.length} OR tenant_id IS NULL)`;
    }
    if (!includeInactive) {
      sql += ' AND is_active = true';
    }
    sql += ' ORDER BY action, priority DESC';

    const { rows } = await query<PolicyRule>(sql, params);
    return rows;
  },

  /**
   * Get a single rule by ID.
   */
  async findById(id: string): Promise<PolicyRule | null> {
    const { rows } = await query<PolicyRule>(
      'SELECT * FROM policy_rules WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  },

  /**
   * Create a new policy rule.
   */
  async create(rule: {
    tenant_id?: string;
    action: string;
    effect: 'allow' | 'deny';
    conditions?: Record<string, unknown>;
    priority?: number;
  }): Promise<PolicyRule> {
    const { rows } = await query<PolicyRule>(
      `INSERT INTO policy_rules (tenant_id, action, effect, conditions, priority)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        rule.tenant_id ?? null,
        rule.action,
        rule.effect,
        JSON.stringify(rule.conditions ?? {}),
        rule.priority ?? 0,
      ],
    );
    return rows[0];
  },

  /**
   * Update a policy rule (partial update).
   */
  async update(
    id: string,
    updates: Partial<Pick<PolicyRule, 'effect' | 'conditions' | 'priority' | 'is_active'>>,
  ): Promise<PolicyRule | null> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (updates.effect !== undefined) {
      setClauses.push(`effect = $${paramIdx++}`);
      params.push(updates.effect);
    }
    if (updates.conditions !== undefined) {
      setClauses.push(`conditions = $${paramIdx++}`);
      params.push(JSON.stringify(updates.conditions));
    }
    if (updates.priority !== undefined) {
      setClauses.push(`priority = $${paramIdx++}`);
      params.push(updates.priority);
    }
    if (updates.is_active !== undefined) {
      setClauses.push(`is_active = $${paramIdx++}`);
      params.push(updates.is_active);
    }

    if (setClauses.length === 0) return this.findById(id);

    params.push(id);
    const { rows } = await query<PolicyRule>(
      `UPDATE policy_rules SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params,
    );
    return rows[0] ?? null;
  },
};
