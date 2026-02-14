import { query } from '../db/client.js';
import type { AvailabilityHold } from '../domain/types.js';
import { env } from '../config/env.js';

export const holdRepo = {
  async create(data: {
    tenant_id: string;
    session_id: string;
    start_time: Date;
    end_time: Date;
  }): Promise<AvailabilityHold> {
    const ttlMs = env.HOLD_TTL_MINUTES * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);

    const { rows } = await query<AvailabilityHold>(
      `INSERT INTO availability_holds (tenant_id, session_id, start_time, end_time, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        data.tenant_id,
        data.session_id,
        data.start_time.toISOString(),
        data.end_time.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    return rows[0];
  },

  async findById(id: string, tenantId: string, client?: any): Promise<AvailabilityHold | null> {
    const q = client?.query.bind(client) ?? query;
    const { rows } = await q(
      `SELECT * FROM availability_holds
       WHERE id = $1 AND tenant_id = $2 AND expires_at > NOW()`,
      [id, tenantId],
    );
    return rows[0] ?? null;
  },

  async findBySession(sessionId: string, tenantId: string): Promise<AvailabilityHold[]> {
    const { rows } = await query<AvailabilityHold>(
      `SELECT * FROM availability_holds
       WHERE session_id = $1 AND tenant_id = $2 AND expires_at > NOW()
       ORDER BY start_time ASC`,
      [sessionId, tenantId],
    );
    return rows;
  },

  async delete(id: string, client?: any): Promise<void> {
    const q = client?.query.bind(client) ?? query;
    await q('DELETE FROM availability_holds WHERE id = $1', [id]);
  },

  async deleteBySession(sessionId: string, tenantId: string): Promise<void> {
    await query(
      'DELETE FROM availability_holds WHERE session_id = $1 AND tenant_id = $2',
      [sessionId, tenantId],
    );
  },

  async deleteExpired(): Promise<AvailabilityHold[]> {
    const { rows } = await query<AvailabilityHold>(
      'DELETE FROM availability_holds WHERE expires_at <= NOW() RETURNING *',
    );
    return rows;
  },

  async listByTenantAndRange(
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<AvailabilityHold[]> {
    const { rows } = await query<AvailabilityHold>(
      `SELECT * FROM availability_holds
       WHERE tenant_id = $1
         AND expires_at > NOW()
         AND start_time < $3
         AND end_time > $2
       ORDER BY start_time ASC`,
      [tenantId, start.toISOString(), end.toISOString()],
    );
    return rows;
  },
};
