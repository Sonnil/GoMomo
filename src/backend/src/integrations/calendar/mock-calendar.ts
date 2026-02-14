// ============================================================
// Mock Calendar Provider — Local Testing & Failure Simulation
// ============================================================
// Used when CALENDAR_MODE=mock. Simulates an external calendar
// without hitting any real API.
//
// Behavior (CALENDAR_FAIL_MODE=none, the default):
// - createEvent → returns a deterministic mock event ID, logs it
// - deleteEvent → logs deletion, no-op
// - listEvents → returns empty array (Postgres is the sole truth)
// - getAuthUrl → returns a fake URL (for UI testing)
// - handleCallback → no-op (pretends OAuth succeeded)
//
// Failure Simulation (CALENDAR_FAIL_MODE=auth_error|network_error|timeout):
// - auth_error   → createEvent throws "Invalid Credentials (401)"
// - network_error → createEvent throws "ECONNREFUSED"
// - timeout       → createEvent waits 10s then throws "ETIMEDOUT"
// - all_ops_fail  → createEvent AND deleteEvent both throw
//
// This ensures the AI agent behaves IDENTICALLY to real mode —
// the same code paths execute, the same booking service logic runs,
// the same DB constraints are enforced. Only the external HTTP
// call to Google is replaced with a logged no-op (or simulated error).
// ============================================================

import type { Tenant } from '../../domain/types.js';
import type { CalendarProvider, CalendarEvent } from './types.js';
import { env } from '../../config/env.js';

/** Counter for generating sequential mock event IDs */
let mockEventCounter = 0;

/**
 * Simulated calendar API errors — mirrors real Google Calendar error shapes.
 */
class MockCalendarAuthError extends Error {
  code = 401;
  constructor() {
    super('Request had invalid authentication credentials. Expected OAuth 2 access token. (mock simulation)');
    this.name = 'MockCalendarAuthError';
  }
}

class MockCalendarNetworkError extends Error {
  code = 'ECONNREFUSED';
  constructor() {
    super('connect ECONNREFUSED 142.250.80.106:443 — Google Calendar API unreachable (mock simulation)');
    this.name = 'MockCalendarNetworkError';
  }
}

class MockCalendarTimeoutError extends Error {
  code = 'ETIMEDOUT';
  constructor() {
    super('request to https://www.googleapis.com/calendar/v3/calendars/primary/events timed out (mock simulation)');
    this.name = 'MockCalendarTimeoutError';
  }
}

export class MockCalendarProvider implements CalendarProvider {
  readonly name = 'mock';

  /** Get the active fail mode from env (re-read each call so it can be toggled at runtime) */
  private get failMode(): string {
    return env.CALENDAR_FAIL_MODE;
  }

  /**
   * Throw the configured failure, if any.
   * @param operation — for logging (e.g. 'createEvent', 'deleteEvent')
   */
  private async maybeThrow(operation: string): Promise<void> {
    const mode = this.failMode;
    if (mode === 'none') return;

    console.warn(`[mock-calendar] ⚡ FAILURE SIMULATION: ${mode} on ${operation}`);

    switch (mode) {
      case 'auth_error':
        throw new MockCalendarAuthError();

      case 'network_error':
        throw new MockCalendarNetworkError();

      case 'timeout':
        // Simulate a real network timeout — wait then throw
        await new Promise((resolve) => setTimeout(resolve, 5000));
        throw new MockCalendarTimeoutError();

      case 'all_ops_fail':
        // Same as auth_error but also affects deleteEvent
        throw new MockCalendarAuthError();

      default:
        // Unknown fail mode — log warning but don't throw
        console.warn(`[mock-calendar] Unknown CALENDAR_FAIL_MODE: "${mode}" — treating as none`);
    }
  }

  getAuthUrl(tenantId: string): string {
    const url = `http://localhost:3000/api/oauth/google/callback?code=mock-code-${tenantId}&state=${tenantId}`;
    console.log(`[mock-calendar] Generated fake OAuth URL for tenant ${tenantId}`);
    return url;
  }

  async handleCallback(code: string, tenantId: string): Promise<void> {
    console.log(`[mock-calendar] OAuth callback (no-op): code=${code}, tenant=${tenantId}`);
    // In mock mode we don't store tokens — the booking service checks
    // tenant.google_oauth_tokens before calling createEvent, and in mock
    // mode the factory always returns this provider regardless.
  }

  async createEvent(tenant: Tenant, event: CalendarEvent): Promise<string> {
    // Failure simulation gate — throws if CALENDAR_FAIL_MODE is set
    await this.maybeThrow('createEvent');

    mockEventCounter++;
    const mockId = `mock-event-${mockEventCounter}-${Date.now()}`;

    const attendeeStr = event.attendees?.length
      ? `  Attendees: ${event.attendees.map((a) => a.email).join(', ')}`
      : '';

    console.log(
      `[mock-calendar] Created event: ${mockId}\n` +
      `  Tenant:  ${tenant.name} (${tenant.id})\n` +
      `  Summary: ${event.summary}\n` +
      `  Time:    ${event.start.toISOString()} → ${event.end.toISOString()}\n` +
      `  TZ:      ${event.timezone}` +
      (attendeeStr ? `\n${attendeeStr}` : ''),
    );

    return mockId;
  }

  async deleteEvent(tenant: Tenant, eventId: string): Promise<void> {
    // Only fail on deleteEvent in 'all_ops_fail' mode
    if (this.failMode === 'all_ops_fail') {
      await this.maybeThrow('deleteEvent');
    }

    console.log(
      `[mock-calendar] Deleted event: ${eventId} (tenant: ${tenant.name})`,
    );
  }

  async listEvents(
    _tenant: Tenant,
    _from: Date,
    _to: Date,
  ): Promise<Array<{ start: string; end: string; transparency?: string }>> {
    // Return empty — in mock mode, Postgres is the sole source of truth.
    // The availability service already checks DB appointments + holds.
    // No external calendar events to cross-reference.
    return [];
  }

  async getBusyRanges(
    _tenant: Tenant,
    _from: Date,
    _to: Date,
  ): Promise<Array<{ start: number; end: number }>> {
    // Mock mode: no external calendar busy times.
    // Override via CALENDAR_FAIL_MODE to simulate failures.
    await this.maybeThrow('getBusyRanges');
    return [];
  }
}
