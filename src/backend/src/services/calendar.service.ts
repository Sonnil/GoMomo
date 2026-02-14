import { google } from 'googleapis';
import type { Tenant, GoogleOAuthTokens } from '../domain/types.js';
import { env } from '../config/env.js';
import { tenantRepo } from '../repos/tenant.repo.js';

const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_REDIRECT_URI,
);

export const calendarService = {
  /**
   * Generate the OAuth consent URL for a tenant.
   */
  getAuthUrl(tenantId: string): string {
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/calendar'],
      state: tenantId,
    });
  },

  /**
   * Exchange an authorization code for tokens and store them.
   */
  async handleCallback(code: string, tenantId: string): Promise<void> {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error('Failed to obtain OAuth tokens');
    }

    await tenantRepo.updateOAuthTokens(tenantId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date ?? 0,
    });

    // Also discover and store the primary calendar ID
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { data } = await calendar.calendarList.list();
    const primary = data.items?.find((c) => c.primary);
    if (primary?.id) {
      await tenantRepo.update(tenantId, { google_calendar_id: primary.id });
    }
  },

  /**
   * Create a calendar event. Returns the Google event ID.
   */
  async createEvent(
    tenant: Tenant,
    event: {
      summary: string;
      description: string;
      start: Date;
      end: Date;
      timezone: string;
    },
  ): Promise<string> {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });

    const { data } = await calendar.events.insert({
      calendarId: tenant.google_calendar_id ?? 'primary',
      requestBody: {
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
      },
    });

    return data.id!;
  },

  /**
   * Delete a calendar event.
   */
  async deleteEvent(tenant: Tenant, eventId: string): Promise<void> {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });

    await calendar.events.delete({
      calendarId: tenant.google_calendar_id ?? 'primary',
      eventId,
    });
  },

  /**
   * List events in a time range (for cross-checking availability).
   */
  async listEvents(
    tenant: Tenant,
    timeMin: Date,
    timeMax: Date,
  ): Promise<Array<{ start: string; end: string; transparency?: string }>> {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });

    const { data } = await calendar.events.list({
      calendarId: tenant.google_calendar_id ?? 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    return (data.items ?? []).map((e) => ({
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      transparency: e.transparency ?? undefined,
    }));
  },

  /**
   * Get an authenticated OAuth2 client for a tenant.
   */
  getAuthForTenant(tenant: Tenant) {
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
  },
};
