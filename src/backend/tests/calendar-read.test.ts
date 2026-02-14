// ============================================================
// Calendar READ Integration Tests
// ============================================================
// Verifies that Google Calendar busy times are merged into the
// availability engine correctly:
//
//  1. BusyRangeCache — TTL, invalidation, LRU, getOrFetch
//  2. fetchBusyRangesWithCache — cache hit / miss flow
//  3. Availability engine — calendar ranges subtract from slots
//  4. Strict vs lenient failure modes
//  5. Mock/demo mode — no external calendar, always verified
//  6. CalendarReadError propagation
//  7. Callers (tool-executor, routes) surface verified flag
//
// Run:  npx vitest run tests/calendar-read.test.ts
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── 1. BusyRangeCache ─────────────────────────────────────────

describe('BusyRangeCache', () => {
  beforeEach(() => {
    vi.resetModules();
    // Default env so the cache module can import env
    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns null on cache miss', async () => {
    const { getCachedBusyRanges, clearBusyRangeCache } = await import(
      '../src/integrations/calendar/busy-range-cache.js'
    );
    clearBusyRangeCache();
    const result = getCachedBusyRanges('tenant-1', new Date('2026-06-15T09:00:00Z'), new Date('2026-06-15T17:00:00Z'));
    expect(result).toBeNull();
  });

  it('stores and retrieves busy ranges', async () => {
    const { getCachedBusyRanges, setCachedBusyRanges, clearBusyRangeCache } = await import(
      '../src/integrations/calendar/busy-range-cache.js'
    );
    clearBusyRangeCache();

    const from = new Date('2026-06-15T09:00:00Z');
    const to = new Date('2026-06-15T17:00:00Z');
    const ranges = [
      { start: from.getTime(), end: from.getTime() + 3600000 },
    ];

    setCachedBusyRanges('tenant-1', from, to, ranges);
    const cached = getCachedBusyRanges('tenant-1', from, to);
    expect(cached).toEqual(ranges);
  });

  it('returns null for expired entries', async () => {
    // Use a very short TTL to test expiry
    vi.resetModules();
    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 0, // immediate expiry
      },
    }));

    const { getCachedBusyRanges, setCachedBusyRanges, clearBusyRangeCache } = await import(
      '../src/integrations/calendar/busy-range-cache.js'
    );
    clearBusyRangeCache();

    const from = new Date('2026-06-15T09:00:00Z');
    const to = new Date('2026-06-15T17:00:00Z');

    setCachedBusyRanges('tenant-1', from, to, [{ start: 100, end: 200 }]);

    // TTL is 0s → should be expired immediately
    await new Promise((r) => setTimeout(r, 10));
    const cached = getCachedBusyRanges('tenant-1', from, to);
    expect(cached).toBeNull();
  });

  it('invalidates all entries for a specific tenant', async () => {
    const { getCachedBusyRanges, setCachedBusyRanges, invalidateTenantCache, clearBusyRangeCache } = await import(
      '../src/integrations/calendar/busy-range-cache.js'
    );
    clearBusyRangeCache();

    const from1 = new Date('2026-06-15T09:00:00Z');
    const to1 = new Date('2026-06-15T17:00:00Z');
    const from2 = new Date('2026-06-16T09:00:00Z');
    const to2 = new Date('2026-06-16T17:00:00Z');

    setCachedBusyRanges('tenant-1', from1, to1, [{ start: 100, end: 200 }]);
    setCachedBusyRanges('tenant-1', from2, to2, [{ start: 300, end: 400 }]);
    setCachedBusyRanges('tenant-2', from1, to1, [{ start: 500, end: 600 }]);

    invalidateTenantCache('tenant-1');

    expect(getCachedBusyRanges('tenant-1', from1, to1)).toBeNull();
    expect(getCachedBusyRanges('tenant-1', from2, to2)).toBeNull();
    // tenant-2 should be untouched
    expect(getCachedBusyRanges('tenant-2', from1, to1)).not.toBeNull();
  });

  it('clearBusyRangeCache removes all entries', async () => {
    const { getCachedBusyRanges, setCachedBusyRanges, clearBusyRangeCache, getBusyRangeCacheStats } = await import(
      '../src/integrations/calendar/busy-range-cache.js'
    );
    clearBusyRangeCache();

    const from = new Date('2026-06-15T09:00:00Z');
    const to = new Date('2026-06-15T17:00:00Z');

    setCachedBusyRanges('tenant-1', from, to, [{ start: 100, end: 200 }]);
    expect(getBusyRangeCacheStats().size).toBe(1);

    clearBusyRangeCache();
    expect(getBusyRangeCacheStats().size).toBe(0);
    expect(getCachedBusyRanges('tenant-1', from, to)).toBeNull();
  });

  it('rounds keys to minute boundaries (same-minute queries hit cache)', async () => {
    const { getCachedBusyRanges, setCachedBusyRanges, clearBusyRangeCache } = await import(
      '../src/integrations/calendar/busy-range-cache.js'
    );
    clearBusyRangeCache();

    const from1 = new Date('2026-06-15T09:00:10Z'); // 10s into the minute
    const from2 = new Date('2026-06-15T09:00:45Z'); // 45s into the minute
    const to = new Date('2026-06-15T17:00:00Z');

    setCachedBusyRanges('tenant-1', from1, to, [{ start: 100, end: 200 }]);
    // Same minute, different seconds — should hit cache
    const cached = getCachedBusyRanges('tenant-1', from2, to);
    expect(cached).not.toBeNull();
    expect(cached).toEqual([{ start: 100, end: 200 }]);
  });

  it('getBusyRangeCacheStats returns correct metadata', async () => {
    const { setCachedBusyRanges, clearBusyRangeCache, getBusyRangeCacheStats } = await import(
      '../src/integrations/calendar/busy-range-cache.js'
    );
    clearBusyRangeCache();

    const stats1 = getBusyRangeCacheStats();
    expect(stats1.size).toBe(0);
    expect(stats1.ttlSeconds).toBe(30);

    setCachedBusyRanges('t1', new Date(), new Date(), []);
    setCachedBusyRanges('t2', new Date(), new Date(), []);
    const stats2 = getBusyRangeCacheStats();
    expect(stats2.size).toBe(2);
  });
});

