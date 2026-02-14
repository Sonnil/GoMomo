// ============================================================
// Google Calendar Provider — Real Implementation
// ============================================================
// Wraps the existing googleapis-based calendar service as a
// CalendarProvider. Used when CALENDAR_MODE=real.
// ============================================================

import { google } from 'googleapis';
import type { Tenant } from '../../domain/types.js';
import type { CalendarProvider, CalendarEvent } from './types.js';
import { env } from '../../config/env.js';
import { tenantRepo } from '../../repos/tenant.repo.js';

export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = 'google';

  private get oauth2Client() {
    return new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
    );
  }

  getAuthUrl(tenantId: string): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/calendar'],
      state: tenantId,
    });
  }

  async handleCallback(code: string, tenantId: string): Promise<void> {
    const client = this.oauth2Client;
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error('Failed to obtain OAuth tokens');
    }

    await tenantRepo.updateOAuthTokens(tenantId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date ?? 0,
    });

    // Discover and store the primary calendar ID
    client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const { data } = await calendar.calendarList.list();
    const primary = data.items?.find((c) => c.primary);
    if (primary?.id) {
      await tenantRepo.update(tenantId, { google_calendar_id: primary.id });
    }
  }

  async createEvent(tenant: Tenant, event: CalendarEvent): Promise<string> {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });

    const requestBody: Record<string, unknown> = {
      summary: event.summary,
      description: event.description,
      start: {
        dateTime: event.start.toISOString(),
        timeZone: event.timezone,
      },
      end: {
        dateTime: event.end.toISOString(),
        timeZone: event.timezone,
      },
    };

    // Add attendees so the customer gets a calendar invitation
    if (event.attendees?.length) {
      requestBody.attendees = event.attendees.map((a) => ({ email: a.email }));
    }

    const { data } = await calendar.events.insert({
      calendarId: tenant.google_calendar_id ?? 'primary',
      // Send email invitations to attendees
      sendUpdates: event.attendees?.length ? 'all' : 'none',
      requestBody,
    });

    return data.id!;
  }

  async deleteEvent(tenant: Tenant, eventId: string): Promise<void> {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });

    await calendar.events.delete({
      calendarId: tenant.google_calendar_id ?? 'primary',
      eventId,
      // Notify attendees when event is cancelled
      sendUpdates: 'all',
    });
  }

  async listEvents(
    tenant: Tenant,
    from: Date,
    to: Date,
  ): Promise<Array<{ start: string; end: string; transparency?: string }>> {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });

    const { data } = await calendar.events.list({
      calendarId: tenant.google_calendar_id ?? 'primary',
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    return (data.items ?? []).map((e) => ({
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      transparency: e.transparency ?? undefined,
    }));
  }

  async getBusyRanges(
    tenant: Tenant,
    from: Date,
    to: Date,
  ): Promise<Array<{ start: number; end: number }>> {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });
    const calendarId = tenant.google_calendar_id ?? 'primary';

    try {
      // Prefer the freebusy API — it's designed for this and is faster
      const { data } = await calendar.freebusy.query({
        requestBody: {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          timeZone: tenant.timezone,
          items: [{ id: calendarId }],
        },
      });

      const busySlots = data.calendars?.[calendarId]?.busy ?? [];
      return busySlots
        .filter((b) => b.start && b.end)
        .map((b) => ({
          start: new Date(b.start!).getTime(),
          end: new Date(b.end!).getTime(),
        }));
    } catch (freebusyError) {
      // Fallback: if freebusy fails, try listEvents instead
      console.warn('[google-calendar] freebusy query failed, falling back to listEvents:', freebusyError);

      try {
        const events = await this.listEvents(tenant, from, to);
        return events
          .filter((e) => e.start && e.end)
          // Skip transparent (free/show-as-available) events — only block on opaque/busy
          .filter((e) => e.transparency !== 'transparent')
          .map((e) => ({
            start: new Date(e.start).getTime(),
            end: new Date(e.end).getTime(),
          }));
      } catch (listError) {
        // Both methods failed — re-throw so the caller can decide policy
        console.error('[google-calendar] listEvents fallback also failed:', listError);
        throw listError;
      }
    }
  }

  /**
   * Get an authenticated OAuth2 client for a tenant.
   */
  private getAuthForTenant(tenant: Tenant) {
    if (!tenant.google_oauth_tokens) {
      throw new Error(`Tenant ${tenant.id} has no Google OAuth tokens`);
    }

    const client = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
    );

    client.setCredentials({
      access_token: tenant.google_oauth_tokens.access_token,
      refresh_token: tenant.google_oauth_tokens.refresh_token,
      expiry_date: tenant.google_oauth_tokens.expiry_date,
    });

    // Auto-refresh on expiry
    client.on('tokens', async (tokens) => {
      await tenantRepo.updateOAuthTokens(tenant.id, {
        access_token: tokens.access_token ?? tenant.google_oauth_tokens!.access_token,
        refresh_token: tokens.refresh_token ?? tenant.google_oauth_tokens!.refresh_token,
        expiry_date: tokens.expiry_date ?? 0,
      });
    });

    return client;
  }
}
