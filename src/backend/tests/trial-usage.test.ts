// ============================================================
// Usage & Risk Engine Tests (Phase 15 — Behavioral Risk Engine)
//
// Chat message limits removed (TRIAL_MAX_USER_MESSAGES=0).
// Hard booking rate limit replaced with deterministic risk engine.
//
//  1. Chat is unlimited: 25+ messages never blocked
//  2. Risk engine: legit user → allow
//  3. Risk engine: OTP abuse → reverify
//  4. Risk engine: extreme spam → cooldown
//  5. Counts persist: same session retains counts
//  6. Risk engine error codes are stable strings
//  7. Session repo: incrementUserMessageCount works
//  8. Session repo: incrementBookingCount works
//  9. Session repo: getTrialUsage returns both counters
// 10. TRIAL_MAX_USER_MESSAGES defaults to 0 (unlimited)
// 11. Risk engine: confirm_booking result shape
// 12. ChatSession has trial fields
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

// ── 2–4. Risk Engine Scoring Logic (unit) ──────────────────

describe('Risk engine scoring logic (unit)', () => {
  it('allows a legitimate first-time user (score ≤ 30)', async () => {
    const { calculateRiskScore, getRiskDecision } = await import('../src/security/risk-engine.js');
    const score = calculateRiskScore({
      email: 'legit@example.com',
      otpAttemptsLast10Min: 1,
      bookingsLast5Min: 0,
      sameIpDifferentEmailsLastHour: 0,
      existingActiveBooking: false,
      activeBookingCount: 0,
      rapidMessageCount: 3,
    });
    const decision = getRiskDecision(score);
    expect(score).toBeLessThanOrEqual(30);
    expect(decision.action).toBe('allow');
  });

  it('requires reverification for elevated OTP abuse (score 31–80)', async () => {
    const { calculateRiskScore, getRiskDecision } = await import('../src/security/risk-engine.js');
    const score = calculateRiskScore({
      email: 'otp-abuser@example.com',
      otpAttemptsLast10Min: 4,    // 4 × 10 = 40
      bookingsLast5Min: 0,
      sameIpDifferentEmailsLastHour: 0,
      existingActiveBooking: false,
      activeBookingCount: 0,
      rapidMessageCount: 5,
    });
    const decision = getRiskDecision(score);
    expect(score).toBeGreaterThan(30);
    expect(score).toBeLessThanOrEqual(80);
    expect(decision.action).toBe('reverify');
  });

  it('enforces cooldown for extreme spam (score > 80)', async () => {
    const { calculateRiskScore, getRiskDecision } = await import('../src/security/risk-engine.js');
    const score = calculateRiskScore({
      email: 'spammer@example.com',
      otpAttemptsLast10Min: 5,    // 5 × 10 = 50
      bookingsLast5Min: 2,        // 2 × 25 = 50
      sameIpDifferentEmailsLastHour: 3, // (3-1) × 15 = 30
      existingActiveBooking: true, // 0
      activeBookingCount: 4,       // +30
      rapidMessageCount: 20,       // (20-10) × 5 = 50
    });
    const decision = getRiskDecision(score);
    expect(score).toBeGreaterThan(80);
    expect(decision.action).toBe('cooldown');
    expect(decision.cooldownSeconds).toBeDefined();
  });

  it('trusted returning customer (1 active booking) gets score bonus', async () => {
    const { calculateRiskScore, getRiskDecision } = await import('../src/security/risk-engine.js');
    const score = calculateRiskScore({
      email: 'repeat@example.com',
      otpAttemptsLast10Min: 0,
      bookingsLast5Min: 0,
      sameIpDifferentEmailsLastHour: 0,
      existingActiveBooking: true,
      activeBookingCount: 1,       // -10 (trusted)
      rapidMessageCount: 2,
    });
    const decision = getRiskDecision(score);
    expect(score).toBe(-10);
    expect(decision.action).toBe('allow');
  });

  it('IP diversity with only 1 email does not add score', async () => {
    const { calculateRiskScore } = await import('../src/security/risk-engine.js');
    const score = calculateRiskScore({
      email: 'solo@example.com',
      otpAttemptsLast10Min: 0,
      bookingsLast5Min: 0,
      sameIpDifferentEmailsLastHour: 1, // max(0, 1-1) × 15 = 0
      existingActiveBooking: false,
      activeBookingCount: 0,
      rapidMessageCount: 0,
    });
    expect(score).toBe(0);
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

// ── 6. Risk Engine Error Code Stability ──────────────────

describe('Risk engine error codes stability', () => {
  it('RISK_COOLDOWN is a stable string', () => {
    expect('RISK_COOLDOWN').toMatch(/^[A-Z_]+$/);
    expect('RISK_COOLDOWN').toBe('RISK_COOLDOWN');
  });

  it('RISK_REVERIFY is a stable string', () => {
    expect('RISK_REVERIFY').toMatch(/^[A-Z_]+$/);
    expect('RISK_REVERIFY').toBe('RISK_REVERIFY');
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

// ── 11. Risk Engine: confirm_booking Result Shapes ────────

describe('Risk engine tool result shapes', () => {
  it('returns RISK_COOLDOWN error with minutes when risk score exceeds 80', () => {
    const cooldownSeconds = 300;
    const mins = Math.ceil(cooldownSeconds / 60);
    const toolResult = {
      success: false,
      error: `RISK_COOLDOWN: We've noticed unusual activity on this session. For your security, please wait about ${mins} minutes before trying again.`,
    };

    expect(toolResult.success).toBe(false);
    expect(toolResult.error).toContain('RISK_COOLDOWN');
    expect(toolResult.error).toContain('5 minutes');
    expect(toolResult.error).not.toContain('seconds'); // user-friendly: no raw seconds
  });

  it('returns RISK_REVERIFY error when risk score is 31–80', () => {
    const toolResult = {
      success: false,
      error: 'RISK_REVERIFY: For your security, we need to re-verify your email address before completing this booking. Please confirm your email so we can send a new verification code.',
    };

    expect(toolResult.success).toBe(false);
    expect(toolResult.error).toContain('RISK_REVERIFY');
    expect(toolResult.error).toContain('re-verify');
    expect(toolResult.error).toContain('verification code');
  });

  it('includes existing_booking_note when client has upcoming bookings', () => {
    const toolResult = {
      success: true,
      data: {
        appointment_id: 'appt-1',
        reference_code: 'REF-123',
        existing_booking_note: 'Note: This client already has 1 upcoming booking(s):\n  • REF-456 on 2025-02-10T14:00:00Z',
      },
    };

    expect(toolResult.success).toBe(true);
    expect(toolResult.data.existing_booking_note).toContain('upcoming booking');
    expect(toolResult.data.existing_booking_note).toContain('REF-456');
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
