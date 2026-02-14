// ============================================================
// Followup Tracking Repository
//
// Tracks follow-up contacts per session for limit and cooldown
// enforcement.  Used by the tool executor to decide whether a
// new follow-up is allowed before enqueuing a job.
// ============================================================

import { query } from '../db/client.js';

export interface FollowupContact {
  id: string;
  tenant_id: string;
  session_id: string;
  client_email: string;
  client_phone: string | null;
  channel: 'email' | 'sms';
  reason: string | null;
  job_id: string | null;
  created_at: Date;
}

export const followupTrackingRepo = {
  /**
   * Record a new follow-up contact.
   */
  async record(data: {
    tenant_id: string;
    session_id: string;
    client_email: string;
    client_phone?: string | null;
    channel: 'email' | 'sms';
    reason?: string | null;
    job_id?: string | null;
  }): Promise<FollowupContact> {
    const { rows } = await query<FollowupContact>(
      `INSERT INTO followup_contacts
         (tenant_id, session_id, client_email, client_phone, channel, reason, job_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.tenant_id,
        data.session_id,
        data.client_email,
        data.client_phone ?? null,
        data.channel,
        data.reason ?? null,
        data.job_id ?? null,
      ],
    );
    return rows[0];
  },

  /**
   * Count follow-up contacts in a given session.
   */
  async countBySession(sessionId: string): Promise<number> {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM followup_contacts
       WHERE session_id = $1`,
      [sessionId],
    );
    return parseInt(rows[0].count, 10);
  },

  /**
   * Get the most recent follow-up sent to a recipient (email).
   * Used for cooldown enforcement.
   */
  async lastFollowupTo(clientEmail: string): Promise<FollowupContact | null> {
    const { rows } = await query<FollowupContact>(
      `SELECT * FROM followup_contacts
       WHERE client_email = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [clientEmail],
    );
    return rows[0] ?? null;
  },
};
