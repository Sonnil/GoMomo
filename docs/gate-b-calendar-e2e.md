# Gate B — Real Google Calendar E2E Verification Guide

> **Purpose:** Prove that real busy events on a connected Google Calendar block
> offered slots. This is the acceptance gate for calendar-read pilot readiness.

---

## Part 1 — Google Cloud Setup Checklist

### 1.1 Create / select a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one), e.g. `ai-receptionist-pilot`
3. Note the **Project ID** — you'll need it nowhere, but it helps organize things

### 1.2 Enable the Google Calendar API

1. In the Cloud Console → **APIs & Services → Library**
2. Search for **Google Calendar API**
3. Click **Enable**

### 1.3 Configure OAuth Consent Screen

1. **APIs & Services → OAuth consent screen**
2. Choose **External** (works in test mode without verification)
3. Fill in:
   - **App name:** `AI Receptionist (dev)`
   - **User support email:** your email
   - **Developer contact:** your email
4. **Scopes:** Add `https://www.googleapis.com/auth/calendar`
5. **Test users:** Add the Google account whose calendar you want to read
6. Click **Save** (leave in **Testing** status — no need to publish)

### 1.4 Create OAuth Client Credentials

1. **APIs & Services → Credentials**
2. Click **+ CREATE CREDENTIALS → OAuth client ID**
3. Application type: **Web application**
4. Name: `AI Receptionist Local`
5. **Authorized redirect URIs:** Add exactly:
   ```
   http://localhost:3000/api/oauth/google/callback
   ```
6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

---

## Part 2 — Environment Variables

Add these to `src/backend/.env`:

```bash
# ── Google Calendar (Gate B) ─────────────────────────────────
CALENDAR_MODE=real
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-<your-secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/oauth/google/callback

# ── Strict mode: refuse unverified slots ─────────────────────
CALENDAR_READ_REQUIRED=true

# ── Debug: see busy ranges + exclusion attribution ───────────
CALENDAR_DEBUG=true

# ── Turn off demo availability (use real tenant hours) ───────
DEMO_AVAILABILITY=false
```

> **Important:** Set `DEMO_AVAILABILITY=false` so the availability engine uses
> the tenant's actual business hours and actually queries Google Calendar.
> When `DEMO_AVAILABILITY=true`, the engine skips calendar reads entirely.

---

## Part 3 — Connect Google Calendar (OAuth Flow)

### 3.1 Start the stack

```bash
npm run demo:start
```

### 3.2 Get the OAuth authorization URL

```bash
# Replace ADMIN_KEY with your ADMIN_API_KEY from .env
TENANT=00000000-0000-4000-a000-000000000001
ADMIN_KEY=<your-admin-api-key>

curl -s http://localhost:3000/api/tenants/$TENANT/oauth/google \
  -H "X-Admin-Key: $ADMIN_KEY" | jq .
```

Response:
```json
{
  "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&...",
  "calendar_mode": "google"
}
```

### 3.3 Complete OAuth consent

1. **Copy the `authorization_url`** from the response
2. **Open it in your browser**
3. Sign in with the Google account you added as a test user
4. Click **Continue** (the "unverified app" warning is expected in test mode)
5. Grant calendar access
6. You'll be redirected to `localhost:3000/api/oauth/google/callback?code=...&state=...`
7. The response should be:
   ```json
   { "success": true, "message": "Google Calendar connected.", "calendar_mode": "google" }
   ```

### 3.4 Verify connectivity

```bash
curl -s http://localhost:3000/api/dev/calendar-debug/$TENANT/connectivity \
  -H "X-Admin-Key: $ADMIN_KEY" | jq .
```

Expected:
```json
{
  "status": "connected",
  "calendar_id": "your@gmail.com",
  "provider": "google",
  "query_window": { "from": "...", "to": "..." },
  "busy_ranges": [ ... ],
  "busy_count": 3
}
```

---

## Part 4 — E2E Proof Test Procedure

### 4.1 Create a busy event in your Google Calendar

