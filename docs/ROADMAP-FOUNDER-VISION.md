# gomomo.ai — Founder Vision Realignment

**Vision:** "One autonomous receptionist across web chat + SMS now, voice later, with strict guardrails."

**Date:** 2026-02-07
**Baseline:** 65 / 65 tests passing

---

## A) Current Capabilities vs Vision Gaps

### ✅ What Already Aligns With the Vision

| Capability | Status | Notes |
|------------|--------|-------|
| Web chat booking flow (intent → availability → hold → confirm) | **Working** | GPT-4o + 8 function-calling tools, SERIALIZABLE + EXCLUDE constraints |
| Overbooking prevention (4 layers) | **Working** | DB EXCLUDE, advisory locks, SERIALIZABLE, cross-table guard |
| Default-deny policy engine | **Working** | All autonomous actions gated; every decision audit-logged |
| Tool allowlist (chat: 8, orchestrator: 8) | **Working** | Closed registries, no dynamic registration |
| PII-redacted audit trail | **Working** | Auto-redaction on event bus + manual auditRepo.log |
| Autonomous job runner + event bus | **Working** | 10 domain events, persistent queue, concurrency control, stale reclaim |
| Notification outbox (email/SMS bodies) | **Working** | 8 autonomous tools write to `notification_outbox` table |
| Waitlist + proactive push to web chat | **Working** | `waitlist_entries` + Socket.IO push with DB persistence |
| Hold-expiry follow-up | **Working** | 30-min cooldown, only if contact info exists |
| Calendar retry (3x exponential backoff) | **Working** | 30s → 120s → 480s, then escalation |
| Follow-up guardrails (limit + cooldown + confirmation) | **Working** | 3-layer code-enforced in tool-executor |
| Demo availability for testing | **Working** | Mon–Fri 9–5 ET, 14-day lookahead |
| Chat widget with status chips, toasts, push cards | **Working** | React + Socket.IO + REST fallback |
| Twilio SMS sending (REST API, rate-limited) | **Working** | `sms-sender.ts` — E.164 validation, per-phone sliding window |
| System prompt guardrails (8 critical rules, clarification, date-distance, phone limitations) | **Working** | Prompt-only; not all code-enforced |

### ❌ Gaps Blocking the Founder Vision

| # | Gap | Why It Blocks Pilot | Severity |
|---|-----|---------------------|----------|
| G1 | **Notification outbox is write-only** — no sender reads `notification_outbox` and actually delivers email or SMS | Users never receive confirmation/cancellation/reminder emails or SMS follow-ups. The autonomous tools are dead letters. | **Critical** |
| G2 | **No API authentication** — every route is open (`/api/tenants/*/chat`, `/api/appointments/*`, etc.) | Any HTTP client can impersonate any tenant, read all bookings, or inject chat messages. Cannot ship to a real customer. | **Critical** |
| G3 | **No SMS confirmation/reminder delivery** — `send_confirmation`, `send_reminder` always write `channel='email'`. No code path sends real SMS for these notifications even though the SMS sender exists. | A pilot tenant expecting text confirmations gets nothing. | **High** |
| G4 | **No inbound SMS** — no webhook receives Twilio SMS, no message parsing, no STOP/opt-out | Users cannot reply to SMS notifications. Carrier compliance violation if sending to US numbers without opt-out. | **High** |
| G5 | **Encryption key is a hardcoded dev placeholder** | Google OAuth tokens stored with known key; single grep away from token theft. | **High** |
| G6 | **Frontend is hardcoded to one demo tenant** | Cannot onboard a second customer without code change. | **Medium** |
| G7 | **No tenant self-service onboarding** | No API or UI to create a tenant, configure services, or set business hours. | **Medium** |
| G8 | **Voice engine is tightly coupled to startup** — loads even when `VOICE_ENABLED=false` route registration is skipped, but imports and in-memory maps still load | Not a blocker, but adds noise and attack surface for a "web + SMS first" pilot. | **Low** |
| G9 | **In-memory SMS rate limits / handoff tokens** — lost on restart | In a pilot with process restarts (deploy cycles), rate limits reset. Handoff tokens become invalid. | **Low** |
| G10 | **No CI/CD or production infra** | No way to deploy to a staging or production environment. | **Medium** |

### 🟡 Things That Exist but Need Hardening