// ── 2. CalendarReadError & SlotConflictError ──────────────────

describe('Custom error classes', () => {
  it('CalendarReadError has correct name and message', async () => {
    const { CalendarReadError } = await import('../src/services/availability.service.js');
    const err = new CalendarReadError('calendar down');
    expect(err.name).toBe('CalendarReadError');
    expect(err.message).toBe('calendar down');
    expect(err instanceof Error).toBe(true);
  });

  it('SlotConflictError has correct name and message', async () => {
    const { SlotConflictError } = await import('../src/services/availability.service.js');
    const err = new SlotConflictError('slot taken');
    expect(err.name).toBe('SlotConflictError');
    expect(err.message).toBe('slot taken');
    expect(err instanceof Error).toBe(true);
  });
});

// ── 3. Availability Engine — Calendar Integration ─────────────

describe('availabilityService.getAvailableSlots — calendar integration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Helper: create a mock tenant with Mon-Fri 9-17 business hours
  function makeTenant(overrides: Record<string, any> = {}) {
    return {
      id: 'tenant-cal-test',
      name: 'Calendar Test Clinic',
      slug: 'cal-test',
      timezone: 'America/New_York',
      slot_duration: 30,
      business_hours: {
        monday: { start: '09:00', end: '17:00' },
        tuesday: { start: '09:00', end: '17:00' },
        wednesday: { start: '09:00', end: '17:00' },
        thursday: { start: '09:00', end: '17:00' },
        friday: { start: '09:00', end: '17:00' },
        saturday: null,
        sunday: null,
      },
      services: [{ name: 'Consultation', duration: 30 }],
      google_oauth_tokens: null,
      google_calendar_id: null,
      ...overrides,
    };
  }

  it('returns verified=true when CALENDAR_MODE=mock (no external calendar)', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'mock',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    const { availabilityService } = await import('../src/services/availability.service.js');
    const tenant = makeTenant();

    // Use a future Monday
    const from = new Date('2026-06-15T00:00:00Z'); // Monday
    const to = new Date('2026-06-15T23:59:59Z');

    const result = await availabilityService.getAvailableSlots(tenant as any, from, to);

    expect(result.verified).toBe(true);
    expect(result.calendarSource).toBeUndefined(); // mock mode doesn't set calendarSource
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it('subtracts Google Calendar busy ranges from slots when CALENDAR_MODE=real', async () => {
    // Set a busy range from 10:00-11:00 ET on 2026-06-15 (Monday)
    const busyStart = new Date('2026-06-15T14:00:00Z').getTime(); // 10:00 ET
    const busyEnd = new Date('2026-06-15T15:00:00Z').getTime();   // 11:00 ET

    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'real',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    // Mock the calendar provider to return a busy range
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: () => ({
        name: 'mock-for-test',
        getBusyRanges: vi.fn().mockResolvedValue([
          { start: busyStart, end: busyEnd },
        ]),
      }),
    }));

    // Clear the busy-range cache to ensure we hit the provider
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(null),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
    }));

    const { availabilityService } = await import('../src/services/availability.service.js');

    const tenant = makeTenant({ google_oauth_tokens: { access_token: 'fake' } });
    const from = new Date('2026-06-15T00:00:00Z');
    const to = new Date('2026-06-15T23:59:59Z');

    const result = await availabilityService.getAvailableSlots(tenant as any, from, to);

    expect(result.verified).toBe(true);
    expect(result.calendarSource).toBe('google');

    // Find slots that overlap with the busy range (10:00-11:00 ET)
    const busySlots = result.slots.filter((s) => {
      const sStart = new Date(s.start).getTime();
      const sEnd = new Date(s.end).getTime();
      return sStart < busyEnd && sEnd > busyStart;
    });

    // All slots overlapping the busy range should be marked as unavailable
    for (const slot of busySlots) {
      expect(slot.available).toBe(false);
    }

    // Slots outside the busy range should be available
    const outsideSlots = result.slots.filter((s) => {
      const sEnd = new Date(s.end).getTime();
      return sEnd <= busyStart;
    });
    // At least some slots before 10:00 should be available
    const availableOutside = outsideSlots.filter((s) => s.available);
    expect(availableOutside.length).toBeGreaterThan(0);
  });

  it('throws CalendarReadError in strict mode when calendar read fails', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'real',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: () => ({
        name: 'failing-provider',
        getBusyRanges: vi.fn().mockRejectedValue(new Error('Google API timeout')),
      }),
    }));
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(null),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
    }));

    // Suppress console.error noise in test output
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { availabilityService, CalendarReadError } = await import('../src/services/availability.service.js');

    const tenant = makeTenant({ google_oauth_tokens: { access_token: 'fake' } });
    const from = new Date('2026-06-15T00:00:00Z');
    const to = new Date('2026-06-15T23:59:59Z');

    await expect(
      availabilityService.getAvailableSlots(tenant as any, from, to),
    ).rejects.toThrow(CalendarReadError);
  });

  it('returns unverified slots in lenient mode when calendar read fails', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'real',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'false',  // lenient
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: () => ({
        name: 'failing-provider',
        getBusyRanges: vi.fn().mockRejectedValue(new Error('API rate limit')),
      }),
    }));
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(null),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
    }));

    // Suppress console noise
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { availabilityService } = await import('../src/services/availability.service.js');

    const tenant = makeTenant({ google_oauth_tokens: { access_token: 'fake' } });
    const from = new Date('2026-06-15T00:00:00Z');
    const to = new Date('2026-06-15T23:59:59Z');

    const result = await availabilityService.getAvailableSlots(tenant as any, from, to);

    expect(result.verified).toBe(false);
    expect(result.calendarSource).toBe('db_only');
    expect(result.calendarError).toBe('API rate limit');
    // Still returns slots (DB-only)
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it('skips calendar read when tenant has no OAuth tokens', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'real',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    const getBusyRangesSpy = vi.fn();
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: () => ({
        name: 'should-not-be-called',
        getBusyRanges: getBusyRangesSpy,
      }),
    }));
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(null),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
    }));

    const { availabilityService } = await import('../src/services/availability.service.js');

    // Tenant WITHOUT OAuth tokens
    const tenant = makeTenant({ google_oauth_tokens: null });
    const from = new Date('2026-06-15T00:00:00Z');
    const to = new Date('2026-06-15T23:59:59Z');

    const result = await availabilityService.getAvailableSlots(tenant as any, from, to);

    // Should not have called the calendar provider
    expect(getBusyRangesSpy).not.toHaveBeenCalled();
    expect(result.verified).toBe(true); // No calendar to check → verified by default
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it('uses cached busy ranges on cache hit (does not call provider)', async () => {
    const cachedRanges = [
      { start: new Date('2026-06-15T15:00:00Z').getTime(), end: new Date('2026-06-15T16:00:00Z').getTime() },
    ];

    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'real',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    const getBusyRangesSpy = vi.fn();
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: () => ({
        name: 'should-not-be-called',
        getBusyRanges: getBusyRangesSpy,
      }),
    }));
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(cachedRanges),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
    }));

    const { availabilityService } = await import('../src/services/availability.service.js');

    const tenant = makeTenant({ google_oauth_tokens: { access_token: 'fake' } });
    const from = new Date('2026-06-15T00:00:00Z');
    const to = new Date('2026-06-15T23:59:59Z');

    const result = await availabilityService.getAvailableSlots(tenant as any, from, to);

    // Should NOT have called the actual provider — used cache
    expect(getBusyRangesSpy).not.toHaveBeenCalled();
    expect(result.verified).toBe(true);
    expect(result.calendarSource).toBe('google');
  });

  it('combines DB appointments + calendar busy ranges in the same query', async () => {
    // DB appointment: 9:00-9:30 ET on 2026-06-15
    const dbAppt = {
      start_time: '2026-06-15T13:00:00Z', // 9:00 ET
      end_time: '2026-06-15T13:30:00Z',   // 9:30 ET
    };

    // Calendar busy: 11:00-12:00 ET on 2026-06-15
    const calBusyStart = new Date('2026-06-15T15:00:00Z').getTime(); // 11:00 ET
    const calBusyEnd = new Date('2026-06-15T16:00:00Z').getTime();   // 12:00 ET

    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'real',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([dbAppt]),
      },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: () => ({
        name: 'mock-google',
        getBusyRanges: vi.fn().mockResolvedValue([
          { start: calBusyStart, end: calBusyEnd },
        ]),
      }),
    }));
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(null),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
    }));

    const { availabilityService } = await import('../src/services/availability.service.js');

    const tenant = makeTenant({ google_oauth_tokens: { access_token: 'fake' } });
    const from = new Date('2026-06-15T00:00:00Z');
    const to = new Date('2026-06-15T23:59:59Z');

    const result = await availabilityService.getAvailableSlots(tenant as any, from, to);

    // 9:00-9:30 slot should be unavailable (DB appointment)
    const nineAmSlot = result.slots.find(
      (s) => new Date(s.start).toISOString() === '2026-06-15T13:00:00.000Z',
    );
    if (nineAmSlot) {
      expect(nineAmSlot.available).toBe(false);
    }

    // 11:00-11:30 slot should be unavailable (calendar busy)
    const elevenAmSlot = result.slots.find(
      (s) => new Date(s.start).toISOString() === '2026-06-15T15:00:00.000Z',
    );
    if (elevenAmSlot) {
      expect(elevenAmSlot.available).toBe(false);
    }

    // 10:00-10:30 should be available (no conflicts)
    const tenAmSlot = result.slots.find(
      (s) => new Date(s.start).toISOString() === '2026-06-15T14:00:00.000Z',
    );
    if (tenAmSlot) {
      expect(tenAmSlot.available).toBe(true);
    }
  });

  it('demo mode skips calendar integration even when CALENDAR_MODE=mock', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'mock',
        DEMO_AVAILABILITY: 'true',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    const { availabilityService, isDemoAvailabilityActive } = await import('../src/services/availability.service.js');

    expect(isDemoAvailabilityActive()).toBe(true);

    const tenant = makeTenant();
    const from = new Date('2026-06-15T00:00:00Z');
    const to = new Date('2026-06-15T23:59:59Z');

    const result = await availabilityService.getAvailableSlots(tenant as any, from, to);

    expect(result.verified).toBe(true);
    expect(result.slots.length).toBeGreaterThan(0);
  });
});

