/**
 * SMS Rate Limit Repository — DB-Backed
 *
 * Replaces the in-memory rate limit map in sms-sender.ts.
 * Survives process restarts and works correctly in multi-process deployments.
 *
 * Strategy: Insert a row for each SMS sent. To check the rate limit,
 * count rows for the phone within the sliding window.
 */

import { query } from '../db/client.js';
import { env } from '../config/env.js';

export const smsRateLimitRepo = {
  /**
   * Check whether a phone number has exceeded the **outbound** SMS rate limit.
   * Used by sms-sender.ts to cap proactive/handoff SMS.
   * Returns { allowed, remaining, count }.
   */
  async check(phone: string): Promise<{ allowed: boolean; remaining: number; count: number }> {
    const maxSms = env.SMS_RATE_LIMIT_MAX;
    const windowMinutes = env.SMS_RATE_LIMIT_WINDOW_MINUTES;

    const { rows } = await query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM sms_rate_limits
       WHERE phone = $1
         AND direction = 'outbound'
         AND sent_at > NOW() - ($2 || ' minutes')::INTERVAL`,
      [phone, String(windowMinutes)],
    );

    const count = parseInt(rows[0]?.cnt ?? '0', 10);
    const remaining = Math.max(0, maxSms - count);

    return {
      allowed: count < maxSms,
      remaining,
      count,
    };
  },

  /**
   * Check whether a phone number has exceeded the **inbound** SMS rate limit.
   * Inbound limit is higher because a booking conversation needs 6-10 turns.
   */
  async checkInbound(phone: string): Promise<{ allowed: boolean; remaining: number; count: number }> {
    const maxSms = env.SMS_INBOUND_RATE_LIMIT_MAX;
    const windowMinutes = env.SMS_INBOUND_RATE_LIMIT_WINDOW_MINUTES;

    const { rows } = await query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM sms_rate_limits
       WHERE phone = $1
         AND direction = 'inbound'
         AND sent_at > NOW() - ($2 || ' minutes')::INTERVAL`,
      [phone, String(windowMinutes)],
    );

    const count = parseInt(rows[0]?.cnt ?? '0', 10);
    const remaining = Math.max(0, maxSms - count);

    return {
      allowed: count < maxSms,
      remaining,
      count,
    };
  },

  /**
   * Record an SMS event for rate limiting.
   * @param direction - 'inbound' for customer messages, 'outbound' for bot/handoff messages
   */
  async record(phone: string, tenantId: string | null, direction: 'inbound' | 'outbound' = 'outbound'): Promise<void> {
    await query(
      `INSERT INTO sms_rate_limits (phone, tenant_id, direction)
       VALUES ($1, $2, $3)`,
      [phone, tenantId, direction],
    );
  },

  /**
   * Clean up old rate limit rows (older than 24h).
   * Safe to call periodically.
   */
  async cleanup(): Promise<number> {
    const { rowCount } = await query(
      `DELETE FROM sms_rate_limits WHERE sent_at < NOW() - INTERVAL '24 hours'`,
    );
    return rowCount ?? 0;
  },
};