| Item | Current State | What's Needed |
|------|--------------|---------------|
| Prompt-only guardrails (5) | System prompt tells the model; code doesn't enforce | Code-enforce the two most dangerous: date-distance (`hold_slot` rejects far dates) and ambiguous-request (`check_availability` rejects vague queries) |
| AUTONOMY_ENABLED default | `false` | Must be `true` for pilot — but should only flip after outbox sender exists |
| Google Calendar integration | Mock by default; real provider exists | A pilot tenant needs either real GCal or a clear "DB-only" mode with explicit documentation |
| Docker Compose | Exists with PG + backend + frontend | Needs `.env.production` template, secrets handling, health checks for backend |

---

## B) Three-Phase Execution Roadmap

### Phase 1 — Web + SMS (Ship Pilot)

**Goal:** One real tenant can book, reschedule, cancel via web chat. Booking confirmations, reminders, and follow-ups are delivered via email and SMS. API is authenticated. Outbox is live.

**Duration:** ~2 weeks (10 PR-sized tasks)

**Entry criteria:** 65/65 tests pass (current baseline)
**Exit criteria:**
- Tenant receives email + SMS confirmations and reminders
- `notification_outbox` rows transition from `pending` → `sent` / `failed`
- All API routes require a valid tenant API key
- AUTONOMY_ENABLED can be set to `true` safely
- Deploys to a staging environment via `docker compose up`
- ≥75 tests pass (current 65 + new tests for sender + auth + inbound SMS)

---

### Phase 2 — App Readiness (SDK + Auth + Onboarding)

**Goal:** Embeddable chat widget, tenant self-service, production-grade secrets, observability.

**Duration:** ~3 weeks

| Work Item | Description |
|-----------|-------------|
| **Embeddable SDK** | Chat widget as `<script>` tag with `data-tenant-id` + `data-api-key` attributes. CORS per-tenant. |
| **Tenant onboarding API** | `POST /api/tenants` with service config, business hours, API key generation |
| **Admin dashboard (minimal)** | Read-only: upcoming bookings, outbox status, audit log viewer |
| **Secrets rotation** | `ENCRYPTION_KEY` from env → encrypted config store; Google OAuth token encryption with AES-256-GCM |
| **Production PG** | Connection pooling (pgBouncer or `pg` pool config), `DATABASE_URL` with SSL |
| **Structured logging** | JSON logs, correlation IDs per request, OpenTelemetry traces |
| **CI/CD pipeline** | GitHub Actions: lint → test → build → deploy to staging |
| **Rate limiting on API routes** | Fastify rate-limit plugin, per-tenant quotas |
| **STOP/opt-out compliance** | Track opt-outs in `sms_opt_outs` table; check before any SMS send |

**Exit criteria:**
- A second tenant onboarded via API (no code change)
- Widget embeds in a third-party HTML page
- Secrets not visible in plaintext in DB or env
- CI runs all tests on every push

---

### Phase 3 — Voice Hardening

**Goal:** Voice/phone channel is production-grade and joins the same autonomous receptionist.

**Duration:** ~3 weeks

| Work Item | Description |
|-----------|-------------|
| **Persist voice sessions to DB** | Migrate `Map<callSid, VoiceSession>` to a `voice_sessions` table. Survives restarts. |
| **DB-backed SMS rate limits + handoff tokens** | Move from in-memory Maps to DB tables with TTL-based cleanup. |
| **Multi-tenant phone routing** | Twilio number → tenant mapping table. Inbound call routes to correct tenant config. |
| **Voice NLU upgrade** | Replace regex-only NLU with GPT-4o-mini for intent extraction (same tool executor, LLM-backed entity recognition). |
| **Call recording + transcription** | Store turn-level transcripts in `voice_turns` table for audit + QA. |
| **Handoff session continuity** | Inject voice conversation context into web chat LLM history after handoff token redemption. |
| **Voice load testing** | Simulate 20 concurrent calls; validate state machine doesn't corrupt under contention. |
| **Voice-specific tests** | Vitest suite: state transitions, retry limits, SMS handoff flow, concurrent call limiting. |

**Exit criteria:**
- Voice session survives server restart
- Handoff token redemption pre-fills full conversation context
- 10+ concurrent voice calls without corruption
- ≥90 total tests

---

## C) Phase 1 — PR-Sized Work Items

Each task is ≤2 hours, independently mergeable, and has explicit acceptance criteria.

---

### PR-1: Outbox Sender — Email via SendGrid/SMTP

