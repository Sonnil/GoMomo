// ============================================================
// Customer Repository — Persistent Customer Identity
//
// Maps phone/email to a customer record per tenant.
// Supports cross-channel session continuity (web ↔ SMS).
// ============================================================

import { query } from '../db/client.js';
import type { Customer, CustomerPreferences } from '../domain/types.js';

export const customerRepo = {
  // ── Lookup ──────────────────────────────────────────────

  async findById(id: string): Promise<Customer | null> {
    const { rows } = await query<Customer>(
      'SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    return rows[0] ?? null;
  },

  async findByPhone(phone: string, tenantId: string): Promise<Customer | null> {
    const { rows } = await query<Customer>(
      `SELECT * FROM customers
       WHERE phone = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [phone, tenantId],
    );
    return rows[0] ?? null;
  },

  async findByEmail(email: string, tenantId: string): Promise<Customer | null> {
    const { rows } = await query<Customer>(
      `SELECT * FROM customers
       WHERE email = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [email.toLowerCase(), tenantId],
    );
    return rows[0] ?? null;
  },

  /**
   * Find a customer by phone OR email (tries phone first, then email).
   * Useful for cross-channel matching.
   */
  async findByPhoneOrEmail(
    tenantId: string,
    phone?: string | null,
    email?: string | null,
  ): Promise<Customer | null> {
    if (phone) {
      const byPhone = await this.findByPhone(phone, tenantId);
      if (byPhone) return byPhone;
    }
    if (email) {
      const byEmail = await this.findByEmail(email.toLowerCase(), tenantId);
      if (byEmail) return byEmail;
    }
    return null;
  },

  // ── Create / Upsert ────────────────────────────────────

  /**
   * Find or create a customer. Matches on phone (primary) then email.
   * If found, updates last_seen_at and merges any new fields.
   */
  async findOrCreate(
    tenantId: string,
    data: {
      phone?: string | null;
      email?: string | null;
      display_name?: string | null;
    },
  ): Promise<{ customer: Customer; isNew: boolean }> {
    // Try to find existing
    const existing = await this.findByPhoneOrEmail(
      tenantId,
      data.phone,
      data.email ? data.email.toLowerCase() : null,
    );

    if (existing) {
      // Update last_seen_at and merge any new fields
      const updates: string[] = ['last_seen_at = NOW()'];
      const values: any[] = [];
      let idx = 1;

      if (data.display_name && !existing.display_name) {
        updates.push(`display_name = $${idx}`);
        values.push(data.display_name);
        idx++;
      }
      if (data.phone && !existing.phone) {
        updates.push(`phone = $${idx}`);
        values.push(data.phone);
        idx++;
      }
      if (data.email && !existing.email) {
        updates.push(`email = $${idx}`);
        values.push(data.email.toLowerCase());
        idx++;
      }

      values.push(existing.id);
      const { rows } = await query<Customer>(
        `UPDATE customers SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} RETURNING *`,
        values,
      );
      return { customer: rows[0], isNew: false };
    }

    // Create new customer
    const { rows } = await query<Customer>(
      `INSERT INTO customers (tenant_id, phone, email, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, data.phone ?? null, data.email?.toLowerCase() ?? null, data.display_name ?? null],
    );
    return { customer: rows[0], isNew: true };
  },

  // ── Update ──────────────────────────────────────────────

  async updatePreferences(
    customerId: string,
    prefs: Partial<CustomerPreferences>,
  ): Promise<Customer | null> {
    const { rows } = await query<Customer>(
      `UPDATE customers
       SET preferences = preferences || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [JSON.stringify(prefs), customerId],
    );
    return rows[0] ?? null;
  },

  async incrementBookingCount(customerId: string): Promise<void> {
    await query(
      `UPDATE customers
       SET booking_count = booking_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [customerId],
    );
  },

  async updateDisplayName(customerId: string, name: string): Promise<void> {
    await query(
      `UPDATE customers
       SET display_name = $1, updated_at = NOW()
       WHERE id = $2`,
      [name, customerId],
    );
  },

  async touchLastSeen(customerId: string): Promise<void> {
    await query(
      'UPDATE customers SET last_seen_at = NOW() WHERE id = $1',
      [customerId],
    );
  },

  // ── Soft-Delete (Privacy) ───────────────────────────────

  async softDelete(customerId: string): Promise<boolean> {
    const { rowCount } = await query(
      `UPDATE customers
       SET deleted_at = NOW(),
           display_name = NULL,
           phone = NULL,
           email = NULL,
           preferences = '{}'::jsonb,
           updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [customerId],
    );
    return (rowCount ?? 0) > 0;
  },

  // ── Session Lookup ──────────────────────────────────────

  /**
   * Count chat sessions linked to a customer.
   */
  async countSessions(customerId: string): Promise<number> {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM chat_sessions
       WHERE customer_id = $1`,
      [customerId],
    );
    return parseInt(rows[0].count, 10);
  },
};
