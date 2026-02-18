// ============================================================
// Risk Engine Tests (Phase 15 — Behavioral Risk Engine)
//
// Validates the deterministic risk scoring and decision logic
// that replaces the hard 1-per-hour booking rate limit.
//
// Pure unit tests — no database required.
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  calculateRiskScore,
  getRiskDecision,
  activeBookingTierScore,
  type RiskContext,
  type RiskDecision,
} from '../src/security/risk-engine.js';

// ─── Helpers ────────────────────────────────────────────

function makeContext(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    email: 'test@example.com',
    otpAttemptsLast10Min: 0,
    bookingsLast5Min: 0,
    sameIpDifferentEmailsLastHour: 0,
    existingActiveBooking: false,
    activeBookingCount: 0,
    rapidMessageCount: 0,
    ...overrides,
  };
}

// ─── activeBookingTierScore ─────────────────────────────

describe('activeBookingTierScore', () => {
  it('returns 0 for count 0', () => {
    expect(activeBookingTierScore(0)).toBe(0);
  });

  it('returns -10 for count 1 (trusted returning customer)', () => {
    expect(activeBookingTierScore(1)).toBe(-10);
  });

  it('returns +10 for count 2', () => {
    expect(activeBookingTierScore(2)).toBe(10);
  });

  it('returns +10 for count 3', () => {
    expect(activeBookingTierScore(3)).toBe(10);
  });

  it('returns +30 for count 4 (suspicious accumulation)', () => {
    expect(activeBookingTierScore(4)).toBe(30);
  });

  it('returns +30 for count 10', () => {
    expect(activeBookingTierScore(10)).toBe(30);
  });

  it('returns 0 for negative count', () => {
    expect(activeBookingTierScore(-1)).toBe(0);
  });
});

// ─── calculateRiskScore ─────────────────────────────────

describe('calculateRiskScore', () => {
  it('returns 0 for a clean context', () => {
    expect(calculateRiskScore(makeContext())).toBe(0);
  });

  it('scores OTP attempts at 10 points each', () => {
    expect(calculateRiskScore(makeContext({ otpAttemptsLast10Min: 3 }))).toBe(30);
  });

  it('scores recent bookings at 25 points each', () => {
    expect(calculateRiskScore(makeContext({ bookingsLast5Min: 2 }))).toBe(50);
  });

  it('scores IP email diversity at 15 points per additional email (beyond 1)', () => {
    // 1 email from same IP → no extra score
    expect(calculateRiskScore(makeContext({ sameIpDifferentEmailsLastHour: 1 }))).toBe(0);
    // 3 emails → (3-1) × 15 = 30
    expect(calculateRiskScore(makeContext({ sameIpDifferentEmailsLastHour: 3 }))).toBe(30);
  });

  it('existingActiveBooking boolean adds 0 points (weight = 0)', () => {
    expect(calculateRiskScore(makeContext({ existingActiveBooking: true, activeBookingCount: 0 }))).toBe(0);
  });

  it('activeBookingCount=1 subtracts 10 (trusted)', () => {
    const score = calculateRiskScore(makeContext({ existingActiveBooking: true, activeBookingCount: 1 }));
    expect(score).toBe(-10);
  });

  it('activeBookingCount=2 adds 10', () => {
    const score = calculateRiskScore(makeContext({ activeBookingCount: 2 }));
    expect(score).toBe(10);
  });

  it('activeBookingCount=4 adds 30 (suspicious)', () => {
    const score = calculateRiskScore(makeContext({ activeBookingCount: 4 }));
    expect(score).toBe(30);
  });

  it('scores rapid messages at 5 points each beyond threshold of 10', () => {
    // 5 messages → below threshold → 0
    expect(calculateRiskScore(makeContext({ rapidMessageCount: 5 }))).toBe(0);
    // 15 messages → (15-10) × 5 = 25
    expect(calculateRiskScore(makeContext({ rapidMessageCount: 15 }))).toBe(25);
  });

  it('accumulates all signals correctly', () => {
    const score = calculateRiskScore(makeContext({
      otpAttemptsLast10Min: 2,                // 20
      bookingsLast5Min: 1,                     // 25
      sameIpDifferentEmailsLastHour: 2,        // 15
      existingActiveBooking: true,             // 0
      activeBookingCount: 1,                   // -10
      rapidMessageCount: 12,                   // 10
    }));
    expect(score).toBe(20 + 25 + 15 + 0 + (-10) + 10); // 60
  });

  it('handles zero/negative rapid message counts safely', () => {
    expect(calculateRiskScore(makeContext({ rapidMessageCount: 0 }))).toBe(0);
    expect(calculateRiskScore(makeContext({ rapidMessageCount: -5 }))).toBe(0);
  });

  it('handles zero IP diversity safely', () => {
    expect(calculateRiskScore(makeContext({ sameIpDifferentEmailsLastHour: 0 }))).toBe(0);
  });
});

// ─── getRiskDecision ────────────────────────────────────

