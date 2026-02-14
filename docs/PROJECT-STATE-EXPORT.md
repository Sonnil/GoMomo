# gomomo.ai — Project State Export

**Export Date:** 2026-02-07
**Test Status:** 65 / 65 passing (vitest)
**Project Root:** `prj-20260205-001-ai-receptionist/`

---

## 1) System Overview

gomomo.ai is a multi-tenant virtual appointment booking assistant powered by GPT-4o with function calling. Users interact via web chat (primary), voice/phone (Twilio IVR), or SMS handoff. The agent checks real-time availability against a PostgreSQL database (or demo schedule), places temporary holds on time slots, collects client details, and confirms bookings — all through deterministic tool calls. An autonomous agent runtime reacts to domain events (booking created, hold expired, calendar write failed, slot opened) by evaluating a policy engine and enqueuing background jobs for notifications, calendar retries, waitlist matching, and follow-up outreach. Every action is audit-logged with PII redaction.

### Supported Channels
- **Web Chat** — React + Socket.IO (primary), REST fallback
- **Voice/Phone** — Twilio `<Gather speech>` + `<Say>` TwiML IVR, state-machine conversation engine
- **SMS Handoff** — Voice-to-web handoff via one-time signed token sent as SMS link
- **SMS Outbound** — Follow-up contact messages via Twilio REST API (rate-limited)
- **Email** — Notification outbox (writes to `notification_outbox` table; actual sending is pending)

### What "Autonomy" Means in Practice
- A background job runner polls a persistent queue and executes whitelisted tool functions (8 registered tools)
- Every autonomous action is gated by a **default-deny policy engine** — no rule = denied
- The orchestrator subscribes to typed domain events and reacts by enqueuing jobs (never executing inline)
- The autonomy master switch (`AUTONOMY_ENABLED`) is **off by default** — events are still logged but jobs don't execute
- When enabled: the runner handles confirmations, cancellations, reminders, calendar retries, waitlist notifications, hold follow-ups, contact follow-ups, and calendar escalations

---

## 2) Architecture Summary

### Major Components

| Component | Location | Technology | Purpose |
|-----------|----------|------------|---------|
| **Backend API** | `src/backend/` | Fastify 5, TypeScript 5.7+, ESM | REST + WebSocket server, all business logic |
| **Agent Runtime** | `src/backend/src/agent/` | OpenAI GPT-4o, function calling | Chat handling, system prompt, 8 agent tools, tool executor |
| **Orchestrator** | `src/backend/src/orchestrator/` | Event bus + policy engine + job runner | Autonomous workflow coordination |
| **Voice Engine** | `src/backend/src/voice/` | Twilio TwiML, rule-based NLU | IVR conversation state machine, SMS handoff |
| **Frontend** | `src/frontend/` | React, Vite, Socket.IO client | Chat widget, toast notifications, proactive push UI |
| **Database** | PostgreSQL 18.1 (embedded for dev) | 7 migrations (001–007) | All persistent state |
| **Calendar** | `src/backend/src/integrations/calendar/` | Google Calendar API v3, mock provider | Event sync (configurable: mock or real) |
| **Excel Adapter** | `src/backend/src/stores/excel-sync-adapter.ts` | ExcelJS | Optional bidirectional appointment sync to .xlsx |

### Communication Patterns
- **Sync:** REST API (chat, availability, appointments, tenants) + WebSocket (real-time chat, typing indicators, proactive push)
- **Async:** In-process event bus → policy evaluation → persistent job queue → job runner executes registered tools
- **Voice:** Twilio webhooks (POST) → TwiML responses → same tool executor as web chat (no logic duplication)

### Where State Is Stored

