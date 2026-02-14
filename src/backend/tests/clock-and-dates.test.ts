// ============================================================
// Clock Service + Date Resolution Tests
// ============================================================
// Verifies that:
//  1. Clock service provides correct timezone-aware "now"
//  2. System prompt includes current date/time
//  3. Voice NLU resolves dates correctly relative to frozen clock
//  4. Far-future guardrail computes distance correctly
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getNow,
  getNowUTC,
  formatNow,
  getTodayISO,
  daysFromNow,
  overrideNow,
  resetClock,
} from '../src/services/clock.js';

// Freeze time at Sunday, February 8, 2026 at 2:00 PM Eastern (19:00 UTC)
const FROZEN_UTC = new Date('2026-02-08T19:00:00.000Z');
const TZ = 'America/New_York';

describe('Clock Service', () => {
  beforeEach(() => {
    overrideNow(() => FROZEN_UTC);
  });

  afterEach(() => {
    resetClock();
  });

  it('getNowUTC returns the frozen UTC time', () => {
    const now = getNowUTC();
    expect(now.toISOString()).toBe('2026-02-08T19:00:00.000Z');
  });

  it('getNow returns wall-clock time in tenant timezone', () => {
    const etNow = getNow(TZ);
    // Feb 8, 2026 19:00 UTC = Feb 8, 2026 14:00 ET (EST = UTC-5)
    expect(etNow.getHours()).toBe(14);
    expect(etNow.getDate()).toBe(8);
    expect(etNow.getMonth()).toBe(1); // 0-indexed: 1 = February
    expect(etNow.getFullYear()).toBe(2026);
  });

  it('getTodayISO returns correct date string in timezone', () => {
    expect(getTodayISO(TZ)).toBe('2026-02-08');
  });

  it('getTodayISO handles date boundary (late UTC = next day in eastern)', () => {
    // 2026-02-09 04:00 UTC = 2026-02-08 23:00 ET — still Feb 8 in ET
    overrideNow(() => new Date('2026-02-09T04:00:00.000Z'));
    expect(getTodayISO(TZ)).toBe('2026-02-08');
    // But in UTC it's already Feb 9
    expect(getTodayISO('UTC')).toBe('2026-02-09');
  });

  it('formatNow includes day name and date', () => {
    const s = formatNow(TZ);
    expect(s).toContain('Sunday');
    expect(s).toContain('February 8, 2026');
    expect(s).toContain('2:00 PM');
  });

  describe('daysFromNow', () => {
    it('tomorrow is 1 day from now', () => {
      const tomorrow = new Date('2026-02-09T14:00:00-05:00');
      expect(daysFromNow(tomorrow, TZ)).toBe(1);
    });

    it('today is 0 days from now', () => {
      const today = new Date('2026-02-08T23:59:00-05:00');
      expect(daysFromNow(today, TZ)).toBe(0);
    });

    it('Feb 9 (Monday) is 1 day from Sunday Feb 8', () => {
      const mon = new Date('2026-02-09T10:00:00-05:00');
      expect(daysFromNow(mon, TZ)).toBe(1);
    });

    it('March 10 is 30 days from Feb 8', () => {
      const target = new Date('2026-03-10T10:00:00-05:00');
      expect(daysFromNow(target, TZ)).toBe(30);
    });

    it('April 9 is 60 days from Feb 8', () => {
      const target = new Date('2026-04-09T10:00:00-04:00'); // EDT in April
      expect(daysFromNow(target, TZ)).toBe(60);
    });

    it('Feb 9 2027 is 366 days from Feb 8 2026', () => {
      const target = new Date('2027-02-09T10:00:00-05:00');
      expect(daysFromNow(target, TZ)).toBe(366);
    });

    it('yesterday is -1 day', () => {
      const yesterday = new Date('2026-02-07T10:00:00-05:00');
      expect(daysFromNow(yesterday, TZ)).toBe(-1);
    });
  });
});

// ── System Prompt Date Injection Tests ──────────────────────

