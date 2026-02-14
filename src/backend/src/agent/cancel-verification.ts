// ============================================================
// Cancel Verification — Pure Verification Logic
//
// Two-factor cancellation: reference code + identity proof.
//   Path A: Session is email-verified AND session customer matches booking
//   Path B: User provides last 4 digits of the phone on the booking
//
// No PII leaks: all failure paths return the same generic reason.
// ============================================================

import type { Appointment } from '../domain/types.js';

/** Input to the verification function. */
export interface CancelVerificationInput {
  /** Booking reference code (e.g. APT-Z8L2K6). */
  referenceCode: string;
  /** Tenant ID for scoping the lookup. */
  tenantId: string;
  /** Current chat session ID — used to check verified-session shortcut. */
  sessionId: string;
  /** Last 4 digits of phone provided by the user (fallback verification). */
  phoneLast4?: string | null;
}

/** Successful verification result. */
export interface CancelVerificationOk {
  ok: true;
  /** How the identity was verified. */
  method: 'verified_session' | 'phone_last4';
  /** The appointment that matched. */
  booking: Appointment;
}

/** Failed verification result. */
export interface CancelVerificationFail {
  ok: false;
  /** Machine-readable reason (never shown to user directly). */
  reason:
    | 'missing_ref_code'
    | 'missing_verification'
    | 'reference_not_found'
    | 'session_customer_mismatch'
    | 'phone_last4_mismatch'
    | 'no_phone_on_booking'
    | 'invalid_last4_format';
}

export type CancelVerificationResult = CancelVerificationOk | CancelVerificationFail;

/** Dependencies injected for testability. */
export interface CancelVerificationDeps {
  /** Look up appointment by reference code within a tenant. */
  lookupByReference: (refCode: string, tenantId: string) => Promise<Appointment | null>;
  /** Get the session's customer_id + email-verified status. */
  getSessionCustomer: (sessionId: string) => Promise<{
    customerId: string | null;
    emailVerified: boolean;
  } | null>;
  /** Get the customer's email and phone for matching. */
  getCustomerContact: (customerId: string) => Promise<{
    email: string | null;
    phone: string | null;
  } | null>;
}

/**
 * Verify that a cancellation request is legitimate.
 *
 * Returns `{ ok: true, method, booking }` on success.
 * Returns `{ ok: false, reason }` on failure — reason is internal only,
 * callers MUST map all failures to the same generic user-facing message.
 */
export async function verifyCancellation(
  input: CancelVerificationInput,
  deps: CancelVerificationDeps,
): Promise<CancelVerificationResult> {
  // ── Guard: reference code required ────────────────────────
  if (!input.referenceCode) {
    return { ok: false, reason: 'missing_ref_code' };
  }

  // ── Look up the booking ───────────────────────────────────
  const booking = await deps.lookupByReference(input.referenceCode, input.tenantId);

  if (!booking || booking.status !== 'confirmed') {
    return { ok: false, reason: 'reference_not_found' };
  }

  // ── Path A: Verified session customer match ───────────────
  const sessionInfo = await deps.getSessionCustomer(input.sessionId);

  if (sessionInfo?.emailVerified && sessionInfo.customerId) {
    const contact = await deps.getCustomerContact(sessionInfo.customerId);

    if (contact) {
      // Match by email (case-insensitive) or by phone (E.164)
      const emailMatch =
        contact.email &&
        booking.client_email &&
        contact.email.toLowerCase() === booking.client_email.toLowerCase();

      const phoneMatch =
        contact.phone &&
        booking.client_phone &&
        contact.phone === booking.client_phone;

      if (emailMatch || phoneMatch) {
        return { ok: true, method: 'verified_session', booking };
      }
    }

    // Session is verified but customer doesn't match this booking
    // Fall through to Path B (phone_last4) if provided
  }

  // ── Path B: Last 4 digits of phone ────────────────────────
  if (input.phoneLast4) {
    // Validate format: exactly 4 digits
    if (!/^\d{4}$/.test(input.phoneLast4)) {
      return { ok: false, reason: 'invalid_last4_format' };
    }

    if (!booking.client_phone) {
      // Can't verify by phone if booking has none on file.
      // Return generic reason (same as mismatch) to prevent enumeration.
      return { ok: false, reason: 'no_phone_on_booking' };
    }

    const bookingPhoneLast4 = booking.client_phone.slice(-4);

    if (bookingPhoneLast4 === input.phoneLast4) {
      return { ok: true, method: 'phone_last4', booking };
    }

    return { ok: false, reason: 'phone_last4_mismatch' };
  }

  // ── Neither path succeeded ────────────────────────────────
  return { ok: false, reason: 'missing_verification' };
}

/**
 * Extract last 4 digits from a phone string.
 * Returns null if the input doesn't contain at least 4 digits.
 */
export function extractPhoneLast4(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}
