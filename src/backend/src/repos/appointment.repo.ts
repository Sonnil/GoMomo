import { query } from '../db/client.js';
import type { Appointment, AppointmentStatus } from '../domain/types.js';

function generateReferenceCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'APT-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export const appointmentRepo = {
  async findById(
    id: string,
    tenantId: string,
    client?: any,
  ): Promise<Appointment | null> {
    const q = client?.query.bind(client) ?? query;
    const { rows } = await q(
      'SELECT * FROM appointments WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    return rows[0] ?? null;
  },

  /**
   * Idempotency lookup: find an appointment that was created from a specific hold.
   */
  async findBySourceHold(
    holdId: string,
    client?: any,
  ): Promise<Appointment | null> {
    const q = client?.query.bind(client) ?? query;
    const { rows } = await q(
      `SELECT * FROM appointments WHERE source_hold_id = $1 AND status = 'confirmed'`,
      [holdId],
    );
    return rows[0] ?? null;
  },

  async findByReference(referenceCode: string, tenantId: string): Promise<Appointment | null> {
    const { rows } = await query<Appointment>(
      'SELECT * FROM appointments WHERE reference_code = $1 AND tenant_id = $2',
      [referenceCode, tenantId],
    );
    return rows[0] ?? null;
  },

  async findByEmail(email: string, tenantId: string): Promise<Appointment[]> {
    const { rows } = await query<Appointment>(
      `SELECT * FROM appointments
       WHERE client_email = $1 AND tenant_id = $2 AND status = 'confirmed'
       ORDER BY start_time ASC`,
      [email, tenantId],
    );
    return rows;
  },

  async create(
    data: {
      tenant_id: string;
      client_name: string;
      client_email: string;
      client_notes?: string;
      client_phone?: string;
      service?: string;
      start_time: Date;
      end_time: Date;
      timezone: string;
      google_event_id?: string;
      source_hold_id?: string;
    },
    client?: any, // pg.PoolClient for transaction
  ): Promise<Appointment> {
    const refCode = generateReferenceCode();
    const q = client?.query.bind(client) ?? query;
    const { rows } = await q(
      `INSERT INTO appointments
       (tenant_id, reference_code, client_name, client_email, client_notes, client_phone, service,
        start_time, end_time, timezone, google_event_id, source_hold_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        data.tenant_id,
        refCode,
        data.client_name,
        data.client_email,
        data.client_notes ?? null,
        data.client_phone ?? null,
        data.service ?? null,
        data.start_time.toISOString(),
        data.end_time.toISOString(),
        data.timezone,
        data.google_event_id ?? null,
        data.source_hold_id ?? null,
      ],
    );
    return rows[0];
  },

  async updateStatus(
    id: string,
    tenantId: string,
    status: AppointmentStatus,
    client?: any,
  ): Promise<Appointment | null> {
    const q = client?.query.bind(client) ?? query;
    const { rows } = await q(
      `UPDATE appointments SET status = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [status, id, tenantId],
    );
    return rows[0] ?? null;
  },

  async updateGoogleEventId(
    id: string,
    googleEventId: string,
  ): Promise<void> {
    await query(
      'UPDATE appointments SET google_event_id = $1 WHERE id = $2',
      [googleEventId, id],
    );
  },

  async listByTenantAndRange(
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<Appointment[]> {
    const { rows } = await query<Appointment>(
      `SELECT * FROM appointments
       WHERE tenant_id = $1
         AND status = 'confirmed'
         AND start_time < $3
         AND end_time > $2
       ORDER BY start_time ASC`,
      [tenantId, start.toISOString(), end.toISOString()],
    );
    return rows;
  },

  async listByTenant(
    tenantId: string,
    limit = 50,
    offset = 0,
  ): Promise<Appointment[]> {
    const { rows } = await query<Appointment>(
      `SELECT * FROM appointments
       WHERE tenant_id = $1
       ORDER BY start_time DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );
    return rows;
  },
};
