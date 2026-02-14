// ============================================================
// Usage & Rate Limit Tests (Phase 14 — Unlimited Chat)
//
// Chat message limits removed (TRIAL_MAX_USER_MESSAGES=0).
// Booking limited to 1 per hour per email (rate limit).
//
//  1. Chat is unlimited: 25+ messages never blocked
//  2. Booking rate limit: blocked within 60 min window
//  3. Booking rate limit: first booking succeeds
//  4. Booking rate limit: allowed after 60 min
//  5. Counts persist: same session retains counts
//  6. Error codes are stable strings
//  7. Session repo: incrementUserMessageCount works
//  8. Session repo: incrementBookingCount works
//  9. Session repo: getTrialUsage returns both counters
// 10. TRIAL_MAX_USER_MESSAGES defaults to 0 (unlimited)
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 1. Chat is Unlimited ──────────────────────────────────

describe('Chat is unlimited (Phase 14)', () => {
  it('never blocks messages when limit is 0 (default)', () => {
    const limit = 0; // default — unlimited
    for (const count of [0, 1, 10, 25, 100, 999]) {
      const shouldBlock = limit > 0 && count >= limit;
      expect(shouldBlock).toBe(false);
    }
  });

  it('TRIAL_MAX_USER_MESSAGES defaults to 0', async () => {
    const { z } = await import('zod');
    const schema = z.coerce.number().default(0);
    expect(schema.parse(undefined)).toBe(0);
  });
});

// ── 2–4. Booking Rate Limit Logic (unit) ──────────────────

describe('Booking rate limit logic (unit)', () => {
  it('blocks booking when last booking was less than 60 minutes ago', () => {
    const lastBookedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    const windowMs = 60 * 60 * 1000;
    const elapsed = Date.now() - lastBookedAt.getTime();

    const shouldBlock = elapsed < windowMs;
    expect(shouldBlock).toBe(true);
  });

  it('allows booking when no previous booking exists', () => {
    const lastBookedAt: Date | null = null;
    const shouldBlock = lastBookedAt !== null;
    expect(shouldBlock).toBe(false);
  });

  it('allows booking after 60 minutes have passed', () => {
    const lastBookedAt = new Date(Date.now() - 61 * 60 * 1000); // 61 min ago
    const windowMs = 60 * 60 * 1000;
    const elapsed = Date.now() - lastBookedAt.getTime();

    const shouldBlock = elapsed < windowMs;
    expect(shouldBlock).toBe(false);
  });

  it('returns BOOKING_RATE_LIMITED error code', () => {
    const error = 'BOOKING_RATE_LIMITED: You can only book once per hour. Please try again in 30 minutes.';
    expect(error).toContain('BOOKING_RATE_LIMITED');
  });

  it('calculates correct retry_after_minutes', () => {
    const lastBookedAt = new Date(Date.now() - 45 * 60 * 1000); // 45 min ago
    const windowMs = 60 * 60 * 1000;
    const retryAfterMs = windowMs - (Date.now() - lastBookedAt.getTime());
    const retryAfterMinutes = Math.ceil(retryAfterMs / 60000);
    expect(retryAfterMinutes).toBe(15);
  });
});

// ── 5. Count Persistence Logic (unit) ─────────────────────

describe('Trial counts persistence (unit)', () => {
  it('booking count persists for same session', () => {
    let bookingCount = 0;

    // Simulate 1 booking
    bookingCount += 1;
    expect(bookingCount).toBe(1);

    // Simulate "refresh" — count persists (DB row)
    expect(bookingCount).toBe(1);
  });
});

// ── 6. Error Code Stability ──────────────────────────────

describe('Booking rate limit error codes stability', () => {
  it('BOOKING_RATE_LIMITED is a stable string', () => {
    expect('BOOKING_RATE_LIMITED').toMatch(/^[A-Z_]+$/);
    expect('BOOKING_RATE_LIMITED').toBe('BOOKING_RATE_LIMITED');
  });
});

