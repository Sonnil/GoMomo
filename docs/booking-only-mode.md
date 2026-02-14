# Booking-Only Mode

**Status:** LOCKED ✅ — Active on company PC since 2026-02-10  
**Feature Flags:** `FEATURE_CALENDAR_BOOKING=true`, `FEATURE_SMS=false`, `FEATURE_VOICE=false`  
**ngrok:** Not installed. Not required. Must not be reintroduced on company hardware.

---

## 1. Purpose

Booking-only mode runs gomomo.ai with **calendar booking via web
chat only**. All SMS and Voice (Twilio) functionality is disabled at the
feature-flag level. The app starts, serves, and operates with:

- **Zero Twilio credentials** in the environment
- **Zero external tunnels** (no ngrok, no Cloudflare Tunnel, no localtunnel)
- **Zero inbound webhooks** from third-party services
- **No network exposure** beyond `localhost`

This is the required configuration for company-managed hardware where
security policy prohibits external tunnel software and third-party
webhook endpoints.

---

## 2. Feature Flags

| Flag | Default | Booking-Only | Description |
| ---- | ------- | ------------ | ----------- |
| `FEATURE_CALENDAR_BOOKING` | `true` | `true` | Calendar availability + booking flow |
| `FEATURE_SMS` | `true` | **`false`** | All SMS: inbound, outbound, reminders, status callbacks |
| `FEATURE_VOICE` | `true` | **`false`** | All voice: inbound calls, TwiML, handoff |

These are **master kill switches** above the per-feature flags
(`VOICE_ENABLED`, `SMS_INBOUND_ENABLED`, `SMS_HANDOFF_ENABLED`). When a
master flag is `false`, the corresponding per-feature flags are ignored.

---

## 3. What Gets Disabled

### When `FEATURE_SMS=false`

| Component | Behavior |
| --------- | -------- |
| `POST /twilio/sms/incoming` | Route **not registered** → 404 |
| `POST /webhooks/twilio/status` | Route **not registered** → 404 |
| `GET /health/sms` | Returns `{ status: "disabled" }` |
| `sendSms()` | Returns `{ success: false }` immediately (no-op) |
| `sendOutboundSms()` | Returns `{ sent: false }` immediately (no-op) |
| SMS reminders (`on-booking-created`) | **Not scheduled** |
| SMS booking confirmations | **Not sent** |
| SMS outbox poller (orchestrator) | **Not started** |
| Twilio startup credential check | **Skipped** |
| Tool executor SMS status hint | Reports `"disabled"` |

### When `FEATURE_VOICE=false`

| Component | Behavior |
| --------- | -------- |
| `POST /twilio/voice/incoming` | Route **not registered** → 404 |
| `POST /twilio/voice/continue` | Route **not registered** → 404 |
| Voice handoff routes | Route **not registered** → 404 |
| Twilio startup credential check | **Skipped** (when also SMS=false) |

---

## 4. What Stays Working

- ✅ Web chat (Socket.IO + REST)
- ✅ Availability API (`GET /api/tenants/:tenantId/availability`)
- ✅ Appointment API (create, list, cancel)
- ✅ Google Calendar integration (read + write, when `CALENDAR_MODE=real`)
- ✅ Calendar busy-time exclusion
- ✅ Customer identity resolution
- ✅ SDK auth + session tokens
- ✅ Admin endpoints
- ✅ CEO test endpoints (dev mode)
- ✅ Excel integration (if enabled)
- ✅ Autonomy job runner (non-SMS jobs still execute)
- ✅ Health endpoint (`GET /health` → `{ status: "ok" }`)

---

## 5. Required Environment Variables (Company PC — Booking-Only)

Only these are required in `src/backend/.env`:

```env
# ── Core (always required) ───────────────────────────────────
DATABASE_URL=postgresql://receptionist:receptionist_dev@localhost:5432/receptionist
OPENAI_API_KEY=sk-...your-key...
NODE_ENV=development

# ── Feature Flags (booking-only mode) ────────────────────────
FEATURE_CALENDAR_BOOKING=true
FEATURE_SMS=false
FEATURE_VOICE=false

# ── Twilio: NOT required — leave empty or omit entirely ──────
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=
# TWILIO_MESSAGING_SERVICE_SID=
```

**No ngrok required.** No external tunnel of any kind is needed.

---

## 6. Security Note (Audit-Ready)

> **Booking-only mode security posture (2026-02-10):**
>
> 1. **No external tunnels.** ngrok has been uninstalled. No software
>    exposes local ports to the public internet.
> 2. **No Twilio webhooks.** All `/twilio/*` routes return 404. No
>    third-party service can POST to the server.
> 3. **No Twilio credentials at runtime.** The app starts and operates
>    with empty `TWILIO_*` environment variables. No API keys for
>    external messaging services are present.
> 4. **No outbound SMS/Voice.** All send functions return no-op results.
>    No data leaves the machine via Twilio.
> 5. **Network scope: localhost only.** The backend listens on port 3000,
>    the frontend on port 5173 — both bound to localhost for development.
> 6. **Feature flags are environment-variable based.** Changing mode
>    requires editing `.env` and restarting — no runtime API can toggle
>    SMS/Voice on.
> 7. **All changes are reversible.** Setting `FEATURE_SMS=true` and
>    `FEATURE_VOICE=true` restores full functionality. No code changes needed.

