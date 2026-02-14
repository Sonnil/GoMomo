# Email Gate — End-to-End Testing Guide

> Quick-reference for manually verifying the email-gated chat flow
> locally or in a staging environment.

---

## 1. Environment Variables

### Local dev (console provider — no real email)

```env
# .env  (src/backend/.env)
REQUIRE_EMAIL_AFTER_FIRST_MESSAGE=true
EMAIL_PROVIDER=resend          # or postmark / console
EMAIL_FROM=Gomomo.ai <aireceptionistt@gmail.com>
EMAIL_DEV_MODE=true            # ← forces console provider, OTP logged to stdout
EMAIL_VERIFICATION_TTL_MINUTES=10
EMAIL_VERIFICATION_MAX_ATTEMPTS=5
EMAIL_VERIFICATION_RATE_LIMIT=5
```

With `EMAIL_DEV_MODE=true` no real email is sent. The 6-digit OTP
code appears in the **backend terminal** prefixed with `[EMAIL:console]`.

### Prod-like (real email delivery)

```env
EMAIL_DEV_MODE=false
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=Gomomo.ai <aireceptionistt@gmail.com>   # must be verified with Resend
EMAIL_REPLY_TO=                # optional
```

Or for Postmark:

```env
EMAIL_DEV_MODE=false
EMAIL_PROVIDER=postmark
POSTMARK_API_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
EMAIL_FROM=Gomomo.ai <aireceptionistt@gmail.com>   # sender signature must exist in Postmark
```

---

## 2. Quick Health Check

Before testing, confirm the email subsystem is wired:

```bash
curl -s http://localhost:3000/health/email | jq .
```

Expected (dev):

```json
{
  "status": "ok",
  "timestamp": "2026-02-10T…",
  "provider": "resend",
  "dev_mode": true,
  "effective_provider": "console",
  "credentials_present": false,
  "email_gate_enabled": true,
  "ttl_minutes": 10,
  "rate_limit": 5
}
```

Key fields:

| Field                | Meaning                                           |
|----------------------|---------------------------------------------------|
| `dev_mode`           | `true` = OTP logged, not emailed                  |
| `effective_provider` | What actually sends (console when dev_mode=true)  |
| `credentials_present`| Whether the active provider's API key is set       |
| `email_gate_enabled` | `REQUIRE_EMAIL_AFTER_FIRST_MESSAGE`               |

---

## 3. Step-by-Step Incognito Test Script

### Prerequisites

Start all three services:

```bash
# Terminal 1 — Backend (Fastify :3000)
cd src/backend && npm run dev

# Terminal 2 — Frontend widget (Vite :5173)
cd src/frontend && npm run dev

# Terminal 3 — Marketing site (Next.js :3001)
cd src/web && npm run dev
```

### Steps

| #  | Action                                               | Expected                                                         |
|----|------------------------------------------------------|------------------------------------------------------------------|
| 1  | Open **http://localhost:3001** in an **incognito** window | Landing page loads; "Try it now →" visible                      |
| 2  | Click **"Try it now →"**                             | Page scrolls to the embedded chat widget                         |
| 3  | Type a message (e.g. "Hello") and send               | Agent responds normally (1st message is free)                    |
| 4  | Type a **second** message (e.g. "Book an appointment")| **Email gate modal** appears: "Enter your email"                |
| 5  | Enter an email (e.g. `test@example.com`) → Submit    | Modal switches to "Enter verification code" (6-digit input)     |
| 6  | **Find the code** (see § 4 below)                    | Enter the 6-digit code → click **Verify**                       |
| 7  | Verification succeeds                                | Modal closes; chat resumes; your second message is delivered     |
| 8  | Send more messages                                   | No further gate — session is verified                            |

### Step 6 — finding the OTP code

- **Dev mode** (`EMAIL_DEV_MODE=true`):
  Look in the **backend terminal** for:
  ```
  [EMAIL:console] To: test@example.com | Subject: Your gomomo verification code | Body: Your verification code is: 753932
  ```
  The 6-digit number is your code.

- **Prod-like** (`EMAIL_DEV_MODE=false`):
  Check the actual email inbox for subject **"Your gomomo verification code"**.

---

## 4. Expected Server Log Lines (dev mode)

When `EMAIL_DEV_MODE=true` and `NODE_ENV !== 'production'`:

```
[EMAIL:console] To: test@example.com | Subject: Your gomomo verification code | Body: Your verification code is: 753932
…
[18:06:56.217] INFO: Verification code created (dev mode)
    email: "test@example.com"
    session_id: "8wUxWNXT…"
    code: "753932"
```

When `NODE_ENV=production` (regardless of `EMAIL_DEV_MODE`):

```
[18:06:56.217] INFO: Verification code sent
    email: "test@example.com"
    session_id: "8wUxWNXT…"
```

> **Note:** The OTP code is **never** logged in production. It is only
> visible in the log when `NODE_ENV` is `development` or `test`.

---

## 5. Common Failure Modes + Fixes

| Symptom                                              | Cause                                           | Fix                                                              |
|------------------------------------------------------|--------------------------------------------------|------------------------------------------------------------------|
| Modal never appears                                  | `REQUIRE_EMAIL_AFTER_FIRST_MESSAGE=false`        | Set to `true` in `.env`, restart backend                         |
| "Unable to send verification email" (502)            | Email provider returned an error                 | Check backend logs for `Failed to send verification email`; verify API key + sender domain |
| Code works in dev but not prod                       | `EMAIL_DEV_MODE=true` in prod                    | Set `EMAIL_DEV_MODE=false` + provide `RESEND_API_KEY`            |
| "Too many verification codes requested" (429)        | Rate limit hit (5 per email per hour)            | Wait 1 hour, or increase `EMAIL_VERIFICATION_RATE_LIMIT` for testing |
| "Please use a permanent email address"               | Disposable email domain blocked                  | Use a real email domain (not mailinator, guerrillamail, etc.)    |
| No `[EMAIL:console]` line in backend logs            | Provider is `resend`/`postmark` + dev_mode=false | The code was sent via real email; check your inbox               |
| `/health/email` shows `credentials_present: false`   | API key not set for the configured provider      | Set `RESEND_API_KEY` or `POSTMARK_API_TOKEN` in `.env`           |
| Chat widget not loading in Next.js site              | Vite frontend not running on :5173               | Start `cd src/frontend && npm run dev`                           |
| CORS error on `/api/auth/request-code`               | Backend not running or wrong `CORS_ORIGIN`       | Start backend; ensure `CORS_ORIGIN=http://localhost:5173`        |
