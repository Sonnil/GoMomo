// ============================================================
// Calendar Provider — Types & Interface
// ============================================================
// Every calendar adapter (Google, Mock, NoOp) implements this
// contract. The booking service and availability service call
// these methods without knowing which provider is active.
// ============================================================

import type { Tenant } from '../../domain/types.js';

/**
 * Represents a calendar event to be created in an external provider.
 */
export interface CalendarEvent {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timezone: string;
  /** Optional list of attendees to invite (e.g. customer email). */
  attendees?: Array<{ email: string }>;
}

/**
 * Common interface for all calendar providers.
 *
 * Implementations:
 * - GoogleCalendarProvider  — real Google Calendar via googleapis
 * - MockCalendarProvider    — deterministic mock for local testing
 * - NoOpCalendarProvider    — no-op fallback (DB-only scheduling)
 */
export interface CalendarProvider {
  /** Unique name for logging and diagnostics */
  readonly name: string;

  /**
   * Generate an OAuth/authorization URL for a tenant to connect their calendar.
   * Returns empty string if the provider doesn't use OAuth (mock, noop).
   */
  getAuthUrl(tenantId: string): string;

  /**
   * Handle the OAuth callback — exchange code for tokens, store them.
   * No-op if the provider doesn't use OAuth.
   */
  handleCallback(code: string, tenantId: string): Promise<void>;

  /**
   * Create a calendar event. Returns the external event ID.
   * Called AFTER the booking is committed to Postgres (best-effort).
   */
  createEvent(tenant: Tenant, event: CalendarEvent): Promise<string>;

  /**
   * Delete a calendar event by its external ID.
   * Called on cancellation (best-effort).
   */
  deleteEvent(tenant: Tenant, eventId: string): Promise<void>;

  /**
   * List events in a time range.
   * Used for cross-checking availability against the external calendar.
   * Returns empty array if the provider has no external events.
   * Optional `transparency` field: "transparent" means free/show-as-available,
   * "opaque" (or absent) means busy.
   */
  listEvents(
    tenant: Tenant,
    from: Date,
    to: Date,
  ): Promise<Array<{ start: string; end: string; transparency?: string }>>;

  /**
   * Get busy time ranges from the external calendar (freebusy / events).
   * Used by the availability engine to subtract personal events from
   * offered slots.
   *
   * Returns epoch-based ranges for fast overlap checking.
   * Empty array when provider has no external calendar (mock/noop).
   */
  getBusyRanges(
    tenant: Tenant,
    from: Date,
    to: Date,
  ): Promise<Array<{ start: number; end: number }>>;
}
