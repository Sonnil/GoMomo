import { query } from '../db/client.js';
import type { ChatSession, ConversationMessage, CustomerIdentity } from '../domain/types.js';

export const sessionRepo = {
  async findOrCreate(
    id: string,
    tenantId: string,
    channel: 'web' | 'sms' | 'voice' = 'web',
  ): Promise<ChatSession> {
    // Upsert: create if not exists, set channel on creation
    const { rows } = await query<ChatSession>(
      `INSERT INTO chat_sessions (id, tenant_id, channel)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [id, tenantId, channel],
    );
    return rows[0];
  },

  async findById(id: string): Promise<ChatSession | null> {
    const { rows } = await query<ChatSession>(
      'SELECT * FROM chat_sessions WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  },

  async updateConversation(
    id: string,
    conversation: ConversationMessage[],
  ): Promise<void> {
    await query(
      'UPDATE chat_sessions SET conversation = $1 WHERE id = $2',
      [JSON.stringify(conversation), id],
    );
  },

  async updateMetadata(
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await query(
      'UPDATE chat_sessions SET metadata = $1 WHERE id = $2',
      [JSON.stringify(metadata), id],
    );
  },

  // ── Customer Linking ────────────────────────────────────

  /**
   * Link a session to a customer identity.
   */
  async linkCustomer(sessionId: string, customerId: string): Promise<void> {
    await query(
      'UPDATE chat_sessions SET customer_id = $1, updated_at = NOW() WHERE id = $2',
      [customerId, sessionId],
    );
  },

  /**
   * Find the most recent session for a customer (for cross-channel continuity).
   * Returns the newest session by updated_at for the given tenant.
   */
  async findByCustomerId(
    customerId: string,
    tenantId: string,
  ): Promise<ChatSession | null> {
    const { rows } = await query<ChatSession>(
      `SELECT * FROM chat_sessions
       WHERE customer_id = $1 AND tenant_id = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [customerId, tenantId],
    );
    return rows[0] ?? null;
  },

  // ── Email Gate Helpers ──────────────────────────────────

  /**
   * Increment message_count and return the new value.
   * Used to determine when the email gate should trigger.
   */
  async incrementMessageCount(sessionId: string): Promise<number> {
    const { rows } = await query<{ message_count: number }>(
      `UPDATE chat_sessions
       SET message_count = COALESCE(message_count, 0) + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING message_count`,
      [sessionId],
    );
    return rows[0]?.message_count ?? 0;
  },

  /**
   * Mark a session as email-verified.
   */
  async markEmailVerified(sessionId: string): Promise<void> {
    await query(
      `UPDATE chat_sessions
       SET email_verified = true, updated_at = NOW()
       WHERE id = $1`,
      [sessionId],
    );
  },

  /**
   * Check if a session is email-verified.
   */
  async isEmailVerified(sessionId: string): Promise<boolean> {
    const { rows } = await query<{ email_verified: boolean }>(
      'SELECT email_verified FROM chat_sessions WHERE id = $1',
      [sessionId],
    );
    return rows[0]?.email_verified ?? false;
  },

  /**
   * Get the current message count for a session.
   */
  async getMessageCount(sessionId: string): Promise<number> {
    const { rows } = await query<{ message_count: number }>(
      'SELECT message_count FROM chat_sessions WHERE id = $1',
      [sessionId],
    );
    return rows[0]?.message_count ?? 0;
  },

  /**
   * Get the verified email for a session (via linked customer).
   * Returns null if the session is not email-verified or has no linked customer.
   */
  async getVerifiedEmail(sessionId: string): Promise<string | null> {
    const { rows } = await query<{ email: string | null }>(
      `SELECT c.email
       FROM chat_sessions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.id = $1 AND s.email_verified = true`,
      [sessionId],
    );
    return rows[0]?.email ?? null;
  },

  /**
   * Get the full customer identity for a verified session.
   * Returns verified email, display name, and phone when the session
   * is email-verified and has a linked customer record.
   * Returns null if the session is not verified or has no linked customer.
   */
  async getCustomerIdentity(sessionId: string): Promise<CustomerIdentity | null> {
    const { rows } = await query<{ email: string | null; display_name: string | null; phone: string | null }>(
      `SELECT c.email, c.display_name, c.phone
       FROM chat_sessions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.id = $1 AND s.email_verified = true`,
      [sessionId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      verifiedEmail: row.email,
      displayName: row.display_name,
      phone: row.phone,
    };
  },

  // ── Trial Usage Helpers ─────────────────────────────────

  /**
   * Increment user_message_count (only for messages that pass the email gate)
   * and return the new value.
   */
  async incrementUserMessageCount(sessionId: string): Promise<number> {
    const { rows } = await query<{ user_message_count: number }>(
      `UPDATE chat_sessions
       SET user_message_count = COALESCE(user_message_count, 0) + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING user_message_count`,
      [sessionId],
    );
    return rows[0]?.user_message_count ?? 0;
  },

  /**
   * Increment booking_count after a successful booking and return the new value.
   */
  async incrementBookingCount(sessionId: string): Promise<number> {
    const { rows } = await query<{ booking_count: number }>(
      `UPDATE chat_sessions
       SET booking_count = COALESCE(booking_count, 0) + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING booking_count`,
      [sessionId],
    );
    return rows[0]?.booking_count ?? 0;
  },

  /**
   * Get current trial usage counters for a session.
   */
  async getTrialUsage(sessionId: string): Promise<{ user_message_count: number; booking_count: number }> {
    const { rows } = await query<{ user_message_count: number; booking_count: number }>(
      'SELECT COALESCE(user_message_count, 0) AS user_message_count, COALESCE(booking_count, 0) AS booking_count FROM chat_sessions WHERE id = $1',
      [sessionId],
    );
    return rows[0] ?? { user_message_count: 0, booking_count: 0 };
  },
};