1. Open [Google Calendar](https://calendar.google.com)
2. Create an event on the **next Monday** (or any upcoming business day):
   - **Title:** Anything (not logged by our system — PII-safe)
   - **Time:** `1:00 PM – 2:00 PM` in your timezone
   - **Ensure it shows as "Busy"** (default for regular events)
3. Optionally create a second event at `3:00 PM – 3:30 PM` for extra proof

### 4.2 Query availability via curl

```bash
# Set the date to the Monday you created the event on (adjust to your date)
DATE="2026-02-09"

curl -s "http://localhost:3000/api/tenants/$TENANT/availability?start=${DATE}T00:00:00Z&end=${DATE}T23:59:59Z" \
  -H "Authorization: Bearer admin.$ADMIN_KEY" | jq .
```

### 4.3 Check the debug endpoint

```bash
curl -s http://localhost:3000/api/dev/calendar-debug/$TENANT \
  -H "X-Admin-Key: $ADMIN_KEY" | jq .
```

### 4.4 Expected results

| What to check | Expected |
|---|---|
| `verified` | `true` |
| `calendar_source` in availability response | `"google"` |
| Slots at 1:00 PM and 1:30 PM | `"available": false` |
| Slots at 12:00 PM and 12:30 PM | `"available": true` |
| Debug `busy_ranges_fetched` | Contains your 1:00–2:00 PM range |
| Debug `slots_excluded_by_busy` | ≥ 2 (the slots inside your busy event) |
| Backend logs | `[calendar-debug]` lines showing busy ranges and exclusion counts |

### 4.5 Chat UI verification

1. Open `http://localhost:5173?demo=1`
2. Ask: *"What's available next Monday afternoon?"*
3. The AI should **NOT** offer 1:00 PM or 1:30 PM
4. The AI **should** offer other open slots (e.g. 2:00 PM, 2:30 PM)

---

## Part 5 — Strict-Mode Failure Test

To verify that `CALENDAR_READ_REQUIRED=true` works:

1. Temporarily revoke OAuth tokens:
   ```sql
   -- Connect to your local PG (port 5432)
   UPDATE tenants SET google_oauth_tokens = NULL WHERE id = '00000000-0000-4000-a000-000000000001';
   ```
2. Query availability — should get an error:
   ```bash
   curl -s "http://localhost:3000/api/tenants/$TENANT/availability?start=2026-02-09T00:00:00Z&end=2026-02-09T23:59:59Z" \
     -H "Authorization: Bearer admin.$ADMIN_KEY"
   ```
   Expected: **500** with error message containing *"Cannot check schedule right now"*
3. Re-run the OAuth flow (Part 3) to reconnect

> Note: When `CALENDAR_READ_REQUIRED=true` and `CALENDAR_MODE=real`,
> the system will NOT offer unverified slots if the external calendar
> becomes unreachable. This is the fail-closed behavior we want for pilot.

---

## Part 6 — Troubleshooting: Top 5 Issues

### 1. "redirect_uri_mismatch" error at Google consent

**Cause:** The redirect URI in your OAuth client doesn't match `GOOGLE_REDIRECT_URI`.
**Fix:** In Google Cloud Console → Credentials → your OAuth client → Authorized redirect URIs,
add exactly: `http://localhost:3000/api/oauth/google/callback`
(trailing slashes, `https` vs `http`, and port all matter).

### 2. "access_denied" or "This app is blocked"

**Cause:** Your Google account is not listed as a test user.
**Fix:** OAuth consent screen → Test users → Add your `@gmail.com`.
The consent screen must be in "Testing" status (not published).

### 3. "Failed to obtain OAuth tokens" (no refresh_token)

**Cause:** Google only returns `refresh_token` on the first consent. If you
previously authorized and revoked, it may not send it again.
**Fix:** Add `prompt: 'consent'` to `generateAuthUrl` (already done in our code).
Or revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
and re-authorize.

### 4. Slots show as available despite busy event

**Cause (a):** `DEMO_AVAILABILITY=true` — the demo engine bypasses calendar reads.
**Fix:** Set `DEMO_AVAILABILITY=false` in `.env`.

**Cause (b):** Event marked as "Free" instead of "Busy" in Google Calendar.
**Fix:** Edit the event → set "Show as" to "Busy".

**Cause (c):** Timezone mismatch — event is at 1 PM in a different timezone.
**Fix:** Ensure the tenant's `timezone` matches your Google Calendar timezone.
Check the debug endpoint's `busy_ranges_fetched` to see exact UTC times.

### 5. "Tenant has no Google OAuth tokens" error

**Cause:** OAuth flow was never completed, or tokens were lost.
**Fix:** Re-run Part 3 (get auth URL → open in browser → consent → callback).
Verify with the connectivity endpoint:
```bash
curl -s http://localhost:3000/api/dev/calendar-debug/$TENANT/connectivity \
  -H "X-Admin-Key: $ADMIN_KEY"
```

---

## Quick Reference — Env Vars for Gate B

| Variable | Value for E2E test | Purpose |
|---|---|---|
| `CALENDAR_MODE` | `real` | Use live Google Calendar |
| `GOOGLE_CLIENT_ID` | `<from Cloud Console>` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | `<from Cloud Console>` | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/api/oauth/google/callback` | OAuth callback (must match Console) |
| `CALENDAR_READ_REQUIRED` | `true` | Fail-closed if calendar unavailable |
| `CALENDAR_DEBUG` | `true` | Enable debug logging + debug endpoints |
| `DEMO_AVAILABILITY` | `false` | Use real tenant hours (not demo Mon-Fri 9-5) |
| `CALENDAR_BUSY_CACHE_TTL_SECONDS` | `5` | Short cache for testing (default 30) |

---

## Quick Reference — Verification Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/tenants/:id/oauth/google` | Admin key | Get OAuth authorization URL |
| `GET /api/oauth/google/callback` | Public (Google redirect) | OAuth callback |
| `GET /api/tenants/:id/availability?start=&end=` | Session token or admin | Query slots |
| `GET /api/dev/calendar-debug/:id` | Admin key | Last debug snapshot |
| `GET /api/dev/calendar-debug/:id/connectivity` | Admin key | Live connectivity test |
