/**
 * SMS Opt-Out Repository
 *
 * Tracks phone numbers that have opted out of SMS communications.
 * STOP/UNSUBSCRIBE/CANCEL/END/QUIT → opted out
 * START/UNSTOP → opted back in
 *
 * Per-tenant opt-outs: a phone can opt out from one tenant
 * but still receive from others. A NULL tenant_id means global.
 */

import { query } from '../db/client.js';

export const smsOptOutRepo = {
  /**
   * Record an opt-out for a phone number.
   * Uses ON CONFLICT to be idempotent.
   */
  async optOut(phone: string, tenantId: string | null): Promise<void> {
    await query(
      `INSERT INTO sms_opt_outs (phone, tenant_id)
       VALUES ($1, $2)
       ON CONFLICT (phone, tenant_id) DO NOTHING`,
      [phone, tenantId],
    );
  },

  /**
   * Remove an opt-out (user texted START).
   */
  async optIn(phone: string, tenantId: string | null): Promise<void> {
    if (tenantId) {
      await query(
        `DELETE FROM sms_opt_outs
         WHERE phone = $1 AND tenant_id = $2`,
        [phone, tenantId],
      );
    } else {
      // START without a specific tenant → remove all opt-outs for this phone
      await query(
        `DELETE FROM sms_opt_outs WHERE phone = $1`,
        [phone],
      );
    }
  },

  /**
   * Check if a phone number has opted out.
   * Checks both tenant-specific AND global (NULL tenant_id) opt-outs.
   */
  async isOptedOut(phone: string, tenantId: string | null): Promise<boolean> {
    const { rows } = await query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM sms_opt_outs
         WHERE phone = $1
           AND (tenant_id = $2 OR tenant_id IS NULL)
       ) AS exists`,
      [phone, tenantId],
    );
    return rows[0]?.exists ?? false;
  },
};
