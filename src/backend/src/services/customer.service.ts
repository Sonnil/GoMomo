// ============================================================
// Customer Identity Service
//
// Orchestrates customer resolution, preference learning,
// and returning-customer context injection.
//
// Cross-channel flow:
//   SMS → resolveByPhone → link session → inject context
//   Web → resolveByEmail (from confirm_booking) → link session
// ============================================================

import { customerRepo } from '../repos/customer.repo.js';
import type { Customer, CustomerPreferences, ReturningCustomerContext } from '../domain/types.js';
import { normalizePhone as normalizePhoneStrict } from '../voice/phone-normalizer.js';

// ── Phone Normalization ─────────────────────────────────────

/**
 * Normalize a phone number to E.164 format.
 * Delegates to the canonical implementation in voice/phone-normalizer.ts.
 *
 * Returns the normalized E.164 string, or the raw input as fallback
 * (for backward compatibility with existing customer records).
 */
export function normalizePhone(raw: string): string {
  return normalizePhoneStrict(raw) ?? raw;
}

/**
 * Normalize email to lowercase, trimmed.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// ── Customer Resolution ─────────────────────────────────────

export const customerService = {
  /**
   * Resolve or create a customer from a phone number (SMS channel).
   */
  async resolveByPhone(
    phone: string,
    tenantId: string,
  ): Promise<{ customer: Customer; isNew: boolean }> {
    const normalized = normalizePhone(phone);
    return customerRepo.findOrCreate(tenantId, { phone: normalized });
  },

  /**
   * Resolve or create a customer from an email (web chat booking).
   */
  async resolveByEmail(
    email: string,
    tenantId: string,
    displayName?: string,
  ): Promise<{ customer: Customer; isNew: boolean }> {
    const normalized = normalizeEmail(email);
    return customerRepo.findOrCreate(tenantId, {
      email: normalized,
      display_name: displayName,
    });
  },

  /**
   * Resolve from booking details — merges phone + email if both exist.
   * Called after confirm_booking to link identity.
   */
  async resolveFromBooking(
    tenantId: string,
    data: {
      email: string;
      name: string;
      phone?: string | null;
      service?: string | null;
    },
  ): Promise<Customer> {
    const normalizedEmail = normalizeEmail(data.email);
    const normalizedPhone = data.phone ? normalizePhone(data.phone) : null;

    // Try to find by email first (most reliable from bookings)
    let customer = await customerRepo.findByEmail(normalizedEmail, tenantId);

    if (!customer && normalizedPhone) {
      // Maybe they started on SMS — find by phone and merge email
      customer = await customerRepo.findByPhone(normalizedPhone, tenantId);
      if (customer && !customer.email) {
        // Merge email onto existing phone-based record
        const { query } = await import('../db/client.js');
        await query(
          `UPDATE customers SET email = $1, display_name = COALESCE(display_name, $2), updated_at = NOW()
           WHERE id = $3`,
          [normalizedEmail, data.name, customer.id],
        );
      }
    }

    if (!customer) {
      const result = await customerRepo.findOrCreate(tenantId, {
        email: normalizedEmail,
        phone: normalizedPhone,
        display_name: data.name,
      });
      customer = result.customer;
    }

    // Update name if we have a better one
    if (data.name && (!customer.display_name || customer.display_name !== data.name)) {
      await customerRepo.updateDisplayName(customer.id, data.name);
    }

    // Learn service preference
    if (data.service) {
      await customerRepo.updatePreferences(customer.id, {
        preferred_service: data.service,
      });
    }

    // Increment booking count
    await customerRepo.incrementBookingCount(customer.id);

    return customer;
  },

  /**
   * Build returning-customer context for system prompt injection.
   * Returns null if the customer is new or has no meaningful history.
   */
  async getReturningContext(
    customerId: string,
  ): Promise<ReturningCustomerContext | null> {
    const customer = await customerRepo.findById(customerId);
    if (!customer) return null;

    // A "returning" customer has at least 1 prior booking
    if (customer.booking_count < 1) return null;

    const sessionCount = await customerRepo.countSessions(customerId);

    return {
      customer_id: customer.id,
      display_name: customer.display_name,
      booking_count: customer.booking_count,
      preferences: customer.preferences,
      previous_sessions: sessionCount,
    };
  },

  /**
   * Learn preferences from a booking confirmation.
   */
  async learnFromBooking(
    customerId: string,
    data: {
      service?: string | null;
      timezone?: string;
    },
  ): Promise<void> {
    const updates: Partial<CustomerPreferences> = {};

    if (data.service) updates.preferred_service = data.service;
    if (data.timezone) updates.timezone = data.timezone;

    if (Object.keys(updates).length > 0) {
      await customerRepo.updatePreferences(customerId, updates);
    }
  },

  /**
   * Soft-delete a customer (GDPR / privacy request).
   * Clears PII from the customer record. Sessions remain but are unlinked.
   */
  async deleteCustomer(customerId: string): Promise<boolean> {
    // Unlink all sessions
    const { query } = await import('../db/client.js');
    await query(
      `UPDATE chat_sessions SET customer_id = NULL WHERE customer_id = $1`,
      [customerId],
    );

    return customerRepo.softDelete(customerId);
  },
};
