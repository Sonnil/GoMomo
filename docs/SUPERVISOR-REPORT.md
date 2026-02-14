# gomomo.ai — Supervisor Ship-Readiness Report

**Date:** 2026-02-16  
**Author:** EON (Staff Engineer + Delivery Manager)  
**Status:** CONDITIONAL GO — see Section 7

---

## 1. Current System Summary

### 1.1 Architecture

| Layer | Technology | Status |
|-------|-----------|--------|
| **Backend** | Node.js 20+ / TypeScript 5.7+ / Fastify 5 / ESM | ✅ Compiles, runs |
| **Frontend** | React 18 / Vite 5 / socket.io-client | ✅ Compiles, runs |
| **Database** | PostgreSQL 16 + btree_gist + EXCLUDE constraints | ✅ 3 migrations applied |
| **AI Agent** | OpenAI GPT-4o, function-calling, temp=0.3 | ✅ Deterministic config |
| **Real-time** | Socket.IO 4 over `/ws` path | ✅ WebSocket + polling fallback |
| **Voice** | Twilio `<Gather speech>` + `<Say>`, 16-state machine | ✅ 4 test scenarios pass |
| **SMS Handoff** | HMAC-signed tokens, one-time use, 15m TTL | ✅ 5 E2E tests pass |
| **Excel Sync** | Outbound-only decorator, dead letter queue, reconciliation | ✅ 44/44 tests pass |
| **Google Calendar** | OAuth2 + Calendar API v3, auto-refresh tokens | ✅ Functional |

### 1.2 Data Flow

```
User (web/phone) → Agent (chat-handler / conversation-engine)
  → Tool Executor → Availability Service → PostgreSQL (SERIALIZABLE + EXCLUDE)
  → Booking Service → [Google Calendar sync] → [Excel sync]
  → Response → User
```

Voice and web chat share the **exact same** tool executor and booking service. No booking logic is duplicated.

### 1.3 File Inventory

| Directory | Files | Purpose |
|-----------|-------|---------|
| `agent/` | 4 | System prompt, tools, tool-executor, chat-handler |
| `config/` | 1 | Zod-validated env schema |
| `db/` | 3 + 3 SQL | Client/pool, migrate runner, seed; 3 migration files |
| `domain/` | 2 | Types + interfaces (BookingStore abstraction) |
| `integrations/` | 2 | Excel file-ops, Excel sync worker |
| `jobs/` | 1 | Excel reconciliation job |
| `repos/` | 5 | appointment, hold, tenant, session, audit |
| `routes/` | 5 | tenant, availability, appointment, chat, oauth |
| `services/` | 3 | availability, booking, calendar |
| `stores/` | 3 | Postgres store, Excel sync adapter, factory |
| `voice/` | 9 | Routes, engine, session mgr, TwiML, NLU, tool-exec, handoff token, SMS sender, handoff routes |
| `tests/` | 3 | Race-condition integration, voice simulator, Excel adapter tests |
| `frontend/` | 4 components | App, DemoApp, ChatWidget, DemoChatWidget |

### 1.4 Test Coverage

| Test Suite | Type | Tests | Status |
|-----------|------|-------|--------|
| `test:race` | Integration (real PG) | 5 scenarios | ✅ All pass |
| `test:voice` | Simulator (HTTP) | 4 scenarios (book, cancel, silence, unknown) | ✅ All pass |
| `test:excel` | Unit + Integration | 44 tests | ✅ All pass, 0 tsc errors |

### 1.5 What is NOT built