**Estimate:** 2h
**Files affected:**
- `src/backend/src/services/outbox-sender.ts` (NEW)
- `src/backend/src/config/env.ts` (add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SENDGRID_API_KEY`, `EMAIL_PROVIDER`)
- `src/backend/src/orchestrator/orchestrator.ts` (start outbox poller on init)
- `src/backend/src/db/migrations/008_outbox_sent.sql` (NEW — add `sent_at`, `error_message` columns if not present)
- `src/backend/tests/outbox-sender.test.ts` (NEW)

**What it does:**
- Polls `notification_outbox` WHERE `status = 'pending'` AND `channel = 'email'` every 10s
- Sends via configurable provider (SMTP or SendGrid REST API)
- Updates row: `status = 'sent'`, `sent_at = NOW()` on success
- Updates row: `status = 'failed'`, `error_message = ...` on failure
- Max 3 retries with 30s backoff before marking `permanently_failed`
- Only runs when `AUTONOMY_ENABLED = true`

**Acceptance criteria:**
- [ ] `notification_outbox` row with `channel='email'` transitions to `sent` when SMTP creds are valid
- [ ] Row transitions to `failed` with error message when SMTP creds are invalid
- [ ] Poller does not crash on malformed rows
- [ ] New test: mock SMTP → assert outbox row status transitions (≥3 test cases)
- [ ] No change to existing booking/hold/policy invariants

---

### PR-2: Outbox Sender — SMS via Existing Twilio Sender

**Estimate:** 1.5h
**Files affected:**
- `src/backend/src/services/outbox-sender.ts` (extend to handle `channel = 'sms'`)
- `src/backend/src/voice/sms-sender.ts` (export `sendSms` — already exported)
- `src/backend/tests/outbox-sender.test.ts` (add SMS test cases)

**What it does:**
- Outbox poller picks up rows with `channel = 'sms'`
- Calls existing `sendSms(recipient, body)` from `sms-sender.ts`
- Inherits existing rate limiting (per-phone sliding window)
- Updates outbox row to `sent` / `failed`

**Acceptance criteria:**
- [ ] `notification_outbox` row with `channel='sms'` transitions to `sent` when Twilio creds are valid
- [ ] Rate-limited sends get `status = 'rate_limited'` (not retried until window passes)
- [ ] New test: mock Twilio → assert SMS outbox flow (≥2 test cases)
- [ ] Existing `sms-sender.ts` tests/behavior unchanged

---

### PR-3: SMS Channel for Confirmations + Reminders

**Estimate:** 1h
**Files affected:**
- `src/backend/src/orchestrator/registered-tools.ts` (modify `send_confirmation`, `send_reminder`)
- `src/backend/src/orchestrator/handlers/on-booking-created.ts` (pass `client_phone` if available)

**What it does:**
- `send_confirmation` and `send_reminder` check if tenant or client prefers SMS
- If `client_phone` exists in job payload → write a SECOND outbox row with `channel = 'sms'` (in addition to email)
- SMS body is shorter than email body (≤160 chars for single segment)

**Acceptance criteria:**
- [ ] Booking with `client_phone` in session metadata → outbox has both email AND sms rows
- [ ] Booking without phone → outbox has only email row (no change from current behavior)
- [ ] SMS body ≤ 160 chars
- [ ] Existing test assertions on outbox writes still pass

---

### PR-4: API Key Authentication Middleware

**Estimate:** 2h
**Files affected:**
- `src/backend/src/middleware/api-key-auth.ts` (NEW)
- `src/backend/src/db/migrations/008_api_keys.sql` (NEW — `tenant_api_keys` table: id, tenant_id, key_hash, created_at, revoked_at)
- `src/backend/src/repos/api-key.repo.ts` (NEW)
- `src/backend/src/config/env.ts` (add `API_AUTH_ENABLED` toggle, default `false` for dev)
- `src/backend/src/index.ts` (register middleware on `/api/*` routes except `/health` and `/api/config`)
- `src/backend/tests/api-key-auth.test.ts` (NEW)

**What it does:**
- Reads `X-API-Key` header
- SHA-256 hashes the key, looks up in `tenant_api_keys`
- Sets `request.tenantId` from the matched row
- Returns 401 if key is missing/invalid/revoked
- Skipped when `API_AUTH_ENABLED = false` (backward compatible for dev)
- `/health`, `/api/config`, `/twilio/*` (webhook signature validates separately) are exempt

**Acceptance criteria:**
- [ ] Request without `X-API-Key` header → 401 when `API_AUTH_ENABLED=true`
- [ ] Request with valid key → proceeds, `request.tenantId` is set
- [ ] Request with revoked key → 401
- [ ] When `API_AUTH_ENABLED=false` → all requests pass (current behavior)
- [ ] New tests: ≥4 test cases (missing key, invalid key, valid key, revoked key)
- [ ] Booking invariants unchanged

---

### PR-5: API Key Management Routes

**Estimate:** 1.5h
**Files affected:**
- `src/backend/src/routes/api-key.routes.ts` (NEW — `POST /api/tenants/:id/api-keys`, `DELETE /api/tenants/:id/api-keys/:keyId`)
- `src/backend/src/repos/api-key.repo.ts` (add `create`, `revoke`, `listByTenant`)
- `src/backend/src/index.ts` (register route)

**What it does:**
- `POST /api/tenants/:id/api-keys` → generates crypto.randomUUID-based key, stores SHA-256 hash, returns plaintext key ONCE
- `DELETE /api/tenants/:id/api-keys/:keyId` → sets `revoked_at = NOW()`
- `GET /api/tenants/:id/api-keys` → lists keys (masked, showing last 4 chars + created/revoked dates)
- These routes themselves require a pre-shared admin secret (`ADMIN_SECRET` env var) during bootstrap

**Acceptance criteria:**
- [ ] POST returns a key that authenticates subsequent requests
- [ ] DELETE revokes a key; subsequent requests with it return 401
- [ ] GET lists keys without exposing full key material
- [ ] Admin secret is required; request without it returns 403

---

### PR-6: Inbound SMS Webhook + STOP Handling

**Estimate:** 2h
**Files affected:**
- `src/backend/src/voice/inbound-sms.routes.ts` (NEW)
- `src/backend/src/repos/sms-opt-out.repo.ts` (NEW)
- `src/backend/src/db/migrations/009_sms_opt_outs.sql` (NEW — `sms_opt_outs` table: phone, tenant_id, opted_out_at)
- `src/backend/src/voice/sms-sender.ts` (add opt-out check before sending)
- `src/backend/src/index.ts` (register inbound SMS routes)
- `src/backend/tests/inbound-sms.test.ts` (NEW)

**What it does:**
- `POST /twilio/sms/incoming` — receives Twilio SMS webhook
- Validates Twilio signature (same pattern as voice routes)
- If body is "STOP" / "UNSUBSCRIBE" / "CANCEL" → insert into `sms_opt_outs`, reply "You have been unsubscribed"
- If body is "START" / "UNSTOP" → delete from `sms_opt_outs`, reply "You have been resubscribed"
- All other messages → reply "Thanks for your message. Please use our web chat for bookings: {URL}"
- `sendSms()` checks `sms_opt_outs` before sending; returns `{ success: false, error: 'opted_out' }` if match

**Acceptance criteria:**
- [ ] "STOP" SMS → opt-out recorded, TwiML response confirms
- [ ] "START" SMS → opt-out removed
- [ ] `sendSms()` to opted-out number returns `opted_out` error without calling Twilio
- [ ] Twilio signature validation enforced
- [ ] New tests: ≥4 test cases (stop, start, random message, opted-out send blocked)

---

### PR-7: Production Environment Template + Docker Hardening

**Estimate:** 1.5h
**Files affected:**
- `.env.production.template` (NEW — all env vars with comments, no secrets)
- `docker-compose.yml` (add backend health check, resource limits)
- `docker-compose.prod.yml` (NEW — production overrides: no embedded PG, external `DATABASE_URL`, `NODE_ENV=production`)
- `src/backend/Dockerfile` (add multi-stage production build: build → prune → run)

**Acceptance criteria:**
- [ ] `docker compose -f docker-compose.yml -f docker-compose.prod.yml up` starts backend + frontend (PG is external)
- [ ] `.env.production.template` documents every required env var
- [ ] Production Dockerfile has no `devDependencies` in final image
- [ ] Backend health check endpoint used by Docker health check
- [ ] No secrets in any committed file

---

### PR-8: Code-Enforce Date-Distance Guardrail

**Estimate:** 1h
**Files affected:**
- `src/backend/src/agent/tool-executor.ts` (add check in `handleHoldSlot`)
- `src/backend/src/config/env.ts` (already has `BOOKING_FAR_DATE_CONFIRM_DAYS`)
- `src/backend/tests/guardrails.test.ts` (add test cases)

**What it does:**
- In `handleHoldSlot`: if `start_time` is > `BOOKING_FAR_DATE_CONFIRM_DAYS` days from now AND args do not contain `"__date_confirmed__"` flag → return error asking the model to confirm with user
- This upgrades an existing prompt-only guardrail to a code-enforced guardrail

**Acceptance criteria:**
- [ ] `hold_slot` for date 60 days out WITHOUT confirmation flag → returns `success: false` with `DATE_CONFIRMATION_REQUIRED` message
- [ ] `hold_slot` for date 60 days out WITH `__date_confirmed__` → proceeds normally
- [ ] `hold_slot` for date 5 days out → proceeds normally (no change)
- [ ] `BOOKING_FAR_DATE_CONFIRM_DAYS=0` → guardrail disabled entirely
- [ ] New test cases: ≥3
- [ ] Existing hold/booking tests unchanged

---

### PR-9: Code-Enforce Ambiguous-Request Guardrail

**Estimate:** 1.5h
**Files affected:**
- `src/backend/src/agent/tool-executor.ts` (add validation in `handleCheckAvailability`)
- `src/backend/tests/guardrails.test.ts` (add test cases)

**What it does:**
- In `handleCheckAvailability`: if `end_date - start_date > 14 days` → return error: "Date range too wide. Please narrow to 2 weeks or less."
- If `start_date` is in the past → return error: "Start date is in the past."
- These are mechanical guards that prevent the LLM from making wasteful broad-range queries or nonsensical past-date queries

**Acceptance criteria:**
- [ ] `check_availability` with 30-day range → `success: false`, error explains limit
- [ ] `check_availability` with past start date → `success: false`
- [ ] `check_availability` with 7-day range → proceeds normally
- [ ] New test cases: ≥3
- [ ] Existing availability tests unchanged

---

### PR-10: Flip AUTONOMY_ENABLED + Smoke Test Suite

**Estimate:** 1.5h
**Files affected:**
- `src/backend/.env` (change `AUTONOMY_ENABLED=true`)
- `docker-compose.yml` (set `AUTONOMY_ENABLED=true` in backend environment)
- `src/backend/tests/smoke-pilot.test.ts` (NEW — integration smoke test)

**What it does:**
- Flips autonomy on (safe only after PR-1/PR-2 land — outbox sender exists)
- Smoke test: creates a mock booking flow end-to-end → asserts:
  - `appointments` row created
  - `notification_outbox` has `email` + optionally `sms` rows
  - `jobs` table has confirmation + reminder jobs
  - `audit_log` has booking lifecycle entries
- Also verifies policy engine denies an unrecognized tool name

**Acceptance criteria:**
- [ ] `AUTONOMY_ENABLED=true` in default env
- [ ] Smoke test exercises full booking → outbox → job lifecycle
- [ ] Policy engine deny test passes
- [ ] All 65+ existing tests still pass
- [ ] Test count ≥ 75

---

## D) PR Dependency Graph

```
PR-1 (email sender) ──→ PR-2 (SMS sender) ──→ PR-3 (SMS confirmations) ──→ PR-10 (autonomy on)
                                                                              ↑
PR-4 (auth middleware) ──→ PR-5 (key mgmt) ─────────────────────────────────-─┘
                                                                              ↑
PR-6 (inbound SMS) ─────────────────────────────────────────────────────────-─┘
                                                                              ↑
PR-7 (prod env) ────────────────────────────────────────────────────────────-─┘
                                                                              ↑
PR-8 (date guardrail) ─────────────────────────────────────────────────────-─┘
                                                                              ↑
PR-9 (ambiguous guardrail) ────────────────────────────────────────────────-─┘
```

**Parallelizable groups:**
- **Group A (can run in parallel):** PR-1, PR-4, PR-6, PR-7, PR-8, PR-9
- **Group B (depends on PR-1):** PR-2 → PR-3
- **Group C (depends on PR-4):** PR-5
- **Group D (depends on all):** PR-10

---

## E) Non-Negotiables Preserved

| Invariant | How Every PR Preserves It |
|-----------|---------------------------|
| SERIALIZABLE transactions for bookings | No PR touches `booking.service.ts` transaction logic |
| EXCLUDE constraints on appointments | No PR alters migration 001/002 |
| Hold TTL + advisory locks | No PR modifies hold creation/confirmation |
| Default-deny policy engine | No PR adds hardcoded "allow"; PR-10 tests a deny |
| Tool allowlist (chat + orchestrator) | No PR adds new chat tools; PR-1/2 add infrastructure, not tools |
| No "AGI OS control" features | No filesystem, shell, eval, or arbitrary network access added |
| Audit logging on all state changes | PR-1/2 log send/fail; PR-4 logs auth failures; PR-6 logs opt-outs |
| PII redaction | Outbox sender logs delivery status, not message body |

---

*End of roadmap. Non-negotiables intact. Phase 1 is 10 PRs, each ≤ 2h.*
