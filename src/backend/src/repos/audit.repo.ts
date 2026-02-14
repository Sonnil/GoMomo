import { query } from '../db/client.js';
import type { AuditEntry } from '../domain/types.js';

export const auditRepo = {
  async log(entry: AuditEntry, client?: any): Promise<void> {
    const q = client?.query.bind(client) ?? query;
    await q(
      `INSERT INTO audit_log (tenant_id, event_type, entity_type, entity_id, actor, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.tenant_id,
        entry.event_type,
        entry.entity_type,
        entry.entity_id,
        entry.actor,
        entry.payload ? JSON.stringify(entry.payload) : null,
      ],
    );
  },

  async listByTenant(
    tenantId: string,
    limit = 100,
    offset = 0,
  ): Promise<AuditEntry[]> {
    const { rows } = await query<AuditEntry>(
      `SELECT * FROM audit_log
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );
    return rows;
  },
};
