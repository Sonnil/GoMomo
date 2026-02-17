// ============================================================
// Datetime Resolver — Unit Tests
// ============================================================
// Verifies deterministic date/time resolution for booking intents.
//
// Uses overrideNow() from clock.ts to pin "now" for reproducibility.
// All assertions use UTC ISO strings converted from a known timezone.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveDatetime, type DatetimeResolverInput } from '../src/agent/datetime-resolver.js';
import { overrideNow, resetClock } from '../src/services/clock.js';
import type { BusinessHours } from '../src/domain/types.js';

// ── Test Fixtures ───────────────────────────────────────────

// Pin "now" to Wednesday, February 11, 2026 at 10:00 AM Eastern (ET = UTC-5)
// UTC: 2026-02-11T15:00:00.000Z
const FIXED_NOW = new Date('2026-02-11T15:00:00.000Z');
const TZ = 'America/New_York'; // ET = UTC-5 in winter

const BIZ_HOURS: BusinessHours = {
  monday:    { start: '09:00', end: '17:00' },
  tuesday:   { start: '09:00', end: '17:00' },
  wednesday: { start: '09:00', end: '17:00' },
  thursday:  { start: '09:00', end: '17:00' },
  friday:    { start: '09:00', end: '17:00' },
  saturday:  null,
  sunday:    null,
};

function makeInput(userMessage: string, overrides?: Partial<DatetimeResolverInput>): DatetimeResolverInput {
  return {
    userMessage,
    clientMeta: { client_tz: TZ },
    tenantTimezone: TZ,
    businessHours: BIZ_HOURS,
    ...overrides,
  };
}

// ── Setup / Teardown ────────────────────────────────────────

beforeEach(() => {
  overrideNow(() => FIXED_NOW);
});

afterEach(() => {
  resetClock();
});

// ── Tests ───────────────────────────────────────────────────