describe('getRiskDecision', () => {
  it('returns "allow" for score 0', () => {
    const d = getRiskDecision(0);
    expect(d.action).toBe('allow');
    expect(d.score).toBe(0);
    expect(d.cooldownSeconds).toBeUndefined();
  });

  it('returns "allow" for score exactly 30', () => {
    const d = getRiskDecision(30);
    expect(d.action).toBe('allow');
    expect(d.score).toBe(30);
  });

  it('returns "reverify" for score 31', () => {
    const d = getRiskDecision(31);
    expect(d.action).toBe('reverify');
    expect(d.score).toBe(31);
    expect(d.cooldownSeconds).toBeUndefined();
  });

  it('returns "reverify" for score exactly 80', () => {
    const d = getRiskDecision(80);
    expect(d.action).toBe('reverify');
    expect(d.score).toBe(80);
  });

  it('returns "cooldown" for score 81', () => {
    const d = getRiskDecision(81);
    expect(d.action).toBe('cooldown');
    expect(d.score).toBe(81);
    expect(d.cooldownSeconds).toBe(300);
  });

  it('returns "cooldown" for very high scores', () => {
    const d = getRiskDecision(500);
    expect(d.action).toBe('cooldown');
    expect(d.cooldownSeconds).toBe(300);
  });

  it('includes a human-readable reason in all decisions', () => {
    for (const score of [0, 15, 30, 31, 45, 60, 80, 81, 100]) {
      const d = getRiskDecision(score);
      expect(d.reason).toBeTruthy();
      expect(typeof d.reason).toBe('string');
      expect(d.reason.length).toBeGreaterThan(10);
    }
  });

  it('decision type matches RiskDecision interface', () => {
    const d: RiskDecision = getRiskDecision(42);
    expect(d).toHaveProperty('action');
    expect(d).toHaveProperty('score');
    expect(d).toHaveProperty('reason');
    expect(['allow', 'reverify', 'cooldown']).toContain(d.action);
  });
});

// ─── End-to-end scenario tests ──────────────────────────

describe('Risk engine scenarios', () => {
  it('Scenario: legitimate first-time booker → allow', () => {
    const ctx = makeContext({
      otpAttemptsLast10Min: 1,         // 10
      bookingsLast5Min: 0,
      existingActiveBooking: false,
      activeBookingCount: 0,
      rapidMessageCount: 4,
    });
    const score = calculateRiskScore(ctx);
    const decision = getRiskDecision(score);
    expect(score).toBe(10);
    expect(decision.action).toBe('allow');
  });

  it('Scenario: repeat booker with 1 existing appointment → allow (trusted, score -10)', () => {
    const ctx = makeContext({
      otpAttemptsLast10Min: 0,
      bookingsLast5Min: 0,
      existingActiveBooking: true,
      activeBookingCount: 1,           // -10
      rapidMessageCount: 3,
    });
    const score = calculateRiskScore(ctx);
    const decision = getRiskDecision(score);
    expect(score).toBe(-10);
    expect(decision.action).toBe('allow');
  });

  it('Scenario: repeat booker with 2 existing appointments → allow (score 10)', () => {
    const ctx = makeContext({
      otpAttemptsLast10Min: 0,
      bookingsLast5Min: 0,
      existingActiveBooking: true,
      activeBookingCount: 2,           // +10
      rapidMessageCount: 3,
    });
    const score = calculateRiskScore(ctx);
    const decision = getRiskDecision(score);
    expect(score).toBe(10);
    expect(decision.action).toBe('allow');
  });

  it('Scenario: OTP abuse (many attempts, no bookings) → reverify', () => {
    const ctx = makeContext({
      otpAttemptsLast10Min: 4,  // 40
      bookingsLast5Min: 0,
      existingActiveBooking: false,
      activeBookingCount: 0,
      rapidMessageCount: 8,    // below threshold → 0
    });
    const score = calculateRiskScore(ctx);
    const decision = getRiskDecision(score);
    expect(score).toBe(40);
    expect(decision.action).toBe('reverify');
  });

  it('Scenario: booking bomb (multiple bookings + multi-email IP) → cooldown', () => {
    const ctx = makeContext({
      otpAttemptsLast10Min: 2,                // 20
      bookingsLast5Min: 2,                     // 50
      sameIpDifferentEmailsLastHour: 4,        // 45
      existingActiveBooking: true,             // 0
      activeBookingCount: 4,                   // 30
      rapidMessageCount: 20,                   // 50
    });
    const score = calculateRiskScore(ctx);
    const decision = getRiskDecision(score);
    expect(score).toBe(20 + 50 + 45 + 0 + 30 + 50); // 195
    expect(score).toBe(195);
    expect(decision.action).toBe('cooldown');
    expect(decision.cooldownSeconds).toBe(300);
  });

  it('Scenario: rapid chatting only (no booking/OTP abuse) → allow', () => {
    const ctx = makeContext({
      rapidMessageCount: 12,  // (12-10) × 5 = 10
    });
    const score = calculateRiskScore(ctx);
    expect(score).toBe(10);
    expect(getRiskDecision(score).action).toBe('allow');
  });

  it('Scenario: high score but under new cooldown threshold (score 75) → reverify', () => {
    // OTP 5 = 50, activeBookingCount 2 = +10, rapid 13 = 15 → total 75
    const ctx = makeContext({
      otpAttemptsLast10Min: 5,     // 50
      activeBookingCount: 2,       // +10
      rapidMessageCount: 13,      // 15
    });
    const score = calculateRiskScore(ctx);
    expect(score).toBe(75);
    expect(getRiskDecision(score).action).toBe('reverify');
  });

  it('Scenario: boundary — score exactly 80 → reverify (not cooldown)', () => {
    const decision = getRiskDecision(80);
    expect(decision.action).toBe('reverify');
  });

  it('Scenario: boundary — score exactly 81 → cooldown', () => {
    const decision = getRiskDecision(81);
    expect(decision.action).toBe('cooldown');
  });
});