- **No admin dashboard** — tenant management is API-only
- **No email confirmations** to clients
- **No payment integration**
- **No multi-language support** (English only)
- **No inbound Excel sync** (admin edits in Excel don't flow back to DB)
- **No Twilio phone number → tenant routing** (hardcoded `VOICE_DEFAULT_TENANT_ID`)
- **No request body validation on REST routes** (no Zod schemas on HTTP bodies)

---

## 2. Source of Truth Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| **Where is the booking truth?** | **PostgreSQL — unconditionally** | SERIALIZABLE transactions + EXCLUDE constraints are the only mechanism that prevents double-booking. Google Calendar and Excel are post-commit, best-effort mirrors. |
| **Where is availability truth?** | **PostgreSQL appointments + availability_holds** | `availabilityService.getAvailableSlots()` queries both tables. Google Calendar is NOT consulted during availability checks. |
| **Where is voice session truth?** | **In-memory `Map<string, VoiceSession>`** | Acceptable for short-lived calls (≤10 min). Sessions not DB-persisted. Lost on server restart — calls in progress will hear "I lost track of our conversation." |
| **Where is handoff token truth?** | **In-memory `Map<string, HandoffTokenPayload>`** | Tokens are ephemeral (15 min TTL). Lost on restart — links become invalid. Acceptable trade-off for MVP. |
| **Where is rate limit truth?** | **In-memory maps** (SMS rate limits, voice session counts) | Reset on restart. Not shared across instances. Acceptable for single-instance MVP. |
| **What happens when Excel sync fails?** | **Booking succeeds. Failure → dead letter queue → reconciliation job retries every 5 min.** | Excel never blocks or fails a booking. |
| **What happens when Google Calendar fails?** | **Booking succeeds. Failure logged to console.** | GCal is best-effort. No dead letter queue (gap — see Risk Register). |

---

## 3. Risk Register

### 🔴 CRITICAL (must fix before ship)

| ID | Risk | Impact | Current State | Fix |
|----|------|--------|--------------|-----|
| **R1** | **No request body validation on REST routes** | Malformed input → unhandled exceptions, potential SQL injection via pg parameterization bypass (unlikely but defense-in-depth missing) | Routes accept `req.body` unchecked; only field-presence checks (`if (!x)`) | Add Zod schemas to all POST/PATCH route bodies. ~2h work. |
| **R2** | **`BookingError` not exported from `booking.service.ts`** | Route handlers use `err.constructor?.name === 'BookingError'` — fragile name-based check that breaks with minification | `appointment.routes.ts` lines 45, 90, 107 and `availability.routes.ts` line 54 use string comparison | Export `BookingError`, use `instanceof` checks. ~30 min. |
| **R3** | **No conversation history size limit** | `sessionRepo.updateConversation()` stores the entire `conversation[]` array as JSONB. A long chat (many tool calls) can grow unbounded → slow DB queries, potential OOM on large payloads | `chat-handler.ts` appends without truncation | Add a rolling window (e.g., keep last 50 messages, summarize older ones). ~1h work. |
| **R4** | **Google Calendar OAuth tokens stored as plaintext JSONB** | `tenantRepo.updateOAuthTokens()` stores raw `{access_token, refresh_token, expiry_date}` in `tenants.google_oauth_tokens` | `ENCRYPTION_KEY` env var exists but is unused — tokens are plaintext in DB | Encrypt before storage, decrypt on read. ~2h work. |
| **R5** | **No rate limiting on public API routes** | No middleware limiting requests per IP. Chat and booking endpoints are unauthenticated and unlimited. | `index.ts` registers routes without rate limiting | Add `@fastify/rate-limit`. ~1h. |

### 🟡 HIGH (should fix before ship, acceptable as known-risk if blocked)

| ID | Risk | Impact | Current State | Fix |
|----|------|--------|--------------|-----|
| **R6** | **No Google Calendar dead letter / retry** | If GCal event creation fails, it's logged and forgotten. The appointment exists in DB but not on the calendar. | `booking.service.ts` lines 129-133: `catch` logs and continues | Add GCal sync to the same dead-letter/reconciliation pattern used by Excel. ~3h. |
| **R7** | **Voice NLU date detection has no timezone awareness** | `detectDate()` in `nlu.ts` uses server-local `new Date()` for "today"/"tomorrow". If server is UTC and tenant is `America/New_York`, "tomorrow" may resolve to wrong day near midnight. | `nlu.ts` lines 111-160: `const today = new Date()` | Pass tenant timezone into `detectDate()`, use `toZonedTime()`. ~1h. |
| **R8** | **Availability slot times formatted in server timezone for voice** | `appointmentToExcelRow()` in `excel-file-ops.ts` uses `format(startDate, 'HH:mm')` which formats in server-local time, not tenant timezone | `excel-file-ops.ts` line 72: `format(startDate, 'HH:mm')` | Use `formatInTimeZone()` from `date-fns-tz`. ~30 min. |
| **R9** | **Single-process architecture — all in-memory state lost on restart** | Voice sessions, handoff tokens, SMS rate limits, Excel sync worker state all live in memory | Design decision for MVP, documented | Acceptable for MVP. Add health-check documentation noting this limitation. |
| **R10** | **`.env.example` has stale OAuth redirect URI** | `.env.example` says `http://localhost:3000/api/v1/oauth/callback` but actual route is `/api/oauth/google/callback` | `.env.example` line 22 | Fix the URI. ~1 min. |
| **R11** | **Tenant PATCH endpoint has no authorization** | Anyone who knows a tenant UUID can modify business hours, services, name | `tenant.routes.ts` — no auth middleware | Add API key or auth middleware. ~2h. |
| **R12** | **Reference code collision possible** | `generateReferenceCode()` uses random 6-char alphanumeric. At scale, collisions are likely (~31^6 = 887M namespace but no uniqueness retry). `reference_code` has a UNIQUE constraint so INSERT will fail. | `appointment.repo.ts` lines 4-9 | Add retry loop on unique violation. ~30 min. |

### 🟢 MEDIUM (acceptable for MVP, fix in v1.1)

| ID | Risk | Impact | Current State | Fix |
|----|------|--------|--------------|-----|
| **R13** | **No graceful handling of OpenAI API outage** | If OpenAI is down, every chat message fails with an uncaught error | `chat-handler.ts` — no try/catch around `openai.chat.completions.create()` | The outer Socket.IO `message` handler catches it, but error message is generic. Add specific OpenAI error handling + retry. |
| **R14** | **No health check for database connectivity** | `/health` returns `{status: 'ok'}` without testing DB connection | `index.ts` line 44 | Add `SELECT 1` probe. |
| **R15** | **Voice concurrent call limit is in-memory only** | `countActiveSessions()` works per-process. Multiple instances don't share counts. | `session-manager.ts` | Acceptable for single-instance MVP. |
| **R16** | **No CSRF protection on form-encoded Twilio endpoints** | Twilio signature validation exists but is skipped if `TWILIO_AUTH_TOKEN` is empty | `voice.routes.ts` lines 32-33 | Enforce in production. Add `NODE_ENV` check. |
| **R17** | **`demo-server.ts` and `mock-server.ts` are in `src/` not `scripts/`** | Could accidentally be included in production Docker image | Files at `src/backend/src/demo-server.ts`, `mock-server.ts`, `voice-mock-server.ts` | Move to `scripts/` or add to `.dockerignore`. |
| **R18** | **No structured logging** | Uses `console.log/warn/error` mixed with Fastify's pino logger | Throughout codebase | Standardize on pino. |

---

## 4. Ship Checklist

### ✅ Already Done

- [x] SERIALIZABLE transactions with retry (3 attempts, exponential backoff)
- [x] EXCLUDE constraints on both `appointments` and `availability_holds`
- [x] Advisory locks (`pg_advisory_xact_lock`) during booking confirmation
- [x] Idempotent booking via `source_hold_id` unique index
- [x] Expired-hold cleanup job (60s interval)
- [x] Excel dead letter queue + reconciliation job (5 min interval)
- [x] Twilio signature validation (HMAC-SHA1)
- [x] SMS handoff with HMAC-SHA256 signed one-time tokens
- [x] SMS rate limiting (3/phone/hour)
- [x] Voice: timeout detection, retry limits (3), turn limits (20), duration limit (10 min)
- [x] Voice: concurrent call cap (5 per tenant)
- [x] Agent temperature at 0.3 (low hallucination)
- [x] Tool-call round limit (5) with forced text fallback
- [x] Graceful shutdown (SIGTERM/SIGINT → cleanup timers, close IO + server)
- [x] Environment validation via Zod (process exits on invalid config)
- [x] Docker Compose with health checks
- [x] OAuth token auto-refresh on expiry
- [x] Audit log for all booking operations
- [x] CORS configuration (per-origin)

### ❌ Must Do Before Ship

- [ ] **R1:** Add Zod validation to all REST route bodies
- [ ] **R2:** Fix `BookingError` import/instanceof pattern
- [ ] **R3:** Add conversation history size limit
- [ ] **R4:** Encrypt OAuth tokens at rest
- [ ] **R5:** Add rate limiting on public API routes
- [ ] **R10:** Fix `.env.example` OAuth redirect URI

### ⚠️ Should Do Before Ship (strongly recommended)

- [ ] **R7:** Fix voice NLU date detection timezone
- [ ] **R8:** Fix Excel time formatting timezone
- [ ] **R11:** Add tenant API authorization
- [ ] **R12:** Add reference code collision retry
- [ ] **R14:** Add DB connectivity to health check
- [ ] **R16:** Enforce Twilio signature validation in production
- [ ] **R17:** Move dev server files out of `src/`

---

## 5. Final MVP Scope Lock

### ✅ IN SCOPE — Ship with v1.0

| Feature | Channel | Status |
|---------|---------|--------|
| Book appointment | Web + Voice | ✅ Working |
| Reschedule appointment | Web + Voice | ✅ Working |
| Cancel appointment | Web + Voice | ✅ Working |
| Availability checking | Web + Voice | ✅ Working |
| Slot holding (5 min TTL) | Web + Voice | ✅ Working |
| Google Calendar sync (outbound) | All | ✅ Working |
| Excel mirror (outbound) | All | ✅ Working |
| Multi-tenant data isolation | All | ✅ Working |
| Demo mode (Bloom Wellness Studio) | Web | ✅ Working |
| SMS handoff (voice → web) | Voice | ✅ Working |
| Audit logging | All | ✅ Working |

### ❌ OUT OF SCOPE — Explicitly deferred

| Feature | Reason |
|---------|--------|
| Admin dashboard | Not in MVP requirements |
| Client email confirmations | Requires email provider integration |
| Inbound Excel sync (admin edits → DB) | Complexity; outbound sufficient for MVP |
| Multi-language | English only for v1.0 |
| Phone number → tenant routing | Hardcoded for MVP; requires Twilio number pool |
| Payment processing | Out of domain |
| Custom AI personality tuning | System prompt is sufficient |
| Load balancing / multi-instance | Single-instance MVP; in-memory state prevents horizontal scaling |

### 🔒 FROZEN — Do not add features. Only bug fixes and Ship Checklist items.

---

## 6. Remaining Work Plan

All PRs are ≤ 2 hours. Listed in priority order.

### PR 1: Request Body Validation (R1) — 2h
**Branch:** `fix/route-body-validation`
- Add Zod schemas for: `POST /api/tenants`, `PATCH /api/tenants/:id`, `POST /api/tenants/:tenantId/appointments`, `POST .../reschedule`, `POST .../cancel`, `POST /api/tenants/:tenantId/chat`, `POST /api/tenants/:tenantId/holds`
- Return 400 with Zod error details on validation failure
- Files: `routes/*.ts` (5 files)

### PR 2: BookingError Fix + instanceof (R2) — 30 min
**Branch:** `fix/booking-error-export`
- Export `BookingError` class from `booking.service.ts`
- Export `SlotConflictError` from `availability.service.ts`
- Replace all `err.constructor?.name === 'BookingError'` with `err instanceof BookingError`
- Files: `services/booking.service.ts`, `routes/appointment.routes.ts`, `routes/availability.routes.ts`

### PR 3: Conversation History Limit (R3) — 1h
**Branch:** `fix/conversation-history-limit`
- In `chat-handler.ts`, before calling OpenAI, truncate conversation to last 50 messages (always keep system prompt)
- If truncated, prepend a summary message: "Previous conversation truncated"
- Add `MAX_CONVERSATION_MESSAGES` to `env.ts` (default 50)
- Files: `agent/chat-handler.ts`, `config/env.ts`

### PR 4: OAuth Token Encryption (R4) — 2h
**Branch:** `fix/oauth-token-encryption`
- Create `lib/crypto.ts` with `encrypt(plaintext, key)` and `decrypt(ciphertext, key)` using `aes-256-gcm`
- Encrypt tokens before `tenantRepo.updateOAuthTokens()`
- Decrypt after reading in `calendarService.getAuthForTenant()`
- Require non-default `ENCRYPTION_KEY` in production
- Files: new `lib/crypto.ts`, `services/calendar.service.ts`, `repos/tenant.repo.ts`, `config/env.ts`

### PR 5: API Rate Limiting (R5) — 1h
**Branch:** `fix/api-rate-limiting`
- `npm install @fastify/rate-limit`
- Register globally with 100 req/min default
- Tighter limit on `/api/tenants/:id/chat` (20 req/min)
- Tighter limit on `/api/tenants/:id/appointments` (10 req/min)
- Skip rate limiting for `/health` and `/twilio/*` (Twilio has its own auth)
- Files: `index.ts`, `package.json`

### PR 6: Fix Stale .env.example + Misc Config (R10, R17) — 30 min
**Branch:** `fix/env-and-file-cleanup`
- Fix OAuth redirect URI in `.env.example`
- Move `demo-server.ts`, `mock-server.ts`, `voice-mock-server.ts` to `scripts/`
- Update `package.json` script paths
- Add entries to `.dockerignore`
- Files: `.env.example`, `package.json`, `.dockerignore`

### PR 7: Voice Timezone Fixes (R7, R8) — 1h
**Branch:** `fix/voice-timezone`
- Pass `tenant.timezone` to `detectDate()` in `conversation-engine.ts`
- Use `toZonedTime(new Date(), tz)` for "today"/"tomorrow" calculations in `nlu.ts`
- Use `formatInTimeZone()` in `excel-file-ops.ts` `appointmentToExcelRow()`
- Files: `voice/nlu.ts`, `voice/conversation-engine.ts`, `integrations/excel-file-ops.ts`

### PR 8: Tenant API Auth + Ref Code Retry (R11, R12) — 2h
**Branch:** `fix/tenant-auth-and-refcode`
- Add `ADMIN_API_KEY` to `env.ts`
- Create `middleware/api-key.ts` that checks `Authorization: Bearer <key>`
- Apply to `POST/PATCH /api/tenants/*`
- Add retry loop (max 3) in `generateReferenceCode()` on unique violation
- Files: `config/env.ts`, new `middleware/api-key.ts`, `routes/tenant.routes.ts`, `repos/appointment.repo.ts`

### PR 9: Health Check + Twilio Validation Enforcement (R14, R16) — 1h
**Branch:** `fix/health-and-twilio-auth`
- `/health` endpoint: add `SELECT 1` probe, report DB status
- In `voice.routes.ts`: require Twilio signature validation when `NODE_ENV === 'production'`
- Files: `index.ts`, `voice/voice.routes.ts`

### PR 10: Google Calendar Dead Letter (R6) — 2h *(optional, post-MVP acceptable)*
**Branch:** `feat/gcal-dead-letter`
- Add `gcal_sync_status` column to `appointments`
- On GCal failure, set status to `'gcal_pending'`
- Add reconciliation for GCal in the existing reconciliation job
- Files: new migration `004_gcal_sync.sql`, `services/booking.service.ts`, `jobs/excel-reconciliation.ts`

**Total estimated work: ~13 hours (PRs 1-9 mandatory, PR 10 optional)**

---

## 7. Go / No-Go Criteria

### Gate 1: NO OVERBOOKING ✅
- EXCLUDE constraints on `appointments` and `availability_holds` — **verified in schema**
- SERIALIZABLE transactions with auto-retry (code: `40001`) — **verified in `db/client.ts`**
- Advisory locks during booking confirmation — **verified in `booking.service.ts`**
- Idempotent booking via `source_hold_id` unique index — **verified in migration 002**
- Race condition tests pass (10 concurrent attempts → exactly 1 winner) — **verified test exists and is green**

**Verdict: PASS** — the overbooking prevention stack is the strongest part of this system.

### Gate 2: DETERMINISTIC AGENT ✅
- Temperature at 0.3 — **verified in `chat-handler.ts`**
- System prompt includes 5 CRITICAL RULES: never fabricate data, always use tools — **verified in `system-prompt.ts`**
- Tool-call round limit of 5 with forced text fallback — **verified in `chat-handler.ts`**
- Voice uses rule-based NLU (no LLM for intent detection) — **verified in `nlu.ts`**

**Verdict: PASS** — agent behavior is constrained. LLM is only used for natural language responses, not for scheduling decisions.

### Gate 3: CORRECT TIMEZONES ⚠️ CONDITIONAL
- Availability service correctly uses `fromZonedTime()` / `toZonedTime()` — **verified in `availability.service.ts`**
- Business hours are per-tenant in IANA timezone — **verified**
- All DB timestamps are `TIMESTAMPTZ` — **verified in schema**
- **PROBLEM: Voice NLU `detectDate()` uses server time for "today"/"tomorrow"** (R7)
- **PROBLEM: Excel row formatting uses server time** (R8)

**Verdict: CONDITIONAL PASS** — web chat timezones are correct. Voice has a bug near midnight in non-UTC timezones. Fix in PR 7 (1 hour).

### Gate 4: WEB CHAT STABILITY ✅
- Socket.IO with WebSocket + polling fallback — **verified**
- REST fallback if WebSocket fails — **verified in `ChatWidget.tsx`**
- Session persistence in PostgreSQL — **verified**
- Typing indicators and error handling — **verified**

**Verdict: PASS** — but add conversation history limit (PR 3) and rate limiting (PR 5) before production traffic.

### Gate 5: PRODUCTION SAFETY ⚠️ CONDITIONAL
- **MISSING: Request body validation** (R1) — attack surface
- **MISSING: API rate limiting** (R5) — DoS risk
- **MISSING: OAuth token encryption** (R4) — data at rest
- **MISSING: Tenant API auth** (R11) — unauthorized modification

**Verdict: CONDITIONAL PASS** — requires PRs 1, 4, 5 minimum.

---

### FINAL RECOMMENDATION

**CONDITIONAL GO** — Ship after completing PRs 1-9 (mandatory work plan above).

The core booking engine is sound. The SERIALIZABLE + EXCLUDE + advisory lock stack is well-designed and tested. The agent is properly constrained. The voice and Excel channels work correctly within their documented limitations.

The blocking items are all security/hardening gaps (input validation, rate limiting, auth, encryption), not functional defects in the booking flow.

**Estimated time to ship-ready: 12-13 hours of focused work (PRs 1-9).**

If time-pressured, the absolute minimum for a controlled beta is:
- **PR 1** (body validation) — 2h
- **PR 2** (BookingError fix) — 30 min
- **PR 5** (rate limiting) — 1h
- **PR 7** (voice timezone) — 1h
- **PR 10** (`.env.example` fix) → renumbered as PR 6 above — 30 min

That's **5 hours** for a minimum viable hardening pass.