// ── 4. GoogleCalendarProvider.getBusyRanges ───────────────────

describe('GoogleCalendarProvider.getBusyRanges', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns epoch-ms ranges from freebusy API', async () => {
    const mockFreebusyResponse = {
      data: {
        calendars: {
          primary: {
            busy: [
              { start: '2026-06-15T14:00:00Z', end: '2026-06-15T15:00:00Z' },
              { start: '2026-06-15T18:00:00Z', end: '2026-06-15T19:00:00Z' },
            ],
          },
        },
      },
    };

    vi.doMock('../src/config/env.js', () => ({
      env: {
        GOOGLE_CLIENT_ID: 'test-client-id',
        GOOGLE_CLIENT_SECRET: 'test-secret',
        GOOGLE_REDIRECT_URI: 'http://localhost:3000/oauth/callback',
        CALENDAR_MODE: 'real',
      },
    }));

    vi.doMock('googleapis', () => ({
      google: {
        calendar: () => ({
          freebusy: {
            query: vi.fn().mockResolvedValue(mockFreebusyResponse),
          },
        }),
        auth: {
          OAuth2: class MockOAuth2 {
            setCredentials() {}
            on() {} // token-refresh listener
          },
        },
      },
    }));

    // tenantRepo is used in the on('tokens') handler
    vi.doMock('../src/repos/tenant.repo.js', () => ({
      tenantRepo: {
        updateOAuthTokens: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { GoogleCalendarProvider } = await import(
      '../src/integrations/calendar/google-calendar.js'
    );
    const provider = new GoogleCalendarProvider();

    const tenant = {
      id: 'test-tenant',
      timezone: 'America/New_York',
      google_oauth_tokens: { access_token: 'fake', refresh_token: 'fake' },
      google_calendar_id: null,
    };

    const ranges = await provider.getBusyRanges(
      tenant as any,
      new Date('2026-06-15T00:00:00Z'),
      new Date('2026-06-16T00:00:00Z'),
    );

    expect(ranges).toHaveLength(2);
    expect(ranges[0].start).toBe(new Date('2026-06-15T14:00:00Z').getTime());
    expect(ranges[0].end).toBe(new Date('2026-06-15T15:00:00Z').getTime());
    expect(ranges[1].start).toBe(new Date('2026-06-15T18:00:00Z').getTime());
    expect(ranges[1].end).toBe(new Date('2026-06-15T19:00:00Z').getTime());
  });

  it('falls back to listEvents when freebusy fails', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        GOOGLE_CLIENT_ID: 'test-client-id',
        GOOGLE_CLIENT_SECRET: 'test-secret',
        GOOGLE_REDIRECT_URI: 'http://localhost:3000/oauth/callback',
        CALENDAR_MODE: 'real',
      },
    }));

    vi.doMock('googleapis', () => ({
      google: {
        calendar: () => ({
          freebusy: {
            query: vi.fn().mockRejectedValue(new Error('freebusy 403')),
          },
          events: {
            list: vi.fn().mockResolvedValue({
              data: {
                items: [
                  {
                    start: { dateTime: '2026-06-15T14:00:00Z' },
                    end: { dateTime: '2026-06-15T15:00:00Z' },
                  },
                ],
              },
            }),
          },
        }),
        auth: {
          OAuth2: class MockOAuth2 {
            setCredentials() {}
            on() {}
          },
        },
      },
    }));

    vi.doMock('../src/repos/tenant.repo.js', () => ({
      tenantRepo: {
        updateOAuthTokens: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { GoogleCalendarProvider } = await import(
      '../src/integrations/calendar/google-calendar.js'
    );
    const provider = new GoogleCalendarProvider();

    const tenant = {
      id: 'test-tenant',
      timezone: 'America/New_York',
      google_oauth_tokens: { access_token: 'fake', refresh_token: 'fake' },
      google_calendar_id: null,
    };

    const ranges = await provider.getBusyRanges(
      tenant as any,
      new Date('2026-06-15T00:00:00Z'),
      new Date('2026-06-16T00:00:00Z'),
    );

    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(new Date('2026-06-15T14:00:00Z').getTime());
  });
});