| Table | Purpose |
|-------|---------|
| `tenants` | Multi-tenant config, business hours, services, Google OAuth, Excel integration |
| `appointments` | Confirmed/cancelled bookings with EXCLUDE constraint for overlap prevention |
| `availability_holds` | Temporary slot holds (5-min TTL), EXCLUDE constraint (removed in 002, enforced in app layer) |
| `chat_sessions` | Full conversation history (JSONB), session metadata |
| `audit_log` | Every event, policy decision, tool execution, notification (PII-redacted) |
| `jobs` | Persistent job queue (pending/claimed/completed/failed, priority, retry, scheduling) |
| `policy_rules` | Per-tenant or global allow/deny rules for autonomous actions |
| `notification_outbox` | Email/SMS/webhook notifications queued by autonomous tools |
| `waitlist_entries` | Users waiting for slot matches (status: waiting/notified/booked/expired/cancelled) |
| `push_events` | Proactive push messages for chat UI (waitlist_match, calendar_retry_success) |
| `followup_contacts` | Per-session follow-up tracking for rate limiting + cooldown |
| `sync_dead_letter` | Failed Excel sync operations for retry |

### In-Memory State
- Voice sessions: `Map<callSid, VoiceSession>` — ephemeral, lost on restart
- SMS handoff tokens: `Map<tokenId, HandoffTokenPayload>` — ephemeral, 15-min TTL, one-time use
- SMS rate limits: `Map<phone, RateLimitEntry>` — in-memory, per-phone sliding window
- Event bus recent events: ring buffer of last 200 events (for debug/introspection)

---

## 3) Agent Capabilities

### What the Agent Does Autonomously (When AUTONOMY_ENABLED=true)
- Sends booking confirmation email (queued via `send_confirmation` tool)
- Sends cancellation email (queued via `send_cancellation` tool)
- Sends 24h and 2h appointment reminders (queued via `send_reminder` tool)
- Retries failed calendar sync with exponential backoff (30s → 120s → 480s) via `retry_calendar_sync`
- Escalates calendar failures after 3 retries via `escalate_calendar_failure`
- Sends hold-expiry follow-up to users who left contact info via `send_hold_followup`
- Notifies waitlisted users when matching slots open via `send_waitlist_notification`
- Sends async follow-up contact messages (email/SMS) via `send_contact_followup`
- Pushes proactive messages to active chat sessions (waitlist matches, calendar retry success)

### What Always Requires Explicit User Confirmation
- Booking a slot: user must confirm details before `confirm_booking` is called
- Cancelling an appointment: agent asks "are you sure?" before `cancel_booking`
- Rescheduling: user must select a new time and confirm before `reschedule_booking`
- Far-future bookings (>30 days out): agent must ask date confirmation before `hold_slot`
- Additional follow-ups in the same session: agent must ask user before scheduling a second follow-up

### Tool Allowlist (Agent-Facing / Chat Tools — 8 tools)
1. `check_availability`
2. `hold_slot`
3. `confirm_booking`
4. `lookup_booking`
5. `reschedule_booking`
6. `cancel_booking`
7. `create_inquiry` (waitlist)
8. `schedule_contact_followup`

### Registered Autonomous Tools (Orchestrator-Side — 8 tools)
1. `send_confirmation`
2. `send_cancellation`
3. `send_reminder`
4. `retry_calendar_sync`
5. `send_hold_followup`
6. `send_waitlist_notification`
7. `escalate_calendar_failure`
8. `send_contact_followup`

### How Deterministic Behavior Is Enforced
- GPT-4o at **temperature 0.3**
- System prompt contains explicit CRITICAL RULES forbidding fabrication of times, codes, or confirmation status
- Tool results are the only source of truth — the agent cannot say "confirmed" unless `confirm_booking` returned success
- Max 5 tool-call rounds per message (safety limit), then a forced text response
- Policy engine is **default-deny** — unregistered actions are blocked
- Tool registry is a closed whitelist — no dynamic registration at runtime

---

## 4) Guardrails & Safety

### Overbooking Prevention
- **DB-level EXCLUDE constraint** on `appointments` (btree_gist range exclusion WHERE status != 'cancelled')
- **Application-level advisory locks** (`pg_advisory_xact_lock`) during hold creation and booking confirmation
- **SERIALIZABLE transaction isolation** for booking confirmation (prevents phantom reads)
- **Idempotency check**: if `confirm_booking` is called twice with the same `hold_id`, returns existing appointment
- **Hold TTL**: 5-minute hold auto-expires; cleanup job runs every 60s
- **Cross-table guard**: availability engine checks BOTH appointments AND active holds before offering slots

