/**
 * Calendar Attendee — unit tests for the attendee-invite feature.
 *
 * Tests:
 *  1. CalendarEvent type accepts attendees array
 *  2. CalendarEvent type works without attendees (backward compat)
 *  3. MockCalendarProvider logs attendees when present
 *  4. MockCalendarProvider works without attendees
 *  5. Google Calendar requestBody includes attendees when provided
 *  6. Google Calendar events.insert uses sendUpdates='all' with attendees
 *  7. Google Calendar events.insert uses sendUpdates='none' without attendees
 *  8. Google Calendar deleteEvent uses sendUpdates='all'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CalendarEvent } from '../src/integrations/calendar/types.js';

// ── Mock the googleapis module ──────────────────────────────

const mockInsert = vi.fn().mockResolvedValue({ data: { id: 'gcal-event-1' } });
const mockDelete = vi.fn().mockResolvedValue({});
const mockCalendar = {
  events: {
    insert: mockInsert,
    delete: mockDelete,
    list: vi.fn().mockResolvedValue({ data: { items: [] } }),
  },
  freebusy: {
    query: vi.fn().mockResolvedValue({
      data: { calendars: { primary: { busy: [] } } },
    }),
  },
};

vi.mock('googleapis', () => {
  // OAuth2 must be a real constructor (used with `new`)
  class FakeOAuth2 {
    setCredentials = vi.fn();
    on = vi.fn();
  }

  return {
    google: {
      calendar: () => mockCalendar,
      auth: {
        OAuth2: FakeOAuth2,
      },
    },
  };
});

// ── Mock env for Google Calendar provider ─────────────────

vi.mock('../src/config/env.js', () => ({
  env: {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/oauth/google/callback',
  },
}));

// Now import the providers
import { GoogleCalendarProvider } from '../src/integrations/calendar/google-calendar.js';
import { MockCalendarProvider } from '../src/integrations/calendar/mock-calendar.js';

const mockTenant = {
  id: 'tenant-1',
  name: 'Test Salon',
  slug: 'test-salon',
  timezone: 'America/New_York',
  google_calendar_id: 'primary',
  google_oauth_tokens: JSON.stringify({ access_token: 'mock-token' }),
  business_hours: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as any;

const baseEvent: CalendarEvent = {
  summary: 'Deep Tissue Massage - Jane',
  description: 'Booked via gomomo.ai',
  start: new Date('2026-02-15T14:00:00Z'),
  end: new Date('2026-02-15T15:00:00Z'),
  timezone: 'America/New_York',
};

describe('Calendar Attendee Feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Type-level tests (compile = pass) ───────────────────

  it('CalendarEvent type accepts attendees array', () => {
    const event: CalendarEvent = {
      ...baseEvent,
      attendees: [{ email: 'customer@example.com' }],
    };
    expect(event.attendees).toHaveLength(1);
    expect(event.attendees![0].email).toBe('customer@example.com');
  });

  it('CalendarEvent type works without attendees (backward compat)', () => {
    const event: CalendarEvent = { ...baseEvent };
    expect(event.attendees).toBeUndefined();
  });

  // ── Mock Calendar Provider ──────────────────────────────

  it('MockCalendarProvider logs attendees when present', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mock = new MockCalendarProvider();
    const eventWithAttendees: CalendarEvent = {
      ...baseEvent,
      attendees: [{ email: 'jane@example.com' }],
    };

    await mock.createEvent(mockTenant, eventWithAttendees);

    const logCall = consoleSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('[mock-calendar] Created event'),
    );
    expect(logCall).toBeDefined();
    expect(logCall![0]).toContain('jane@example.com');
    consoleSpy.mockRestore();
  });

  it('MockCalendarProvider works without attendees', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mock = new MockCalendarProvider();
    const eventId = await mock.createEvent(mockTenant, baseEvent);

    expect(eventId).toMatch(/^mock-event-/);
    const logCall = consoleSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('[mock-calendar] Created event'),
    );
    expect(logCall).toBeDefined();
    expect(logCall![0]).not.toContain('Attendees:');
    consoleSpy.mockRestore();
  });

  // ── Google Calendar Provider ────────────────────────────

  it('Google Calendar requestBody includes attendees when provided', async () => {
    const provider = new GoogleCalendarProvider();
    const eventWithAttendees: CalendarEvent = {
      ...baseEvent,
      attendees: [{ email: 'customer@example.com' }],
    };

    await provider.createEvent(mockTenant, eventWithAttendees);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const callArgs = mockInsert.mock.calls[0][0];
    expect(callArgs.requestBody.attendees).toEqual([
      { email: 'customer@example.com' },
    ]);
  });

  it('Google Calendar events.insert uses sendUpdates=all with attendees', async () => {
    const provider = new GoogleCalendarProvider();
    const eventWithAttendees: CalendarEvent = {
      ...baseEvent,
      attendees: [{ email: 'customer@example.com' }],
    };

    await provider.createEvent(mockTenant, eventWithAttendees);

    const callArgs = mockInsert.mock.calls[0][0];
    expect(callArgs.sendUpdates).toBe('all');
  });

  it('Google Calendar events.insert uses sendUpdates=none without attendees', async () => {
    const provider = new GoogleCalendarProvider();

    await provider.createEvent(mockTenant, baseEvent);

    const callArgs = mockInsert.mock.calls[0][0];
    expect(callArgs.sendUpdates).toBe('none');
  });

  it('Google Calendar deleteEvent uses sendUpdates=all', async () => {
    const provider = new GoogleCalendarProvider();

    await provider.deleteEvent(mockTenant, 'gcal-event-99');

    expect(mockDelete).toHaveBeenCalledTimes(1);
    const callArgs = mockDelete.mock.calls[0][0];
    expect(callArgs.sendUpdates).toBe('all');
  });
});
