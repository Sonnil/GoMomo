// ============================================================
// Job Repository — CRUD + claim/complete/fail for the jobs table
//
// Uses SELECT ... FOR UPDATE SKIP LOCKED for safe concurrent
// claiming (multiple workers can poll without conflicts).
// ============================================================

import { query } from '../db/client.js';
import type { Job, JobStatus } from '../domain/types.js';

export const jobRepo = {
  /**
   * Create a new job in the queue.
   */
  async create(data: {
    tenant_id: string;
    type: string;
    payload: Record<string, unknown>;
    priority?: number;
    run_at?: Date;
    max_attempts?: number;
    source_event?: string;
  }): Promise<Job> {
    const { rows } = await query<Job>(
      `INSERT INTO jobs (tenant_id, type, payload, priority, run_at, max_attempts, source_event)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.tenant_id,
        data.type,
        JSON.stringify(data.payload),
        data.priority ?? 0,
        (data.run_at ?? new Date()).toISOString(),
        data.max_attempts ?? 3,
        data.source_event ?? null,
      ],
    );
    return rows[0];
  },

  /**
   * Claim up to `limit` jobs that are ready to execute.
   * Uses FOR UPDATE SKIP LOCKED to prevent double-claiming.
   * Returns claimed jobs (already updated to 'claimed' status).
   */
  async claimBatch(limit: number): Promise<Job[]> {
    const { rows } = await query<Job>(
      `UPDATE jobs
       SET status = 'claimed', claimed_at = NOW(), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM jobs
         WHERE status = 'pending'
           AND run_at <= NOW()
         ORDER BY priority DESC, run_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    );
    return rows;
  },

  /**
   * Mark a job as completed.
   */
  async complete(jobId: string): Promise<void> {
    await query(
      `UPDATE jobs
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [jobId],
    );
  },

  /**
   * Mark a job as failed. If retries remain, set back to pending.
   */
  async fail(jobId: string, error: string): Promise<void> {
    await query(
      `UPDATE jobs
       SET status = CASE
             WHEN attempts < max_attempts THEN 'pending'
             ELSE 'failed'
           END,
           last_error = $2,
           claimed_at = NULL
       WHERE id = $1`,
      [jobId, error],
    );
  },

  /**
   * Cancel a job (soft delete — keeps audit trail).
   */
  async cancel(jobId: string): Promise<void> {
    await query(
      `UPDATE jobs SET status = 'cancelled' WHERE id = $1 AND status IN ('pending', 'claimed')`,
      [jobId],
    );
  },

  /**
   * Reclaim stale jobs (claimed but not completed within timeout).
   * Returns the number of jobs reclaimed.
   */
  async reclaimStale(staleTimeoutMs: number): Promise<number> {
    const { rowCount } = await query(
      `UPDATE jobs
       SET status = 'pending', claimed_at = NULL
       WHERE status = 'claimed'
         AND claimed_at < NOW() - ($1 || ' milliseconds')::interval
         AND attempts < max_attempts`,
      [staleTimeoutMs],
    );
    return rowCount ?? 0;
  },

  /**
   * Get a job by ID.
   */
  async findById(jobId: string): Promise<Job | null> {
    const { rows } = await query<Job>(
      'SELECT * FROM jobs WHERE id = $1',
      [jobId],
    );
    return rows[0] ?? null;
  },

  /**
   * List jobs for a tenant, with optional status filter.
   */
  async listByTenant(
    tenantId: string,
    options: { status?: JobStatus; limit?: number; offset?: number } = {},
  ): Promise<Job[]> {
    const { status, limit = 50, offset = 0 } = options;
    let sql = 'SELECT * FROM jobs WHERE tenant_id = $1';
    const params: any[] = [tenantId];

    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ' ORDER BY created_at DESC';
    params.push(limit, offset);
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await query<Job>(sql, params);
    return rows;
  },

  /**
   * Count jobs by status (for dashboard).
   */
  async countByStatus(): Promise<Record<string, number>> {
    const { rows } = await query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text as count
       FROM jobs
       GROUP BY status`,
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.status] = parseInt(row.count, 10);
    }
    return result;
  },

  /**
   * List upcoming (scheduled) jobs across all tenants.
   */
  async listUpcoming(limit = 20): Promise<Job[]> {
    const { rows } = await query<Job>(
      `SELECT * FROM jobs
       WHERE status = 'pending' AND run_at > NOW()
       ORDER BY run_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows;
  },
};