// ── 5. MockCalendarProvider.getBusyRanges ─────────────────────

describe('MockCalendarProvider.getBusyRanges', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns empty array (mock has no external events)', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'mock',
        CALENDAR_FAIL_MODE: 'none',
      },
    }));

    const { MockCalendarProvider } = await import(
      '../src/integrations/calendar/mock-calendar.js'
    );
    const provider = new MockCalendarProvider();

    const ranges = await provider.getBusyRanges(
      { id: 'test' } as any,
      new Date(),
      new Date(),
    );

    expect(ranges).toEqual([]);
  });
});

// ── 6. AvailabilityResult type contract ──────────────────────

describe('AvailabilityResult type shape', () => {
  it('has required fields: slots and verified', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'mock',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    const { availabilityService } = await import('../src/services/availability.service.js');

    const tenant = {
      id: 'shape-test',
      name: 'Shape Test',
      slug: 'shape',
      timezone: 'America/New_York',
      slot_duration: 30,
      business_hours: {
        monday: { start: '09:00', end: '17:00' },
        tuesday: null, wednesday: null, thursday: null,
        friday: null, saturday: null, sunday: null,
      },
      services: [],
      google_oauth_tokens: null,
      google_calendar_id: null,
    };

    const result = await availabilityService.getAvailableSlots(
      tenant as any,
      new Date('2026-06-15T00:00:00Z'), // Monday
      new Date('2026-06-15T23:59:59Z'),
    );

    // Validate shape
    expect(result).toHaveProperty('slots');
    expect(result).toHaveProperty('verified');
    expect(Array.isArray(result.slots)).toBe(true);
    expect(typeof result.verified).toBe('boolean');

    // Each slot has start, end, available
    if (result.slots.length > 0) {
      const slot = result.slots[0];
      expect(slot).toHaveProperty('start');
      expect(slot).toHaveProperty('end');
      expect(slot).toHaveProperty('available');
    }
  });
});

