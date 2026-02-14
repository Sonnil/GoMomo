# Adding a Calendar Provider

> **Goal:** Integrate a new external calendar (Outlook, Cal.com, CalDAV, etc.)
> so bookings sync bi-directionally with the provider.
>
> **Time:** 2–4 hours for a basic adapter.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [The CalendarProvider Interface](#2-the-calendarprovider-interface)
3. [Walkthrough: How GoogleCalendar Implements It](#3-walkthrough-how-googlecalendar-implements-it)
4. [Step-by-Step: Add a New Provider](#4-step-by-step-add-a-new-provider)
5. [Wire It Into the Factory](#5-wire-it-into-the-factory)
6. [Testing Your Adapter](#6-testing-your-adapter)
7. [NoOp Calendar (Default)](#7-noop-calendar-default)
8. [FAQ](#8-faq)

---

## 1. Architecture Overview

```
Booking Service
    │
    ▼
CalendarProvider (interface)
    │
    ├── GoogleCalendarProvider     ← existing
    ├── NoOpCalendarProvider       ← existing (DB-only, no external sync)
    ├── OutlookCalendarProvider    ← you'd add this
    └── CalDavCalendarProvider     ← you'd add this
```

**Key principle:** The booking service doesn't know or care which calendar
provider is active. It calls `provider.createEvent(...)` and gets back an
event ID. The factory decides which provider to use based on the tenant config.

**Postgres is always the source of truth.** The calendar provider is a
*mirror* — if the external calendar is down, the booking still succeeds.
Calendar sync happens **after** the DB commit (same pattern as Excel sync).

---

## 2. The CalendarProvider Interface

This is the contract every calendar adapter must implement:

```typescript
// src/integrations/calendar/index.ts

import type { Tenant } from '../../domain/types.js';

export interface CalendarEvent {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timezone: string;
}

export interface CalendarProvider {
  /** Unique name for this provider */
  readonly name: string;   // 'google' | 'outlook' | 'caldav' | 'none'

  /**
   * Generate an OAuth/auth URL for a tenant to connect their calendar.
   * Return empty string if the provider doesn't use OAuth.
   */
  getAuthUrl(tenantId: string): string;

  /**
   * Handle the OAuth callback (exchange code for tokens, store them).
   * No-op if the provider doesn't use OAuth.
   */
  handleCallback(code: string, tenantId: string): Promise<void>;

  /**
   * Create a calendar event. Returns the external event ID.
   * This is called AFTER the booking is committed to Postgres.
   */
  createEvent(tenant: Tenant, event: CalendarEvent): Promise<string>;

  /**
   * Delete a calendar event by its external ID.
   * Called on cancellation.
   */
  deleteEvent(tenant: Tenant, eventId: string): Promise<void>;

  /**
   * List events in a time range.
   * Used for cross-checking availability against the external calendar.
   */
  listEvents(
    tenant: Tenant,
    from: Date,
    to: Date,
  ): Promise<Array<{ start: string; end: string }>>;
}
```

### Method Responsibilities

| Method | When Called | Must Succeed? |
|---|---|---|
| `getAuthUrl` | User clicks "Connect Calendar" in admin UI | Yes — return URL |
| `handleCallback` | OAuth redirect arrives at `/api/oauth/*/callback` | Yes — store tokens |
| `createEvent` | After `booking.service.confirmBooking()` commits | No — best-effort. Booking exists in DB regardless. |
| `deleteEvent` | After `booking.service.cancel()` commits | No — best-effort |
| `listEvents` | During `availability.service.getAvailableSlots()` | Yes — needed for accuracy. But system still works if it fails (DB-only slots). |

---

## 3. Walkthrough: How GoogleCalendar Implements It

The existing Google Calendar integration lives in `src/services/calendar.service.ts`.
Here's how it maps to the interface:

```typescript
// Simplified view of the current google implementation:

import { google } from 'googleapis';

class GoogleCalendarProvider implements CalendarProvider {
  readonly name = 'google';

  getAuthUrl(tenantId: string): string {
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar'],
      state: tenantId,
    });
  }

  async handleCallback(code: string, tenantId: string): Promise<void> {
    const { tokens } = await oauth2Client.getToken(code);
    await tenantRepo.updateOAuthTokens(tenantId, tokens);
    // Also discover primary calendar ID
  }

  async createEvent(tenant: Tenant, event: CalendarEvent): Promise<string> {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });
    const { data } = await calendar.events.insert({ ... });
    return data.id!;
  }

  async deleteEvent(tenant: Tenant, eventId: string): Promise<void> {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: ..., eventId });
  }

  async listEvents(tenant: Tenant, from: Date, to: Date) {
    const auth = this.getAuthForTenant(tenant);
    const calendar = google.calendar({ version: 'v3', auth });
    const { data } = await calendar.events.list({ timeMin: from, timeMax: to, ... });
    return data.items.map(e => ({ start: e.start.dateTime, end: e.end.dateTime }));
  }
}
```

---

## 4. Step-by-Step: Add a New Provider

Let's say you're adding **Microsoft Outlook** via the Microsoft Graph API.

### Step 1: Create the Adapter File

```bash
touch src/backend/src/integrations/calendar/outlook-calendar.ts
```

### Step 2: Implement the Interface

```typescript
// src/integrations/calendar/outlook-calendar.ts

import type { Tenant } from '../../domain/types.js';
import type { CalendarProvider, CalendarEvent } from './index.js';
import { env } from '../../config/env.js';
import { tenantRepo } from '../../repos/tenant.repo.js';

export class OutlookCalendarProvider implements CalendarProvider {
  readonly name = 'outlook';

  getAuthUrl(tenantId: string): string {
    const params = new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: env.MICROSOFT_REDIRECT_URI,
      scope: 'Calendars.ReadWrite offline_access',
      state: tenantId,
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  }

  async handleCallback(code: string, tenantId: string): Promise<void> {
    // Exchange code for tokens via Microsoft Graph
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.MICROSOFT_CLIENT_ID,
        client_secret: env.MICROSOFT_CLIENT_SECRET,
        code,
        redirect_uri: env.MICROSOFT_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await response.json();

    // Store tokens in tenant record
    await tenantRepo.update(tenantId, {
      outlook_oauth_tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: Date.now() + tokens.expires_in * 1000,
      },
    });
  }

  async createEvent(tenant: Tenant, event: CalendarEvent): Promise<string> {
    const accessToken = await this.getAccessToken(tenant);

    const response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subject: event.summary,
        body: { contentType: 'text', content: event.description },
        start: { dateTime: event.start.toISOString(), timeZone: event.timezone },
        end: { dateTime: event.end.toISOString(), timeZone: event.timezone },
      }),
    });

    const data = await response.json();
    return data.id;
  }

  async deleteEvent(tenant: Tenant, eventId: string): Promise<void> {
    const accessToken = await this.getAccessToken(tenant);
    await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  async listEvents(
    tenant: Tenant,
    from: Date,
    to: Date,
  ): Promise<Array<{ start: string; end: string }>> {
    const accessToken = await this.getAccessToken(tenant);
    const params = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: to.toISOString(),
      $select: 'start,end',
      $orderby: 'start/dateTime',
    });

    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarview?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    const data = await response.json();
    return (data.value ?? []).map((e: any) => ({
      start: e.start.dateTime,
      end: e.end.dateTime,
    }));
  }

  // ── Private helpers ─────────────────────────────────

  private async getAccessToken(tenant: Tenant): Promise<string> {
    const tokens = (tenant as any).outlook_oauth_tokens;
    if (!tokens) throw new Error(`Tenant ${tenant.id} has no Outlook tokens`);

    // TODO: Check expiry and refresh if needed
    return tokens.access_token;
  }
}
```

### Step 3: Add Environment Variables

In `src/config/env.ts`:

```typescript
// ── Microsoft / Outlook Calendar ─────────────────────
MICROSOFT_CLIENT_ID: z.string().optional().default(''),
MICROSOFT_CLIENT_SECRET: z.string().optional().default(''),
MICROSOFT_REDIRECT_URI: z.string().optional().default('http://localhost:3000/api/oauth/outlook/callback'),
```

### Step 4: Add OAuth Callback Route

In `src/routes/oauth.routes.ts`, add a handler for the Outlook callback:

```typescript
app.get('/api/oauth/outlook/callback', async (req, reply) => {
  const { code, state: tenantId } = req.query as { code: string; state: string };
  const provider = getCalendarProvider('outlook');
  await provider.handleCallback(code, tenantId);
  reply.send({ success: true });
});
```

---

## 5. Wire It Into the Factory

The factory selects the right provider based on tenant configuration:

```typescript
// src/integrations/calendar/index.ts

import { GoogleCalendarProvider } from './google-calendar.js';
import { OutlookCalendarProvider } from './outlook-calendar.js';
import { NoOpCalendarProvider } from './no-op-calendar.js';

const providers: Record<string, CalendarProvider> = {
  google: new GoogleCalendarProvider(),
  outlook: new OutlookCalendarProvider(),
  none: new NoOpCalendarProvider(),
};

/**
 * Get the calendar provider for a tenant.
 *
 * Resolution order:
 * 1. If tenant has google_oauth_tokens → Google
 * 2. If tenant has outlook_oauth_tokens → Outlook
 * 3. Fallback → NoOp (DB-only scheduling)
 */
export function getCalendarProvider(tenant: Tenant): CalendarProvider {
  if (tenant.google_oauth_tokens) return providers.google;
  if ((tenant as any).outlook_oauth_tokens) return providers.outlook;
  return providers.none;
}

// Or by explicit name:
export function getCalendarProviderByName(name: string): CalendarProvider {
  return providers[name] ?? providers.none;
}
```

---

## 6. Testing Your Adapter

### Unit Test Pattern

```typescript
import { describe, it, expect } from 'vitest'; // or your test runner

describe('OutlookCalendarProvider', () => {
  it('generates a valid auth URL', () => {
    const provider = new OutlookCalendarProvider();
    const url = provider.getAuthUrl('tenant-123');
    expect(url).toContain('login.microsoftonline.com');
    expect(url).toContain('tenant-123');
  });

  it('creates events via Graph API', async () => {
    // Mock fetch to intercept Graph API calls
    const provider = new OutlookCalendarProvider();
    const eventId = await provider.createEvent(mockTenant, {
      summary: 'Test Appointment',
      description: 'Test',
      start: new Date('2026-02-10T10:00:00Z'),
      end: new Date('2026-02-10T10:30:00Z'),
      timezone: 'America/New_York',
    });
    expect(eventId).toBeTruthy();
  });
});
```

### Integration Test

```bash
# 1. Set env vars for Outlook
export MICROSOFT_CLIENT_ID=your-id
export MICROSOFT_CLIENT_SECRET=your-secret

# 2. Create a tenant with Outlook tokens (via API or seed)
# 3. Book an appointment → verify event appears in Outlook calendar
# 4. Cancel appointment → verify event removed from Outlook
```

---

## 7. NoOp Calendar (Default)

When no calendar provider is configured, the system uses `NoOpCalendarProvider`:

```typescript
// src/integrations/calendar/no-op-calendar.ts

export class NoOpCalendarProvider implements CalendarProvider {
  readonly name = 'none';

  getAuthUrl(_tenantId: string): string {
    return ''; // No OAuth needed
  }

  async handleCallback(_code: string, _tenantId: string): Promise<void> {
    // No-op
  }

  async createEvent(_tenant: Tenant, _event: CalendarEvent): Promise<string> {
    return 'no-op'; // Return a placeholder ID
  }

  async deleteEvent(_tenant: Tenant, _eventId: string): Promise<void> {
    // No-op
  }

  async listEvents(_tenant: Tenant, _from: Date, _to: Date) {
    return []; // No external events — DB is the only source
  }
}
```

This means the system works **perfectly fine without any external calendar**.
Availability is calculated from the database alone. This is the default for
new tenants until they connect a calendar.

---

## 8. FAQ

**Q: Can a tenant switch calendar providers?**
A: Yes. Update the tenant record to clear old tokens and set new ones. The
factory auto-selects based on which tokens are present.

**Q: What if the calendar API is down during a booking?**
A: The booking succeeds in Postgres. The calendar create fails gracefully
(logged, not thrown). The reconciliation job will retry later. Zero customer impact.

**Q: Can I support multiple calendars per tenant?**
A: The current interface is single-calendar-per-tenant. For multi-calendar
(e.g., one per provider), extend the interface to accept a `calendarId` parameter.

**Q: What about CalDAV (self-hosted Nextcloud, Radicale)?**
A: Create a `CalDavCalendarProvider` that uses the `tsdav` or `ical.js` library.
The interface is the same — just different HTTP calls.

**Q: Do I need to modify the AI agent for a new calendar?**
A: No. The agent calls `check_availability` / `confirm_booking` — these are
service-layer tools that are calendar-agnostic. The agent never interacts
with the calendar directly.
