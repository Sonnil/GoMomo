// ============================================================
// Cancel Verification — Unit Tests
//
// Tests for the pure verifyCancellation() function.
//
//  1. Returns missing_ref_code when no reference code provided
//  2. Returns reference_not_found when booking doesn't exist
//  3. Returns reference_not_found when booking is not confirmed
//  4. Path A: succeeds via verified session — email match
//  5. Path A: succeeds via verified session — phone match
//  6. Path A: session verified but customer doesn't match → falls through to Path B
//  7. Path B: succeeds via phone_last4 match
//  8. Path B: fails with phone_last4_mismatch
//  9. Path B: fails with invalid_last4_format (not 4 digits)
// 10. Path B: fails with no_phone_on_booking
// 11. Returns missing_verification when no session match and no phone_last4 provided
// 12. Session not verified → skips Path A, falls through to Path B
// 13. No enumeration: unverified + no last4 → can't learn if ref exists
// ============================================================

import { describe, it, expect } from 'vitest';
import { verifyCancellation, extractPhoneLast4 } from '../src/agent/cancel-verification.js';
import type { CancelVerificationDeps } from '../src/agent/cancel-verification.js';
import type { Appointment } from '../src/domain/types.js';

// ── Test fixtures ─────────────────────────────────────────

const CONFIRMED_BOOKING: Appointment = {
  id: 'apt-1',
  tenant_id: 'tenant-1',
  reference_code: 'APT-Z8L2K6',
  client_name: 'Jane Doe',
  client_email: 'jane@example.com',
  client_phone: '+15559876543',
  client_notes: null,
  service: 'Initial Consultation',
  start_time: new Date('2025-03-15T10:00:00Z'),
  end_time: new Date('2025-03-15T11:00:00Z'),
  timezone: 'America/New_York',
  status: 'confirmed',
  google_event_id: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const NO_PHONE_BOOKING: Appointment = {
  ...CONFIRMED_BOOKING,
  id: 'apt-no-phone',
  client_phone: null,
};

function makeDeps(overrides?: Partial<CancelVerificationDeps>): CancelVerificationDeps {
  return {
    lookupByReference: async () => CONFIRMED_BOOKING,
    getSessionCustomer: async () => null,
    getCustomerContact: async () => null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('verifyCancellation — pure function', () => {
  it('returns missing_ref_code when no reference code provided', async () => {
    const result = await verifyCancellation(
      { referenceCode: '', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps(),
    );
    expect(result).toEqual({ ok: false, reason: 'missing_ref_code' });
  });

  it('returns reference_not_found when booking does not exist', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'FAKE-CODE', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps({ lookupByReference: async () => null }),
    );
    expect(result).toEqual({ ok: false, reason: 'reference_not_found' });
  });

  it('returns reference_not_found when booking is cancelled (not confirmed)', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps({
        lookupByReference: async () => ({ ...CONFIRMED_BOOKING, status: 'cancelled' }),
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'reference_not_found' });
  });

  // ── Path A: Verified session ─────────────────────────────

  it('Path A: succeeds via verified session — email match', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps({
        getSessionCustomer: async () => ({ customerId: 'cust-1', emailVerified: true }),
        getCustomerContact: async () => ({ email: 'jane@example.com', phone: null }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      method: 'verified_session',
      booking: CONFIRMED_BOOKING,
    });
  });

  it('Path A: succeeds via verified session — phone match', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps({
        getSessionCustomer: async () => ({ customerId: 'cust-1', emailVerified: true }),
        getCustomerContact: async () => ({ email: 'different@example.com', phone: '+15559876543' }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      method: 'verified_session',
      booking: CONFIRMED_BOOKING,
    });
  });

  it('Path A: email comparison is case-insensitive', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps({
        getSessionCustomer: async () => ({ customerId: 'cust-1', emailVerified: true }),
        getCustomerContact: async () => ({ email: 'JANE@EXAMPLE.COM', phone: null }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe('verified_session');
    }
  });

  it('Path A: session verified but customer does not match booking → falls through', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps({
        getSessionCustomer: async () => ({ customerId: 'cust-999', emailVerified: true }),
        getCustomerContact: async () => ({ email: 'other@example.com', phone: '+10000000000' }),
      }),
    );
    // Falls through to missing_verification since no phone_last4 provided
    expect(result).toEqual({ ok: false, reason: 'missing_verification' });
  });

  it('Path A: session verified, customer mismatch, but phone_last4 provided → Path B kicks in', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1', phoneLast4: '6543' },
      makeDeps({
        getSessionCustomer: async () => ({ customerId: 'cust-999', emailVerified: true }),
        getCustomerContact: async () => ({ email: 'other@example.com', phone: '+10000000000' }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      method: 'phone_last4',
      booking: CONFIRMED_BOOKING,
    });
  });

  // ── Path B: Phone last 4 ────────────────────────────────

  it('Path B: succeeds via phone_last4 match', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1', phoneLast4: '6543' },
      makeDeps(),
    );
    expect(result).toEqual({
      ok: true,
      method: 'phone_last4',
      booking: CONFIRMED_BOOKING,
    });
  });

  it('Path B: fails with phone_last4_mismatch', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1', phoneLast4: '0000' },
      makeDeps(),
    );
    expect(result).toEqual({ ok: false, reason: 'phone_last4_mismatch' });
  });

  it('Path B: fails with invalid_last4_format (not 4 digits)', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1', phoneLast4: '12' },
      makeDeps(),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_last4_format' });
  });

  it('Path B: fails with invalid_last4_format (letters)', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1', phoneLast4: 'abcd' },
      makeDeps(),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_last4_format' });
  });

  it('Path B: fails with no_phone_on_booking when booking has no phone', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1', phoneLast4: '1234' },
      makeDeps({ lookupByReference: async () => NO_PHONE_BOOKING }),
    );
    expect(result).toEqual({ ok: false, reason: 'no_phone_on_booking' });
  });

  // ── Missing verification ─────────────────────────────────

  it('returns missing_verification when no session match and no phone_last4', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps(),
    );
    expect(result).toEqual({ ok: false, reason: 'missing_verification' });
  });

  it('session not verified → skips Path A, falls through to missing_verification', async () => {
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps({
        getSessionCustomer: async () => ({ customerId: 'cust-1', emailVerified: false }),
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'missing_verification' });
  });

  // ── Anti-enumeration ─────────────────────────────────────

  it('no enumeration: unverified + no last4 → missing_verification (not reference_not_found)', async () => {
    // Even when the booking DOES exist, if the user isn't verified
    // they get missing_verification, not a clue about the ref code
    const result = await verifyCancellation(
      { referenceCode: 'APT-Z8L2K6', tenantId: 'tenant-1', sessionId: 's1' },
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_verification');
    }
  });
});

// ── extractPhoneLast4 ──────────────────────────────────────

describe('extractPhoneLast4', () => {
  it('extracts last 4 digits from E.164 phone', () => {
    expect(extractPhoneLast4('+15559876543')).toBe('6543');
  });

  it('extracts last 4 digits from formatted phone', () => {
    expect(extractPhoneLast4('(555) 987-6543')).toBe('6543');
  });

  it('returns null for short input', () => {
    expect(extractPhoneLast4('123')).toBeNull();
  });

  it('handles digits-only input', () => {
    expect(extractPhoneLast4('6543')).toBe('6543');
  });
});