### Policy Engine Rules Currently Enforced
- Default-deny: any action without a matching `policy_rules` row is blocked
- Tenant-specific rules override global rules (higher priority wins)
- Condition matching supports: equality, `min_` prefix (>=), `max_` prefix (<=)
- Every decision (allow or deny) is written to `audit_log`

### Rate Limits / Cooldowns
- **Follow-up messages per session**: max `FOLLOWUP_MAX_PER_BOOKING` (default: 2) — enforced in tool executor with 3-layer guardrail (limit → cooldown → confirmation)
- **Follow-up cooldown**: `FOLLOWUP_COOLDOWN_MINUTES` (default: 60 min) between follow-ups to the same recipient
- **Hold-expiry follow-up cooldown**: 30 min per session (checked via jobs table)
- **SMS rate limit**: max `SMS_RATE_LIMIT_MAX` (default: 3) per phone per `SMS_RATE_LIMIT_WINDOW_MINUTES` (default: 60 min) — in-memory
- **Push event cooldown**: per session+type deduplication check before emitting (via `push_events` table)
- **Voice concurrent calls**: max 5 per tenant
- **Voice turn limit**: `VOICE_MAX_TURNS` (default: 20), call duration limit: `VOICE_MAX_CALL_DURATION_MS` (default: 10 min)
- **Voice retry limit**: `VOICE_MAX_RETRIES` (default: 3) consecutive misunderstandings before escalation

### Audit Logging
- **Every domain event** auto-logged by event bus (PII-redacted via `redactPII()`)
- **Every policy decision** (allow + deny) logged by policy engine
- **Every job lifecycle** (created, claimed, completed, failed) logged by job runner
- **Every tool execution** in the agent (check_availability, hold_slot, confirm_booking, etc.)
- **Every notification** queued/sent/failed
- **Hold lifecycle**: created, released, expired
- **Calendar sync**: succeeded, failed, retry, escalated
- **Follow-up guardrails**: limit_reached, cooldown_blocked, additional_confirmation_required
- **SMS handoff**: token created, token consumed
- Redacted fields: `client_email`, `client_name`, `phone`, `access_token`, `refresh_token`, plus any field matching `/email|phone|token|password|secret/i`

### System Prompt Guardrails (LLM-enforced, not code-enforced)
- 8 CRITICAL RULES in the system prompt (never fabricate, never confirm without tool success, etc.)
- Ambiguous request handling: must clarify before calling `check_availability` for vague queries
- Date-distance guardrail: bookings >30 days out require explicit date confirmation before `hold_slot`
- Phone call limitations: agent cannot make/receive/transfer calls; must redirect to text/email
- NEVER say "I'll have someone call you" or "Let me transfer you"
- NEVER promise exact follow-up delivery times
- Range language for background job SLAs: "within a few minutes to a couple of hours"

---

## 5) Booking Flow (Truth Source)

### Step-by-Step: Intent → Availability → Hold → Confirm → Commit

1. **Intent Collection**
   - Agent greets user, asks what they'd like to do (book, reschedule, cancel)
   - For ambiguous requests (e.g., "next 24 available"), agent MUST clarify before proceeding

2. **Service Selection**
   - Agent asks which service (from `tenant.services` list)
   - Presents service name, duration, description

3. **Availability Check**
   - Agent says "One moment — I'm checking the schedule…"
   - Calls `check_availability(start_date, end_date)`
   - Availability engine generates slots from business hours, subtracts existing appointments + active holds
   - In demo mode: Mon–Fri 9–5 ET, 30-min slots, 14-day lookahead
   - Agent presents ONLY times returned by the tool

4. **Hold Slot**
   - User selects a time → agent calls `hold_slot(start_time, end_time)`
   - Creates row in `availability_holds` with 5-minute TTL
   - On conflict (EXCLUDE constraint or advisory lock): returns error → agent suggests alternatives
   - **Date-distance guardrail**: if date > 30 days out, agent asks for date confirmation BEFORE calling `hold_slot`

5. **Collect Client Details**
   - Agent collects: full name, email address, optional notes
   - Client email stored in session metadata for workflow A (hold follow-up)