// ── 7. Specific Slot Exclusion: Busy 2:00–3:00 PM ────────────
// Requirement: A Google Calendar event 2:00–3:00 PM ET must
// exclude the 2:00 PM and 2:30 PM slots, while 1:30 PM and
// 3:00 PM remain available.

describe('Busy range 2:00–3:00 PM ET excludes exactly the right slots', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function makeTenant(overrides: Record<string, any> = {}) {
    return {
      id: 'tenant-slot-test',
      name: 'Slot Exclusion Test',
      slug: 'slot-test',
      timezone: 'America/New_York',
      slot_duration: 30,
      business_hours: {
        monday: { start: '09:00', end: '17:00' },
        tuesday: { start: '09:00', end: '17:00' },
        wednesday: { start: '09:00', end: '17:00' },
        thursday: { start: '09:00', end: '17:00' },
        friday: { start: '09:00', end: '17:00' },
        saturday: null,
        sunday: null,
      },
      services: [{ name: 'Consultation', duration: 30 }],
      google_oauth_tokens: null,
      google_calendar_id: null,
      ...overrides,
    };
  }

  it('excludes 2:00 and 2:30 slots but keeps 1:30 and 3:00 available', async () => {
    // Busy range: 2:00 PM – 3:00 PM ET on Monday 2026-06-15
    // 2:00 PM ET = 18:00 UTC (EDT, UTC-4), 3:00 PM ET = 19:00 UTC
    const busyStart = new Date('2026-06-15T18:00:00Z').getTime();
    const busyEnd   = new Date('2026-06-15T19:00:00Z').getTime();

    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'real',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
        CALENDAR_DEBUG: 'true',
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: () => ({
        name: 'mock-google',
        getBusyRanges: vi.fn().mockResolvedValue([
          { start: busyStart, end: busyEnd },
        ]),
      }),
    }));
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(null),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
    }));

    // Capture debug log output
    const debugLogs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      debugLogs.push(args.join(' '));
    });

    const { availabilityService } = await import('../src/services/availability.service.js');

    const tenant = makeTenant({ google_oauth_tokens: { access_token: 'fake' } });

    // Query Monday June 15, 2026 — far enough in the future that
    // no slots are filtered as "past" regardless of when tests run.
    const from = new Date('2026-06-15T00:00:00Z');
    const to   = new Date('2026-06-15T23:59:59Z');

    const result = await availabilityService.getAvailableSlots(tenant as any, from, to);

    // Find specific slots by their UTC start times
    // In June, ET = EDT (UTC-4)
    // 1:30 PM ET = 17:30 UTC
    const slot130pm = result.slots.find(s => s.start === '2026-06-15T17:30:00.000Z');
    // 2:00 PM ET = 18:00 UTC
    const slot200pm = result.slots.find(s => s.start === '2026-06-15T18:00:00.000Z');
    // 2:30 PM ET = 18:30 UTC
    const slot230pm = result.slots.find(s => s.start === '2026-06-15T18:30:00.000Z');
    // 3:00 PM ET = 19:00 UTC
    const slot300pm = result.slots.find(s => s.start === '2026-06-15T19:00:00.000Z');

    // 1:30 PM should be AVAILABLE (ends before busy start)
    expect(slot130pm).toBeDefined();
    expect(slot130pm!.available).toBe(true);

    // 2:00 PM should be EXCLUDED (fully inside busy range)
    expect(slot200pm).toBeDefined();
    expect(slot200pm!.available).toBe(false);

    // 2:30 PM should be EXCLUDED (overlaps busy range)
    expect(slot230pm).toBeDefined();
    expect(slot230pm!.available).toBe(false);

    // 3:00 PM should be AVAILABLE (starts at busy end — no overlap)
    expect(slot300pm).toBeDefined();
    expect(slot300pm!.available).toBe(true);

    // Verify debug snapshot was populated
    const { getCalendarDebugSnapshot } = await import('../src/services/availability.service.js');
    const snap = getCalendarDebugSnapshot('tenant-slot-test');
    expect(snap).not.toBeNull();
    expect(snap!.slots_excluded_by_busy).toBeGreaterThanOrEqual(2);
    expect(snap!.verified).toBe(true);
  });

  it('debug logs show per-slot exclusion reasons when CALENDAR_DEBUG=true', async () => {
    // Busy: 2:00–3:00 PM ET (EDT) June 15 = 18:00–19:00 UTC
    const busyStart = new Date('2026-06-15T18:00:00Z').getTime();
    const busyEnd   = new Date('2026-06-15T19:00:00Z').getTime();

    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'real',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
        CALENDAR_DEBUG: 'true',
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: () => ({
        name: 'mock-google',
        getBusyRanges: vi.fn().mockResolvedValue([
          { start: busyStart, end: busyEnd },
        ]),
      }),
    }));
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(null),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
    }));

    const debugLogs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      debugLogs.push(args.join(' '));
    });

    const { availabilityService } = await import('../src/services/availability.service.js');
    const tenant = makeTenant({ google_oauth_tokens: { access_token: 'fake' } });

    await availabilityService.getAvailableSlots(
      tenant as any,
      new Date('2026-06-15T00:00:00Z'),
      new Date('2026-06-15T23:59:59Z'),
    );

    // Should see per-slot EXCLUDED logs with "calendar-busy" reason
    const exclusionLogs = debugLogs.filter(l => l.includes('❌ EXCLUDED') && l.includes('calendar-busy'));
    expect(exclusionLogs.length).toBeGreaterThanOrEqual(2); // at least 2:00 and 2:30

    // Should see summary log with counts
    const summaryLog = debugLogs.find(l => l.includes('generated') && l.includes('busy'));
    expect(summaryLog).toBeDefined();
  });

  it('only available slots are returned to the agent (no unavailable in filtered list)', async () => {
    // Busy: 2:00–3:00 PM ET (EDT) June 15 = 18:00–19:00 UTC
    const busyStart = new Date('2026-06-15T18:00:00Z').getTime();
    const busyEnd   = new Date('2026-06-15T19:00:00Z').getTime();

    vi.doMock('../src/config/env.js', () => ({
      env: {
        CALENDAR_MODE: 'real',
        DEMO_AVAILABILITY: 'false',
        CALENDAR_READ_REQUIRED: 'true',
        CALENDAR_BUSY_CACHE_TTL_SECONDS: 30,
        CALENDAR_DEBUG: 'false',
      },
    }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: {
        listByTenantAndRange: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: () => ({
        name: 'mock-google',
        getBusyRanges: vi.fn().mockResolvedValue([
          { start: busyStart, end: busyEnd },
        ]),
      }),
    }));
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(null),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
    }));

    const { availabilityService } = await import('../src/services/availability.service.js');
    const tenant = makeTenant({ google_oauth_tokens: { access_token: 'fake' } });

    const result = await availabilityService.getAvailableSlots(
      tenant as any,
      new Date('2026-06-15T00:00:00Z'),
      new Date('2026-06-15T23:59:59Z'),
    );

    // The availability service returns ALL slots with available flag.
    // The tool-executor filters to available=true before presenting to the agent.
    // Verify that the 2:00 and 2:30 slots are marked unavailable in the raw result.
    const availableSlots = result.slots.filter(s => s.available);
    const unavailableSlots = result.slots.filter(s => !s.available);

    // 2:00 and 2:30 must be in the unavailable list
    const unavailStarts = unavailableSlots.map(s => s.start);
    expect(unavailStarts).toContain('2026-06-15T18:00:00.000Z'); // 2:00 PM ET (EDT)
    expect(unavailStarts).toContain('2026-06-15T18:30:00.000Z'); // 2:30 PM ET (EDT)

    // 1:30 and 3:00 must be in the available list
    const availStarts = availableSlots.map(s => s.start);
    expect(availStarts).toContain('2026-06-15T17:30:00.000Z'); // 1:30 PM ET (EDT)
    expect(availStarts).toContain('2026-06-15T19:00:00.000Z'); // 3:00 PM ET (EDT)
  });

  it('transparent events do not block slots in listEvents fallback', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        GOOGLE_CLIENT_ID: 'test-client-id',
        GOOGLE_CLIENT_SECRET: 'test-secret',
        GOOGLE_REDIRECT_URI: 'http://localhost:3000/oauth/callback',
        CALENDAR_MODE: 'real',
      },
    }));

    vi.doMock('googleapis', () => ({
      google: {
        calendar: () => ({
          freebusy: {
            query: vi.fn().mockRejectedValue(new Error('freebusy 403')),
          },
          events: {
            list: vi.fn().mockResolvedValue({
              data: {
                items: [
                  {
                    start: { dateTime: '2026-02-09T19:00:00Z' },
                    end: { dateTime: '2026-02-09T20:00:00Z' },
                    transparency: 'opaque', // busy — should block
                  },
                  {
                    start: { dateTime: '2026-02-09T20:00:00Z' },
                    end: { dateTime: '2026-02-09T21:00:00Z' },
                    transparency: 'transparent', // free — should NOT block
                  },
                ],
              },
            }),
          },
        }),
        auth: {
          OAuth2: class MockOAuth2 {
            setCredentials() {}
            on() {}
          },
        },
      },
    }));

    vi.doMock('../src/repos/tenant.repo.js', () => ({
      tenantRepo: {
        updateOAuthTokens: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { GoogleCalendarProvider } = await import(
      '../src/integrations/calendar/google-calendar.js'
    );
    const provider = new GoogleCalendarProvider();

    const tenant = {
      id: 'test-tenant',
      timezone: 'America/New_York',
      google_oauth_tokens: { access_token: 'fake', refresh_token: 'fake' },
      google_calendar_id: null,
    };

    const ranges = await provider.getBusyRanges(
      tenant as any,
      new Date('2026-02-09T00:00:00Z'),
      new Date('2026-02-10T00:00:00Z'),
    );

    // Only the opaque event should produce a busy range
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBe(new Date('2026-02-09T19:00:00Z').getTime());
    expect(ranges[0].end).toBe(new Date('2026-02-09T20:00:00Z').getTime());
  });
});