---

## 7. Startup Logs (Expected Output)

When the server starts in booking-only mode, you should see:

```
[orchestrator] SMS outbox poller skipped (FEATURE_SMS=false)
ℹ️  FEATURE_SMS=false, FEATURE_VOICE=false — Twilio validation skipped (booking-only mode).
ℹ️  FEATURE_VOICE=false — voice routes not registered (booking-only mode).
ℹ️  FEATURE_SMS=false — inbound SMS routes not registered (booking-only mode).
ℹ️  FEATURE_SMS=false — SMS status callback not registered.
Server listening on http://0.0.0.0:3000
```

**No warnings. No errors. No Twilio-related messages beyond the skip notices.**

---

## 8. Verification Checklist

### Booking Flow (must work)

- [x] `GET /health` → `{ status: "ok" }`
- [x] `GET /api/tenants/:tenantId/availability?start=...&end=...` → slots returned
- [x] Booking via web chat creates appointment
- [x] Calendar event appears (if `CALENDAR_MODE=real`)
- [x] Server starts without Twilio credential errors

### SMS Disabled (must be blocked)

- [x] `POST /twilio/sms/incoming` → HTTP 404
- [x] `POST /webhooks/twilio/status` → HTTP 404
- [x] `GET /health/sms` → `{ status: "disabled" }`
- [x] No SMS confirmation sent after booking
- [x] No SMS reminders scheduled (`sms_outbox` pending = 0)
- [x] SMS outbox poller not running

### Voice Disabled (must be blocked)

- [x] `POST /twilio/voice/incoming` → HTTP 404
- [x] Voice/handoff routes → HTTP 404
- [x] Startup logs show booking-only mode messages

### No External Connectivity

- [x] No ngrok or tunnel software installed
- [x] No `TWILIO_WEBHOOK_BASE_URL` pointing to external URL
- [x] No background jobs attempt Twilio API calls
- [x] No runtime warnings about missing Twilio config

---

## 9. Transition Plan: Re-Enabling SMS + Voice (Personal Machine)

When you move to a personal machine where Twilio and tunnels are permitted:

### Step 1: Install tunnel software

```bash
# On personal machine only — NEVER on company hardware
brew install ngrok    # or cloudflared, localtunnel, etc.
ngrok http 3000
# Copy the https URL (e.g. https://abc123.ngrok-free.app)
```

### Step 2: Set environment variables

```env
# Feature Flags — re-enable
FEATURE_SMS=true
FEATURE_VOICE=true

# Twilio credentials (from twilio.com/console)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+15551234567
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Webhook URL (your tunnel URL)
TWILIO_WEBHOOK_BASE_URL=https://abc123.ngrok-free.app
```

### Step 3: Configure Twilio Console

1. Go to **Twilio Console → Phone Numbers → your number**
2. Set Voice webhook: `https://<tunnel>/twilio/voice/incoming` (POST)
3. Set Messaging webhook: `https://<tunnel>/twilio/sms/incoming` (POST)
4. Set Status callback: `https://<tunnel>/webhooks/twilio/status` (POST)

### Step 4: Restart and verify

```bash
cd src/backend && npx tsx src/index.ts
# Should see:
#   ✅ Twilio SMS config OK
#   ✅ Twilio credentials verified
#   Voice channel enabled
#   Inbound SMS channel enabled
```

### One-Time Setup (if not previously done)

- **Twilio account:** Sign up at [twilio.com](https://www.twilio.com)
- **Phone number:** Buy a local or toll-free number
- **A2P 10DLC registration:** Required for US local numbers (submit via Twilio Console)
- **Google OAuth:** Required for `CALENDAR_MODE=real` — see `docs/voice-setup.md`

---

## 10. Copy-Paste Quick Reference

### Company PC (Booking-Only) — Start

```bash
cd src/backend
npx tsx src/index.ts
# Or use VS Code task: Terminal → Run Task → backend-server
```

### Company PC — Verify

```bash
curl -s http://localhost:3000/health                          # → { status: "ok" }
curl -s http://localhost:3000/health/sms                      # → { status: "disabled" }
curl -s -o /dev/null -w "%{http_code}" -X POST \
  http://localhost:3000/twilio/voice/incoming                  # → 404
curl -s -o /dev/null -w "%{http_code}" -X POST \
  http://localhost:3000/twilio/sms/incoming                    # → 404
```

### Personal PC (Full Features) — Start

```bash
# Terminal 1: tunnel
ngrok http 3000

# Terminal 2: backend (with FEATURE_SMS=true, FEATURE_VOICE=true in .env)
cd src/backend
npx tsx src/index.ts
```

---

## 11. Reversibility

All changes are **environment-variable only**. To switch between modes:

| Action | How |
| ------ | --- |
| Enable booking-only | Set `FEATURE_SMS=false`, `FEATURE_VOICE=false` in `.env` → restart |
| Enable full features | Set `FEATURE_SMS=true`, `FEATURE_VOICE=true` in `.env` → restart |

**No code changes. No branch switching. No dependency changes.**
