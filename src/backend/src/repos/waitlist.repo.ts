// ============================================================
// Waitlist Repository — CRUD for waitlist_entries table
// ============================================================

import { query } from '../db/client.js';
import type { WaitlistEntry, WaitlistStatus } from '../domain/types.js';

export const waitlistRepo = {
  /**
   * Add a new waitlist entry.
   */
  async create(data: {
    tenant_id: string;
    session_id?: string;
    client_name: string;
    client_email: string;
    preferred_service?: string;
    preferred_days?: string[];
    preferred_time_range?: { start?: string; end?: string };
  }): Promise<WaitlistEntry> {
    const { rows } = await query<WaitlistEntry>(
      `INSERT INTO waitlist_entries
       (tenant_id, session_id, client_name, client_email, preferred_service,
        preferred_days, preferred_time_range)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.tenant_id,
        data.session_id ?? null,
        data.client_name,
        data.client_email,
        data.preferred_service ?? null,
        JSON.stringify(data.preferred_days ?? []),
        JSON.stringify(data.preferred_time_range ?? {}),
      ],
    );
    return rows[0];
  },

  /**
   * Find waiting entries for a tenant, optionally filtered by service.
   * Returns in FIFO order (oldest first).
   */
  async findWaiting(
    tenantId: string,
    options: { service?: string; limit?: number } = {},
  ): Promise<WaitlistEntry[]> {
    const { service, limit = 10 } = options;
    let sql = `SELECT * FROM waitlist_entries
               WHERE tenant_id = $1 AND status = 'waiting'`;
    const params: any[] = [tenantId];

    if (service) {
      params.push(service);
      sql += ` AND (preferred_service IS NULL OR preferred_service = $${params.length})`;
    }

    sql += ` ORDER BY created_at ASC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await query<WaitlistEntry>(sql, params);
    return rows;
  },

  /**
   * Update the status of a waitlist entry.
   */
  async updateStatus(
    id: string,
    status: WaitlistStatus,
    matchedSlot?: { start: string; end: string },
  ): Promise<WaitlistEntry | null> {
    const { rows } = await query<WaitlistEntry>(
      `UPDATE waitlist_entries
       SET status = $2,
           notified_at = CASE WHEN $2 = 'notified' THEN NOW() ELSE notified_at END,
           matched_slot = COALESCE($3, matched_slot)
       WHERE id = $1
       RETURNING *`,
      [id, status, matchedSlot ? JSON.stringify(matchedSlot) : null],
    );
    return rows[0] ?? null;
  },

  /**
   * Count waiting entries for a tenant.
   */
  async countWaiting(tenantId: string): Promise<number> {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM waitlist_entries
       WHERE tenant_id = $1 AND status = 'waiting'`,
      [tenantId],
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  },

  /**
   * List all entries for a tenant (all statuses), most recent first.
   */
  async listByTenant(
    tenantId: string,
    options: { status?: WaitlistStatus; limit?: number } = {},
  ): Promise<WaitlistEntry[]> {
    const { status, limit = 50 } = options;
    let sql = 'SELECT * FROM waitlist_entries WHERE tenant_id = $1';
    const params: any[] = [tenantId];

    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await query<WaitlistEntry>(sql, params);
    return rows;
  },

  /**
   * Find entry by ID.
   */
  async findById(id: string): Promise<WaitlistEntry | null> {
    const { rows } = await query<WaitlistEntry>(
      'SELECT * FROM waitlist_entries WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  },
};