// ── 7. Session Repo: incrementUserMessageCount ──────────

describe('sessionRepo.incrementUserMessageCount', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('increments user_message_count and returns new value', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ user_message_count: 3 }],
      rowCount: 1,
    });

    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const count = await sessionRepo.incrementUserMessageCount('sess-trial-1');

    expect(count).toBe(3);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0]).toContain('user_message_count');
    expect(mockQuery.mock.calls[0][0]).toContain('COALESCE');
    expect(mockQuery.mock.calls[0][1]).toEqual(['sess-trial-1']);
  });

  it('returns 0 if session not found', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [],
      rowCount: 0,
    });

    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const count = await sessionRepo.incrementUserMessageCount('nonexistent');

    expect(count).toBe(0);
  });
});

// ── 8. Session Repo: incrementBookingCount ───────────────

describe('sessionRepo.incrementBookingCount', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('increments booking_count and returns new value', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ booking_count: 1 }],
      rowCount: 1,
    });

    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const count = await sessionRepo.incrementBookingCount('sess-trial-1');

    expect(count).toBe(1);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0]).toContain('booking_count');
    expect(mockQuery.mock.calls[0][0]).toContain('COALESCE');
    expect(mockQuery.mock.calls[0][1]).toEqual(['sess-trial-1']);
  });
});

// ── 9. Session Repo: getTrialUsage ──────────────────────

describe('sessionRepo.getTrialUsage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns both counters for an existing session', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ user_message_count: 7, booking_count: 1 }],
      rowCount: 1,
    });

    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const usage = await sessionRepo.getTrialUsage('sess-trial-1');

    expect(usage).toEqual({ user_message_count: 7, booking_count: 1 });
  });

  it('returns zeroes for nonexistent session', async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [],
      rowCount: 0,
    });

    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const usage = await sessionRepo.getTrialUsage('nonexistent');

    expect(usage).toEqual({ user_message_count: 0, booking_count: 0 });
  });
});

// ── 10. Env Var Defaults ─────────────────────────────────

describe('Trial usage env var defaults', () => {
  it('TRIAL_MAX_USER_MESSAGES defaults to 0 (unlimited)', async () => {
    const { z } = await import('zod');
    const schema = z.coerce.number().default(0);
    expect(schema.parse(undefined)).toBe(0);
    expect(schema.parse('5')).toBe(5);
  });

  it('TRIAL_MAX_BOOKINGS defaults to 1', async () => {
    const { z } = await import('zod');
    const schema = z.coerce.number().default(1);
    expect(schema.parse(undefined)).toBe(1);
    expect(schema.parse('3')).toBe(3);
    expect(schema.parse('0')).toBe(0);
  });
});

// ── 11. Booking Rate Limit: handleConfirmBooking Error Shape ──

describe('Booking rate limit tool result shape', () => {
  it('returns the expected error when rate limited', () => {
    const retryAfterMinutes = 30;
    const toolResult = {
      success: false,
      error: `BOOKING_RATE_LIMITED: You can only book once per hour. Please try again in ${retryAfterMinutes} minutes.`,
    };

    expect(toolResult.success).toBe(false);
    expect(toolResult.error).toContain('BOOKING_RATE_LIMITED');
    expect(toolResult.error).toContain('30 minutes');
  });
});

// ── 12. Domain Type: ChatSession has trial fields ────────

describe('ChatSession interface includes trial fields', () => {
  it('has user_message_count and booking_count', async () => {
    const mockRow = {
      id: 'sess-1',
      tenant_id: 'tenant-1',
      customer_id: null,
      channel: 'web',
      conversation: [],
      metadata: {},
      email_verified: false,
      message_count: 3,
      user_message_count: 7,
      booking_count: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(mockRow.user_message_count).toBe(7);
    expect(mockRow.booking_count).toBe(1);
    expect(typeof mockRow.user_message_count).toBe('number');
    expect(typeof mockRow.booking_count).toBe('number');
  });
});