6. **Confirm Booking**
   - Agent calls `confirm_booking(hold_id, client_name, client_email, ...)`
   - Inside SERIALIZABLE transaction:
     - Idempotency check (same hold_id → return existing appointment)
     - Advisory lock on tenant + slot hash
     - Verify hold is valid and belongs to this session
     - Insert appointment (EXCLUDE constraint as final safety net)
     - Delete the hold
     - Audit log
   - AFTER transaction (best effort):
     - Google Calendar sync (or mock)
     - If calendar sync fails AND `CALENDAR_SYNC_REQUIRED=false` (default): booking still succeeds, CalendarWriteFailed event emitted for retry
     - If calendar sync fails AND `CALENDAR_SYNC_REQUIRED=true`: booking rolled back, hold re-created, user told to try again
     - Excel sync event emitted (if enabled)
     - `BookingCreated` domain event emitted → orchestrator enqueues confirmation + reminders

7. **Agent Confirmation**
   - ONLY after `confirm_booking` returns `success: true`:
   - Agent says "You're all set — your appointment is confirmed" + shares reference code, date, time, service

### Failure Handling at Each Step

| Step | Failure | What Happens |
|------|---------|--------------|
| Availability check | No slots found | Agent offers waitlist (`create_inquiry`) + follow-up contact (`schedule_contact_followup`) |
| Hold slot | Slot taken (conflict) | Agent tells user, suggests checking other times |
| Hold slot | Hold expired before confirm | Agent tells user, asks to select a new time |
| Confirm booking | EXCLUDE constraint race | Agent says "just booked by someone else", suggests alternatives |
| Confirm booking | Calendar sync fails (lenient) | Booking succeeds, retry job enqueued, user not told |
| Confirm booking | Calendar sync fails (strict) | Booking rolled back, hold re-created, user told to try again |
| Confirm booking | Calendar retries exhausted (3x) | `CalendarRetryExhausted` event → escalation email to user + admin |

### Retries / Fallbacks
- Calendar retries: exponential backoff (30s, 120s, 480s), max 3 attempts, then escalation
- Job runner: configurable `max_attempts` per job (default: 3), automatic retry on failure
- Stale job reclamation: every 60s, jobs claimed > 5 min ago are returned to the queue
- Chat handler: if 5 tool rounds exhausted without text response, forces a final text reply

---

## 6) Channel Behavior

### A) Web Chat

**UX States Supported:**
- **Connected / Disconnected** — header dot indicator (green/amber)
- **Typing** — pulsing `●●●` in assistant bubble
- **Status Chip** — "Receptionist is working on it…", "Scheduling follow-up in progress…" with gear icon
- **Follow-up Card** — inline green card showing "Follow-up Scheduled", contact method, expected timeframe
- **Proactive Push (waitlist_match)** — inline slot buttons user can click to book directly
- **Proactive Push (calendar_retry_success)** — inline confirmation with reference code
- **Toast Notifications** — auto-detected from assistant messages:
  - ✅ Booking Confirmed (with reference code)
  - ℹ️ Booking Cancelled
  - ✅ Booking Rescheduled
  - ❌ Slot Unavailable
  - ⚠️ Hold Expired
  - ❌ System Issue
  - ✅ Follow-up Scheduled
  - ❌ Connection Lost

**Proactive Push Support:**
- Socket.IO rooms per session (`session:<sessionId>`)
- Push events persisted to `push_events` table (delivery guarantee)
- On reconnect: pending pushes delivered via `pushService.deliverPending()`
- Cooldown check per session+type prevents duplicate pushes
- Two event types: `waitlist_match` (with clickable slot buttons) and `calendar_retry_success`

### B) SMS

**Outbound Use Cases:**
- SMS handoff link: voice caller gets a web chat resume link via SMS
- Follow-up contact: async outreach with booking options (via `send_contact_followup` job)
- Notification outbox entries with `channel='sms'` (pending actual send integration)

**Inbound Commands:**
- None currently implemented — no inbound SMS parsing

**Opt-Out Handling:**
- Not implemented — no STOP/opt-out processing