describe('resolveDatetime', () => {
  // ── Spec case 1: "today at 3pm" ──────────────────────────
  describe('"today at 3pm"', () => {
    it('resolves to today 15:00 ET → UTC', () => {
      const result = resolveDatetime(makeInput('I want to book today at 3pm'));
      expect(result).not.toBeNull();
      // 3pm ET on Feb 11 2026 = 20:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T20:00:00.000Z');
      expect(result!.confidence).toBe('high');
      expect(result!.reasons).toContain('date=today');
    });

    it('includes end_iso (+1 hour)', () => {
      const result = resolveDatetime(makeInput('book today at 3pm'));
      expect(result!.end_iso).toBe('2026-02-11T21:00:00.000Z');
    });
  });

  // ── Spec case 2: "tomorrow at 10am" ──────────────────────
  describe('"tomorrow at 10am"', () => {
    it('resolves to tomorrow 10:00 ET → UTC', () => {
      const result = resolveDatetime(makeInput('Can I book tomorrow at 10am?'));
      expect(result).not.toBeNull();
      // 10am ET on Feb 12 2026 = 15:00 UTC
      expect(result!.start_iso).toBe('2026-02-12T15:00:00.000Z');
      expect(result!.confidence).toBe('high');
      expect(result!.reasons).toContain('date=tomorrow');
    });
  });

  // ── Spec case 3: "next monday at 2" ──────────────────────
  describe('"next monday at 2"', () => {
    it('resolves to next Monday 14:00 ET → UTC (ambiguous hour assumed PM)', () => {
      const result = resolveDatetime(makeInput('book me in next monday at 2'));
      expect(result).not.toBeNull();
      // Next Monday from Wed Feb 11 = Feb 16 (Mon)
      // "at 2" with no am/pm → assumed PM = 14:00 ET = 19:00 UTC
      expect(result!.start_iso).toBe('2026-02-16T19:00:00.000Z');
      expect(result!.confidence).toBe('high');
      expect(result!.reasons).toContain('date=next_monday');
    });
  });

  // ── Spec case 4: "next friday at 2pm" ─────────────────────
  describe('"next friday at 2pm"', () => {
    it('resolves to next Friday 14:00 ET → UTC', () => {
      const result = resolveDatetime(makeInput('schedule next friday at 2pm'));
      expect(result).not.toBeNull();
      // Next Friday from Wed Feb 11 = Feb 13 (Fri)
      // 14:00 ET = 19:00 UTC
      expect(result!.start_iso).toBe('2026-02-13T19:00:00.000Z');
      expect(result!.confidence).toBe('high');
    });
  });

  // ── Period-of-day keywords ────────────────────────────────
  describe('period-of-day keywords', () => {
    it('"today morning" → business open hour', () => {
      const result = resolveDatetime(makeInput('book today morning'));
      expect(result).not.toBeNull();
      // Morning = business open (09:00 ET) = 14:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T14:00:00.000Z');
      expect(result!.confidence).toBe('medium');
    });

    it('"tomorrow afternoon" → 14:00', () => {
      const result = resolveDatetime(makeInput('book tomorrow afternoon'));
      expect(result).not.toBeNull();
      // 14:00 ET on Feb 12 = 19:00 UTC
      expect(result!.start_iso).toBe('2026-02-12T19:00:00.000Z');
      expect(result!.confidence).toBe('medium');
    });

    it('"today evening" → 17:00', () => {
      const result = resolveDatetime(makeInput('book today this evening'));
      expect(result).not.toBeNull();
      // 17:00 ET = 22:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T22:00:00.000Z');
      expect(result!.confidence).toBe('medium');
    });
  });

  // ── Timezone handling ─────────────────────────────────────
  describe('timezone handling', () => {
    it('prefers client timezone over tenant timezone', () => {
      const result = resolveDatetime(makeInput('today at 3pm', {
        clientMeta: { client_tz: 'Europe/London' }, // UTC+0 in winter
        tenantTimezone: 'America/New_York',
      }));
      expect(result).not.toBeNull();
      // 3pm London = 15:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T15:00:00.000Z');
      expect(result!.reasons).toContain('timezone=Europe/London');
    });

    it('falls back to tenant timezone when client tz is missing', () => {
      const result = resolveDatetime(makeInput('today at 3pm', {
        clientMeta: {},
        tenantTimezone: 'America/Chicago', // CT = UTC-6
      }));
      expect(result).not.toBeNull();
      // 3pm Chicago = 21:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T21:00:00.000Z');
      expect(result!.reasons).toContain('timezone=America/Chicago');
    });

    it('falls back to tenant timezone when client tz is invalid', () => {
      const result = resolveDatetime(makeInput('today at 3pm', {
        clientMeta: { client_tz: 'Invalid/Zone' },
        tenantTimezone: 'America/New_York',
      }));
      expect(result).not.toBeNull();
      // Falls back to ET: 3pm ET = 20:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T20:00:00.000Z');
    });
  });

  // ── Edge cases ────────────────────────────────────────────
  describe('edge cases', () => {
    it('returns null for messages with no time expression', () => {
      const result = resolveDatetime(makeInput('I want to book an appointment'));
      expect(result).toBeNull();
    });

    it('returns null for date-only (no time) — LLM should ask for time', () => {
      const result = resolveDatetime(makeInput('book something for tomorrow'));
      expect(result).toBeNull();
    });

    it('returns null for gibberish', () => {
      const result = resolveDatetime(makeInput('asdfghjkl'));
      expect(result).toBeNull();
    });

    it('"day after tomorrow at 9am"', () => {
      const result = resolveDatetime(makeInput('book day after tomorrow at 9am'));
      expect(result).not.toBeNull();
      // Feb 13, 9am ET = 14:00 UTC
      expect(result!.start_iso).toBe('2026-02-13T14:00:00.000Z');
      expect(result!.reasons).toContain('date=day_after_tomorrow');
    });

    it('"at 10:30am" with "today" implied — no date → returns null', () => {
      // Time-only without a date keyword → null (let LLM ask "which day?")
      const result = resolveDatetime(makeInput('at 10:30am'));
      expect(result).toBeNull();
    });

    it('handles 12pm correctly (noon, not midnight)', () => {
      const result = resolveDatetime(makeInput('book today at 12pm'));
      expect(result).not.toBeNull();
      // 12pm ET = 17:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T17:00:00.000Z');
    });

    it('handles 12am correctly (midnight)', () => {
      const result = resolveDatetime(makeInput('book tomorrow at 12am'));
      expect(result).not.toBeNull();
      // 12am ET on Feb 12 = 05:00 UTC on Feb 12
      expect(result!.start_iso).toBe('2026-02-12T05:00:00.000Z');
    });
  });

  // ── Bare day name + time ──────────────────────────────────
  describe('bare day name with time', () => {
    it('"wednesday at 4pm" (same day) → today 16:00', () => {
      // Now is Wednesday — same day
      const result = resolveDatetime(makeInput('wednesday at 4pm'));
      expect(result).not.toBeNull();
      // 4pm ET = 21:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T21:00:00.000Z');
      expect(result!.confidence).toBe('medium');
    });

    it('"friday at 11am" → next Friday', () => {
      const result = resolveDatetime(makeInput('friday at 11am'));
      expect(result).not.toBeNull();
      // Next Friday from Wed = Feb 13, 11am ET = 16:00 UTC
      expect(result!.start_iso).toBe('2026-02-13T16:00:00.000Z');
    });
  });

  // ── Reasons array ─────────────────────────────────────────
  describe('reasons array', () => {
    it('includes date, time, and timezone reasons', () => {
      const result = resolveDatetime(makeInput('book tomorrow at 10am'));
      expect(result).not.toBeNull();
      expect(result!.reasons).toEqual(
        expect.arrayContaining([
          'date=tomorrow',
          expect.stringContaining('time='),
          expect.stringContaining('timezone='),
        ]),
      );
    });
  });

  // ── No business hours provided ────────────────────────────
  describe('no business hours', () => {
    it('"today morning" defaults to 09:00 when no biz hours', () => {
      const result = resolveDatetime(makeInput('book today morning', {
        businessHours: undefined,
      }));
      expect(result).not.toBeNull();
      // Default morning = 09:00 ET = 14:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T14:00:00.000Z');
    });
  });

  // ── TASK 1: Booking-only guardrails ───────────────────────
  // resolveDatetime() is a pure parser — it returns null when
  // the message contains no recognisable date/time expression.
  // The booking-only guard lives in chat-router.ts (it only
  // calls resolveDatetime when intent=BOOK_DEMO or state=BOOKING_FLOW).
  // These tests confirm the parser itself does NOT hallucinate
  // dates from non-booking messages.
  describe('booking-only guardrails (no false positives)', () => {
    it('"how much does it cost?" → no resolvedDatetime', () => {
      const result = resolveDatetime(makeInput('how much does it cost?'));
      expect(result).toBeNull();
    });

    it('"today is a good day" → no resolvedDatetime (no time component)', () => {
      // Contains "today" but no time → resolver returns null
      // (date-only without time is insufficient for booking)
      const result = resolveDatetime(makeInput('today is a good day'));
      expect(result).toBeNull();
    });

    it('"book demo today at 3pm" → resolvedDatetime injected', () => {
      const result = resolveDatetime(makeInput('book demo today at 3pm'));
      expect(result).not.toBeNull();
      // 3pm ET on Wed Feb 11 2026 = 20:00 UTC
      expect(result!.start_iso).toBe('2026-02-11T20:00:00.000Z');
      expect(result!.confidence).toBe('high');
      expect(result!.reasons).toContain('date=today');
    });
  });

  // ── TASK 2: E2E-style "Sunday" bug regression test ────────
  // The original bug: LLM hallucinates "today is Sunday" even
  // when the client's actual date is a weekday (e.g. Tuesday
  // Feb 17, 2026). The deterministic resolver prevents this
  // by anchoring to the client's real clock + timezone.
  describe('"Sunday" hallucination regression', () => {
    it('"today at 3pm" with client_now on Tuesday 2026-02-17 → resolves to Feb 17 15:00 ET', () => {
      // Pin clock to Tuesday, Feb 17, 2026, 10:00 AM ET (= 15:00 UTC)
      const tuesdayNow = new Date('2026-02-17T15:00:00.000Z');
      overrideNow(() => tuesdayNow);

      const result = resolveDatetime({
        userMessage: 'today at 3pm',
        clientMeta: {
          client_now_iso: '2026-02-17T10:00:00-05:00',
          client_tz: 'America/New_York',
        },
        tenantTimezone: 'America/New_York',
        businessHours: BIZ_HOURS,
      });

      expect(result).not.toBeNull();
      // 3pm ET on Feb 17 = 20:00 UTC
      expect(result!.start_iso).toBe('2026-02-17T20:00:00.000Z');
      expect(result!.confidence).toBe('high');
      expect(result!.reasons).toContain('date=today');

      // Verify it's the SAME calendar date (Feb 17), not Sunday (Feb 15)
      const resolved = new Date(result!.start_iso);
      expect(resolved.getUTCDate()).toBe(17);  // Feb 17
      expect(resolved.getUTCHours()).toBe(20);  // 3pm ET = 20:00 UTC
      // getDay() for Feb 17, 2026 = 2 (Tuesday) — NOT 0 (Sunday)
      expect(resolved.getUTCDay()).toBe(2);
    });

    it('"today at 3pm" with client in Pacific time → resolves to same calendar date in PT', () => {
      // Pin clock to Tuesday, Feb 17, 2026, 10:00 AM PT (= 18:00 UTC)
      const tuesdayNowPT = new Date('2026-02-17T18:00:00.000Z');
      overrideNow(() => tuesdayNowPT);

      const result = resolveDatetime({
        userMessage: 'today at 3pm',
        clientMeta: {
          client_now_iso: '2026-02-17T10:00:00-08:00',
          client_tz: 'America/Los_Angeles',
        },
        tenantTimezone: 'America/New_York',
        businessHours: BIZ_HOURS,
      });

      expect(result).not.toBeNull();
      // 3pm PT = 23:00 UTC
      expect(result!.start_iso).toBe('2026-02-17T23:00:00.000Z');
      expect(result!.reasons).toContain('timezone=America/Los_Angeles');
    });
  });
});
