// ============================================================
// Push Event Repository — Feature 3
//
// Persistent store for proactive push events. Supports:
// - insert(): create a new push event
// - findPending(): get undelivered events for a session (REST fallback)
// - markDelivered(): flag event as delivered via WS
// - checkCooldown(): prevent push spam per session+type
// ============================================================

import { query } from '../db/client.js';
import type { PushEvent, PushEventPayload, PushEventType } from '../domain/types.js';

/** Cooldown window: no repeat push of same type to same session within 60 s */
const COOLDOWN_SECONDS = 60;

export const pushEventRepo = {
  /**
   * Insert a new push event. Returns the created row.
   */
  async insert(params: {
    tenant_id: string;
    session_id: string;
    type: PushEventType;
    payload: PushEventPayload;
  }): Promise<PushEvent> {
    const { rows } = await query<PushEvent>(
      `INSERT INTO push_events (tenant_id, session_id, type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [params.tenant_id, params.session_id, params.type, JSON.stringify(params.payload)],
    );
    return rows[0];
  },

  /**
   * Find all undelivered push events for a given session.
   * Ordered by creation time (oldest first → FIFO delivery).
   */
  async findPending(sessionId: string): Promise<PushEvent[]> {
    const { rows } = await query<PushEvent>(
      `SELECT * FROM push_events
       WHERE session_id = $1 AND delivered = FALSE
       ORDER BY created_at ASC`,
      [sessionId],
    );
    return rows;
  },

  /**
   * Mark a push event as delivered.
   */
  async markDelivered(id: string): Promise<void> {
    await query(
      `UPDATE push_events SET delivered = TRUE WHERE id = $1`,
      [id],
    );
  },

  /**
   * Mark all pending push events for a session as delivered (batch).
   */
  async markAllDelivered(sessionId: string): Promise<number> {
    const { rows } = await query<{ count: string }>(
      `WITH updated AS (
         UPDATE push_events
         SET delivered = TRUE
         WHERE session_id = $1 AND delivered = FALSE
         RETURNING id
       )
       SELECT COUNT(*)::text as count FROM updated`,
      [sessionId],
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  },

  /**
   * Check if a push of the given type was sent to the session within the
   * cooldown window. Returns true if within cooldown (should NOT send).
   */
  async checkCooldown(sessionId: string, type: PushEventType): Promise<boolean> {
    const { rows } = await query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM push_events
         WHERE session_id = $1
           AND type = $2
           AND created_at > NOW() - INTERVAL '${COOLDOWN_SECONDS} seconds'
       ) as exists`,
      [sessionId, type],
    );
    return rows[0]?.exists ?? false;
  },
};