describe('System Prompt — Date Injection', () => {
  beforeEach(() => {
    overrideNow(() => FROZEN_UTC);
  });

  afterEach(() => {
    resetClock();
  });

  it('includes current date in system prompt', async () => {
    // Dynamic import to get the module after clock is set
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');

    const mockTenant = {
      id: '00000000-0000-4000-a000-000000000001',
      name: 'Test Wellness',
      slug: 'test',
      timezone: TZ,
      slot_duration: 30,
      business_hours: {
        monday: { start: '09:00', end: '17:00' },
        tuesday: { start: '09:00', end: '17:00' },
        wednesday: null,
        thursday: null,
        friday: null,
        saturday: null,
        sunday: null,
      },
      services: [{ name: 'Consultation', duration: 30 }],
      google_calendar_id: null,
      google_oauth_tokens: null,
      excel_integration: null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const prompt = buildSystemPrompt(mockTenant as any);

    // Must include current date context
    expect(prompt).toContain('CURRENT DATE AND TIME');
    expect(prompt).toContain('2026-02-08');
    expect(prompt).toContain('Sunday');
    expect(prompt).toContain('February 8, 2026');

    // Must include "tomorrow" expansion
    expect(prompt).toContain('Monday, February 9, 2026');

    // Must include nearest-future-date rule
    expect(prompt).toContain('NEAREST future occurrence');
  });
});

// ── Voice NLU detectDate Tests ──────────────────────────────

describe('Voice NLU — detectDate with frozen clock', () => {
  beforeEach(() => {
    overrideNow(() => FROZEN_UTC);
  });

  afterEach(() => {
    resetClock();
  });

  // Re-import to pick up the frozen clock
  async function getDetectDate() {
    const { detectDate } = await import('../src/voice/nlu.js');
    return detectDate;
  }

  it('"tomorrow" resolves to 2026-02-09', async () => {
    const detectDate = await getDetectDate();
    expect(detectDate('I want to come in tomorrow', TZ)).toBe('2026-02-09');
  });

  it('"today" resolves to 2026-02-08', async () => {
    const detectDate = await getDetectDate();
    expect(detectDate('Can I come in today?', TZ)).toBe('2026-02-08');
  });

  it('"monday" resolves to 2026-02-09 (next Monday)', async () => {
    const detectDate = await getDetectDate();
    // Feb 8 is Sunday → next Monday is Feb 9
    expect(detectDate('How about Monday?', TZ)).toBe('2026-02-09');
  });

  it('"February 9th" resolves to 2026-02-09 (not far future)', async () => {
    const detectDate = await getDetectDate();
    expect(detectDate('February 9th please', TZ)).toBe('2026-02-09');
  });

  it('"February 9" without ordinal resolves to 2026-02-09', async () => {
    const detectDate = await getDetectDate();
    expect(detectDate('february 9', TZ)).toBe('2026-02-09');
  });

  it('"Feb 1" resolves to 2027-02-01 (already past this year)', async () => {
    const detectDate = await getDetectDate();
    // Feb 1 2026 is already past (today is Feb 8) → rolls to Feb 1 2027
    expect(detectDate('Feb 1', TZ)).toBe('2027-02-01');
  });

  it('"March 15" resolves to 2026-03-15 (future this year)', async () => {
    const detectDate = await getDetectDate();
    expect(detectDate('March 15th', TZ)).toBe('2026-03-15');
  });
});

// ── Far-Future Guardrail with Frozen Clock ──────────────────

describe('Far-Future Guardrail — timezone-aware distance', () => {
  beforeEach(() => {
    overrideNow(() => FROZEN_UTC);
  });

  afterEach(() => {
    resetClock();
  });

  it('Feb 9 (1 day away) does NOT trigger far-future gate', () => {
    const target = new Date('2026-02-09T14:00:00-05:00');
    const days = daysFromNow(target, TZ);
    expect(days).toBe(1);
    expect(days > 30).toBe(false);
  });

  it('March 15 (35 days away) DOES trigger far-future gate', () => {
    const target = new Date('2026-03-15T14:00:00-05:00');
    const days = daysFromNow(target, TZ);
    expect(days).toBe(35);
    expect(days > 30).toBe(true);
  });

  it('Feb 9 2027 (366 days away) triggers far-future gate', () => {
    const target = new Date('2027-02-09T14:00:00-05:00');
    const days = daysFromNow(target, TZ);
    expect(days).toBe(366);
    expect(days > 30).toBe(true);
  });

  it('Feb 8 (today, 0 days) does NOT trigger', () => {
    const target = new Date('2026-02-08T16:00:00-05:00');
    const days = daysFromNow(target, TZ);
    expect(days).toBe(0);
    expect(days > 30).toBe(false);
  });
});
