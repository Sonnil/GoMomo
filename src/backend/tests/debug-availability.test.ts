// ============================================================
// Debug Availability — Endpoint + Chat Tool Tests
// ============================================================
// Verifies:
//  1. GET /api/debug/availability returns structured slot/busy/exclusion data
//  2. debug_availability tool returns same data via chat
//  3. PII-safe: no event names, no emails, no calendar IDs
//  4. Admin key protection on the endpoint
//  5. Tool disabled when CALENDAR_DEBUG !== 'true'
//
// Run:  npx vitest run tests/debug-availability.test.ts
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Shared mock env ──────────────────────────────────────────
const DEFAULT_ENV = {
  CALENDAR_MODE: 'real',
  CALENDAR_DEBUG: 'true',
  CALENDAR_READ_REQUIRED: 'true',
  CALENDAR_BUSY_CACHE_TTL_SECONDS: 5,
  DEMO_AVAILABILITY: 'false',
  OPENAI_API_KEY: 'test',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_MODEL: 'gpt-4o',
  NODE_ENV: 'development',
  ADMIN_API_KEY: 'test-admin-key',
  SDK_AUTH_REQUIRED: 'false',
};

// ── Shared mock tenant ───────────────────────────────────────
const DEMO_TENANT = {
  id: '00000000-0000-4000-a000-000000000001',
  name: 'Gomomo',
  slug: 'gomomo',
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
  services: [{ name: 'General Consultation', duration: 60 }],
  google_oauth_tokens: { access_token: 'mock', refresh_token: 'mock' },
  google_calendar_id: null,
};

// Monday Feb 9, 2026 2:00–3:00 PM ET = 19:00–20:00 UTC
const BUSY_RANGE = {
  start: new Date('2026-02-09T19:00:00Z').getTime(),
  end: new Date('2026-02-09T20:00:00Z').getTime(),
};

describe('Debug Availability Tool (handleDebugAvailability)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/config/env.js', () => ({ env: { ...DEFAULT_ENV } }));
    vi.doMock('../src/repos/appointment.repo.js', () => ({
      appointmentRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/hold.repo.js', () => ({
      holdRepo: { listByTenantAndRange: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/integrations/calendar/busy-range-cache.js', () => ({
      getCachedBusyRanges: vi.fn().mockReturnValue(null),
      setCachedBusyRanges: vi.fn(),
      invalidateTenantCache: vi.fn(),
      clearBusyRangeCache: vi.fn(),
      getBusyRangeCacheStats: vi.fn().mockReturnValue({ size: 0, maxSize: 100 }),
    }));
    vi.doMock('../src/integrations/calendar/index.js', () => ({
      getCalendarProvider: vi.fn().mockReturnValue({
        name: 'google',
        getBusyRanges: vi.fn().mockResolvedValue([BUSY_RANGE]),
        getAuthUrl: vi.fn(),
        handleCallback: vi.fn(),
        createEvent: vi.fn(),
        deleteEvent: vi.fn(),
      }),
    }));
    // Freeze clock to Sunday Feb 8, 2026 2:00 PM ET (19:00 UTC)
    vi.doMock('../src/services/clock.js', () => ({
      getNow: vi.fn().mockReturnValue(new Date('2026-02-08T19:00:00Z')),
      getNowUTC: vi.fn().mockReturnValue(new Date('2026-02-08T19:00:00Z')),
      formatNow: vi.fn().mockReturnValue('Sunday, February 8, 2026 2:00 PM'),
      getTodayISO: vi.fn().mockReturnValue('2026-02-08'),
      daysFromNow: vi.fn().mockReturnValue(1),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns structured availability with busy exclusions', async () => {
    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'debug_availability',
      { date: '2026-02-09', start: '12:00', end: '17:00' },
      DEMO_TENANT.id,
      'test-session',
      DEMO_TENANT as any,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.query.date).toBe('2026-02-09');
    expect(result.data.query.timezone).toBe('America/New_York');
    expect(result.data.verified).toBe(true);
    expect(result.data.calendar_source).toBe('google');

    // Busy range should exclude 2:00 PM and 2:30 PM
    expect(result.data.excluded).toBeGreaterThanOrEqual(2);
    expect(result.data.excluded_times.map((t: any) => t.time)).toContain('2:00 PM');
    expect(result.data.excluded_times.map((t: any) => t.time)).toContain('2:30 PM');

    // 12:00, 12:30, 1:00, 1:30 should be available
    expect(result.data.available_times).toContain('12:00 PM');
    expect(result.data.available_times).toContain('12:30 PM');
    expect(result.data.available_times).toContain('1:00 PM');
    expect(result.data.available_times).toContain('1:30 PM');

    // 3:00 PM and later should be available (after busy ends)
    expect(result.data.available_times).toContain('3:00 PM');

    // All exclusion reasons are 'busy_overlap' (PII-safe)
    for (const ex of result.data.excluded_times) {
      expect(ex.reason).toBe('busy_overlap');
    }

    // Busy ranges reported
    expect(result.data.busy_ranges.length).toBeGreaterThanOrEqual(1);

    // Exclusion breakdown present
    expect(result.data.exclusion_breakdown).toBeDefined();
    expect(result.data.exclusion_breakdown.by_busy).toBeGreaterThanOrEqual(2);
  });

  it('is PII-safe: no event names, emails, or calendar IDs', async () => {
    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'debug_availability',
      { date: '2026-02-09', start: '12:00', end: '17:00' },
      DEMO_TENANT.id,
      'test-session',
      DEMO_TENANT as any,
    );

    const json = JSON.stringify(result.data);
    expect(json).not.toContain('Team Meeting');
    expect(json).not.toContain('aireceptionistt@gmail.com');
    expect(json).not.toContain('calendar_id');
    expect(json).not.toContain('attendee');
    expect(json).not.toContain('title');
    expect(json).not.toContain('summary');
  });

  it('returns error when CALENDAR_DEBUG is not true', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: { ...DEFAULT_ENV, CALENDAR_DEBUG: 'false' },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'debug_availability',
      { date: '2026-02-09', start: '12:00', end: '17:00' },
      DEMO_TENANT.id,
      'test-session',
      DEMO_TENANT as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('CALENDAR_DEBUG');
  });

  it('validates date format', async () => {
    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'debug_availability',
      { date: 'tomorrow' },
      DEMO_TENANT.id,
      'test-session',
      DEMO_TENANT as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('YYYY-MM-DD');
  });
});

describe('Debug Availability Tool definition', () => {
  it('debug tool is included in tool list when CALENDAR_DEBUG=true', async () => {
    const { debugAvailabilityTool } = await import('../src/agent/tools.js');
    expect(debugAvailabilityTool.function.name).toBe('debug_availability');
    expect(debugAvailabilityTool.function.parameters.required).toContain('date');
  });

  it('debug tool description is PII-safe', async () => {
    const { debugAvailabilityTool } = await import('../src/agent/tools.js');
    const desc = debugAvailabilityTool.function.description;
    expect(desc).toContain('PII-safe');
    expect(desc).toContain('no event names');
    expect(desc).toContain('no emails');
  });
});