**Rate Limiting:**
- Per-phone: max 3 SMS per 60-min window (configurable via `SMS_RATE_LIMIT_MAX` / `SMS_RATE_LIMIT_WINDOW_MINUTES`)
- E.164 format validation before sending
- In-memory sliding window with periodic cleanup (5 min)

### C) Voice/Phone

**Architecture:**
- Twilio-native `<Gather speech>` for STT, `<Say>` for TTS (Polly.Joanna voice)
- State machine: 16 states (greeting → intent → service → date → slots → name → email → confirm → completed)
- Rule-based NLU: regex patterns for intent, yes/no, service, date, email, name, reference code detection
- Same tool executor as web chat — no booking logic duplication

**SMS Handoff:**
- Triggered when caller says "text me", "send me a link", etc. (`detectHandoffRequest`)
- Creates HMAC-SHA256 signed token (one-time use, 15-min TTL)
- Sends SMS with web chat resume URL
- Web client redeems token via `/handoff/resume` → pre-fills partial session context
- Token is opaque server-side key (no PII in URL)

---

## 7) Availability Sources

### Demo Availability (Default in Development)
- Active when: `DEMO_AVAILABILITY=true` AND `CALENDAR_MODE=mock`
- Generates: Mon–Fri 9:00 AM – 5:00 PM ET, 30-min slots, 14-day lookahead
- Subtracts: existing appointments + active holds from generated slots
- Purpose: guarantees GUI testing works on weekends and with unconfigured tenants

### Calendar Integrations
- **Mock provider** (default): logs calls, returns fake event IDs, supports failure simulation modes (`CALENDAR_FAIL_MODE`: none, auth_error, network_error, timeout, all_ops_fail)
- **Real provider**: Google Calendar API v3 with OAuth2, supports: createEvent, deleteEvent, listEvents
- OAuth flow: `/api/oauth/google/connect` → consent → callback → tokens stored on tenant
- Auto token refresh on expiry
- Read/write: real provider both reads (listEvents for cross-check) and writes (createEvent, deleteEvent)

### Conflict Detection
- **Slot generation**: availability service generates all possible slots from business hours, then subtracts occupied ranges (appointments + holds)
- **Hold creation**: DB EXCLUDE constraint (removed in migration 002, now enforced via advisory locks + active-range index)
- **Booking confirmation**: SERIALIZABLE transaction + advisory lock + EXCLUDE constraint on `appointments` table
- **Cross-table**: availability check considers both `appointments` AND `availability_holds` tables

---

## 8) What Is NOT Implemented Yet

