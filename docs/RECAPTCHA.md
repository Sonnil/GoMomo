# reCAPTCHA v3 — Spam Protection

Google reCAPTCHA v3 protects two public-facing actions from automated abuse:

| Action | Route / Component | When checked |
|--------|------------------|--------------|
| **Booking intake** | `POST /api/tenants/:tenantId/chat` (messages starting with `BOOKING_REQUEST:`) | Before processing the booking request |
| **Email verification** | `POST /api/auth/request-code` | Before generating and sending the OTP |

reCAPTCHA v3 is **invisible** — there is no checkbox or puzzle. Google assigns a score between 0.0 (likely bot) and 1.0 (likely human). Requests below the configured threshold are rejected.

---

## Quick Start (Local Development)

By default **reCAPTCHA is disabled** (`RECAPTCHA_ENABLED=false`). No configuration is needed for local dev — all captcha checks are skipped.

To enable it locally for testing:

1. **Register a reCAPTCHA v3 site** at <https://www.google.com/recaptcha/admin/create>
   - Choose **reCAPTCHA v3**
   - Add `localhost` to the allowed domains
   - Copy the **Site Key** and **Secret Key**

2. **Set backend env vars** in `src/backend/.env`:

   ```bash
   RECAPTCHA_ENABLED=true
   RECAPTCHA_SITE_KEY=6Lc...your-site-key
   RECAPTCHA_SECRET_KEY=6Lc...your-secret-key
   RECAPTCHA_MIN_SCORE=0.5
   ```

3. **Set frontend env vars** in `src/frontend/.env` (or project-root `.env` for Docker Compose):

   ```bash
   VITE_RECAPTCHA_ENABLED=true
   VITE_RECAPTCHA_SITE_KEY=6Lc...your-site-key
   ```

4. Restart both backend and frontend.

---

## Environment Variables

### Backend (`src/backend/.env`)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `RECAPTCHA_ENABLED` | `'true' \| 'false'` | `'false'` | Master switch — all checks skipped when false |
| `RECAPTCHA_SITE_KEY` | `string` | `''` | Public site key (required when enabled) |
| `RECAPTCHA_SECRET_KEY` | `string` | `''` | Secret key for server-side verification (required when enabled) |
| `RECAPTCHA_MIN_SCORE` | `number` | `0.5` | Score threshold — requests below this are rejected (0.0–1.0) |

> **Validation:** When `RECAPTCHA_ENABLED=true`, the Zod env schema requires both `RECAPTCHA_SITE_KEY` and `RECAPTCHA_SECRET_KEY` to be non-empty. The server will refuse to start if they are missing.

### Frontend (`src/frontend/.env` or root `.env`)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `VITE_RECAPTCHA_ENABLED` | `string` | — | Set to `'true'` to load the Google reCAPTCHA script |
| `VITE_RECAPTCHA_SITE_KEY` | `string` | — | Public site key (same value as `RECAPTCHA_SITE_KEY`) |

The frontend hook (`useRecaptcha`) only activates when **both** `VITE_RECAPTCHA_ENABLED === 'true'` **and** `VITE_RECAPTCHA_SITE_KEY` is non-empty.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React)                                    │
│                                                      │
│  IntakeForm / EmailGateModal                        │
│      │  useRecaptcha() hook                         │
│      │  → loads Google script (singleton)            │
│      │  → executeRecaptcha('book_appointment')      │
│      │  → returns token (string | null)              │
│      ▼                                               │
│  ChatWidget.sendViaRest / fetch('/api/auth/...')    │
│      body: { ..., recaptcha_token }                 │
└──────────────────┬──────────────────────────────────┘
                   │  HTTPS
┌──────────────────▼──────────────────────────────────┐
│  Backend (Fastify)                                   │
│                                                      │
│  Route handler checks:                              │
│   1. isRecaptchaEnabled() → false? skip entirely     │
│   2. Token missing? → 400                            │
│   3. verifyRecaptcha(token, req.ip)                 │
│      → POST https://google.com/recaptcha/siteverify │
│      → checks success + score ≥ threshold           │
│   4. Failed? → 400 "Verification failed"             │
│   5. Passed? → continue normal flow                  │
└─────────────────────────────────────────────────────┘
```

---

## Files Changed / Created

| File | Change |
|------|--------|
| `src/backend/src/config/env.ts` | Added 4 env vars + `superRefine` validation |
| `src/backend/src/auth/recaptcha.ts` | **NEW** — `verifyRecaptcha()` + `isRecaptchaEnabled()` |
| `src/backend/src/auth/email-verification.routes.ts` | Added captcha check in `/api/auth/request-code` |
| `src/backend/src/routes/chat.routes.ts` | Added captcha check on `BOOKING_REQUEST:` messages |
| `src/frontend/src/hooks/useRecaptcha.ts` | **NEW** — React hook for reCAPTCHA v3 token acquisition |
| `src/frontend/src/components/IntakeForm.tsx` | Integrated `useRecaptcha`, async submit |
| `src/frontend/src/components/EmailGateModal.tsx` | Integrated `useRecaptcha` in `handleRequestCode` |
| `src/frontend/src/components/ChatWidget.tsx` | `sendViaRest` extended with `extras` param |
| `src/backend/tests/recaptcha.test.ts` | **NEW** — 19 tests (unit + integration) |
| `src/backend/.env.example` | Added reCAPTCHA section |
| `.env.example` | Added reCAPTCHA section |

---

## Testing

### Automated Tests

```bash
cd src/backend
npx vitest run tests/recaptcha.test.ts
```

19 tests covering:
- `verifyRecaptcha` — success, missing token, invalid token, low score, network error, HTTP error, edge cases
- `isRecaptchaEnabled` — reflects env config
- Route enforcement — enabled+missing→reject, enabled+invalid→reject, disabled→passthrough, non-booking→skip

### Manual Testing

1. **Disabled (default):** Everything works as before — no captcha tokens needed.
2. **Enabled:** Set the env vars above, then:
   - Submit the booking intake form → token is acquired invisibly, sent in body
   - Request an email verification code → token is included in the fetch
   - Open browser DevTools → Network tab → verify `recaptcha_token` is in the POST body
   - Simulate a bot: send a cURL request without a token → expect 400

---

## Production Considerations

- **Score tuning:** Start with `0.5` and adjust based on traffic. Google's admin console shows score distributions.
- **Monitoring:** Failed captcha attempts are logged at `warn` level with error codes and score.
- **Privacy:** reCAPTCHA v3 uses cookies and behavioral analysis. Ensure your privacy policy mentions Google reCAPTCHA.
- **Fallback:** If Google's service is unreachable, `verifyRecaptcha` returns `{ success: false }` (fail closed). Consider adding a retry or fallback for high-traffic production.