- **Actual email delivery**: notification outbox writes to DB but no SMTP/SendGrid integration sends them
- **Actual SMS delivery for notifications**: `send_contact_followup` writes to outbox; only handoff SMS uses Twilio REST
- **Inbound SMS**: no SMS parsing, no reply handling, no STOP/opt-out processing
- **Google Calendar read-back for availability**: availability engine uses DB-only slot generation (doesn't read existing GCal events to merge)
- **Multi-provider calendar support**: only Google Calendar provider exists (no Outlook, Apple, etc.)
- **Authentication / authorization for API endpoints**: no JWT, no API keys, no tenant auth on REST routes
- **Frontend tenant selection**: hardcoded demo tenant ID in frontend
- **Production database**: uses embedded PostgreSQL 18.1 for local dev; no managed PG configured
- **CI/CD pipeline**: no GitHub Actions, no Docker deployment, no production infra
- **Webhook notifications**: outbox supports `channel='webhook'` but no webhook dispatcher exists
- **Appointment reminders delivery**: reminder jobs are enqueued but no sender processes them
- **Excel read-back reconciliation**: reconciliation job skeleton exists but full bidirectional conflict resolution is partial
- **Voice call recording / transcription storage**: voice turns are logged to console but not persisted to DB
- **Handoff session continuity**: web chat receives partial context from voice handoff token but doesn't inject it into the LLM conversation history
- **Multi-language support**: English only
- **Time zone selection by user**: always uses tenant's configured timezone
- **Admin dashboard / backoffice UI**: no admin panel for managing tenants, viewing bookings, or configuring policies

---

## 9) Known Risks or TODOs

### Technical Debt
- **`race-condition.test.ts` and `excel-adapter.test.ts`**: use `main()` + `process.exit()` pattern instead of vitest `describe/it` wrappers → vitest reports "no test suite found" (not real failures — all 65 actual test assertions pass)
- **Voice sessions are in-memory**: server restart loses all active calls
- **SMS rate limits are in-memory**: server restart resets all rate limit counters
- **Handoff tokens are in-memory**: server restart invalidates all pending SMS handoff links
- **Push event cooldown**: relies on DB query, which is correct but adds latency per push
- **Calendar sync inside booking service**: real Google Calendar calls happen AFTER the DB transaction commits, creating a window where booking exists in DB but not in calendar
- **System prompt size**: ~4,000+ tokens — growing with each guardrail addition; may approach context budget limits if conversation is long

### Guardrails That Are Prompt-Based Only (Not Code-Enforced)
- **Ambiguous request clarification**: the system prompt tells the agent to ask, but nothing in code prevents `check_availability` from being called on a vague query
- **Date-distance confirmation**: the system prompt tells the agent to confirm far dates, but `hold_slot` in tool executor does NOT reject far-future dates programmatically
- **Phone call limitation language**: the system prompt forbids "I'll have someone call you" — no code enforcement
- **"Never confirm before tool success"**: the prompt says never say "confirmed" before `confirm_booking` returns — no code enforcement
- **Range language for SLAs**: the prompt says "within a few minutes to a couple of hours" — no code enforcement

### Security TODOs
- No authentication on any API route (anyone can call `/api/tenants/*/chat`)
- Google OAuth tokens stored in DB with placeholder encryption key (`dev-only-placeholder-key`)
- `ENCRYPTION_KEY` defaults to a known dev value
- No CSRF protection
- No input sanitization beyond Zod schema validation on env vars
- Twilio signature validation skipped when `TWILIO_AUTH_TOKEN` is empty (local dev convenience)

---

## 10) How to Safely Extend This System

### Constraints Future Changes Must Respect
1. **All booking mutations must go through SERIALIZABLE transactions** — never write directly to `appointments` outside `bookingService`
2. **All autonomous actions must be registered in `registered-tools.ts`** — the job runner ignores unregistered types
3. **All autonomous actions must be gated by `policyEngine.evaluate()`** — default-deny means a policy rule must exist
4. **Never call `confirm_booking` or `hold_slot` without the corresponding tool call** — the LLM must not shortcut the flow
5. **Never add a new tool to `agentTools` (LLM-facing) without a corresponding handler in `tool-executor.ts`** — unknown tools return error
6. **Calendar sync must remain OUTSIDE the booking transaction** — holding row locks during external HTTP calls causes deadlocks
7. **PII redaction must cover any new field containing personal data** — update `PII_FIELDS` set or `PII_PATTERNS` in `redact.ts`
8. **Domain events must be typed** — add to `DomainEventName` union + `DomainEventMap` in `events.ts`
9. **New env vars must be added to `envSchema`** (Zod) — the app crashes on startup with unvalidated vars
10. **Voice session state machine must remain finite** — 16 defined states; new states require handlers in `conversation-engine.ts`
11. **Tests must remain passing (65/65)** — no PR should reduce coverage; run `npx vitest run` from `src/backend/`

### Parts That Should NOT Be Bypassed
- **Policy engine**: never hardcode "allow" — always evaluate
- **Audit logging**: never skip `auditRepo.log()` for state-changing operations
- **EXCLUDE constraints on appointments**: never remove — they are the last-resort overbooking prevention
- **Hold TTL cleanup**: never disable — stale holds permanently block slots
- **Tool allowlist**: never add `exec`, `spawn`, `eval`, `require`, filesystem, or arbitrary HTTP tools
- **PII redaction**: never log raw PII to `audit_log`
- **SERIALIZABLE isolation**: never downgrade to READ COMMITTED for booking operations
- **Event bus error isolation**: handler errors must never crash the bus — this is enforced by try/catch in `DomainEventBus.on()`

---

*End of export. 65 tests passing. No new features proposed.*
