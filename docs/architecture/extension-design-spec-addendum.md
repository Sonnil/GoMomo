# Extension Design Spec — Addendum: Missing Details

> Fills the five gaps identified in the Prompt 4 design spec.
> Cross-references the **implemented code** (src/backend/src/voice/*, src/backend/src/stores/excel-sync-adapter.ts, etc.) against the original spec to show what was designed vs what was built and where they diverge.

---

## Table of Contents

1. [Exact Webhook Endpoints & TwiML Flow](#1-exact-webhook-endpoints--twiml-flow)
2. [Barge-In Handling, Timeouts & Retries](#2-barge-in-handling-timeouts--retries)
3. [Voice Session State Machine](#3-voice-session-state-machine)
4. [Excel Concurrency & Conflict Resolution](#4-excel-concurrency--conflict-resolution)
5. [Source of Truth Decision](#5-source-of-truth-decision)

---

## 1. Exact Webhook Endpoints & TwiML Flow

### 1.1 Endpoint Table

The design spec (§2.8) showed a generic sequence diagram. Here are the **exact routes** as implemented in `voice.routes.ts` and `handoff.routes.ts`:

| Method | Path | Content-Type | Twilio Calls It? | Purpose |
|--------|------|-------------|-------------------|---------|
| `POST` | `/twilio/voice/incoming` | `application/x-www-form-urlencoded` | **Yes** — configure as Voice webhook URL in Twilio console | Entry point for every inbound call. Returns initial `<Gather>` TwiML with a spoken greeting. |
| `POST` | `/twilio/voice/continue` | `application/x-www-form-urlencoded` | **Yes** — specified in the `action` attribute of every `<Gather>` | Receives each speech turn (`SpeechResult`). Runs the state machine. Returns the next `<Gather>` or `<Say><Hangup>`. |
| `POST` | `/twilio/status` | `application/x-www-form-urlencoded` | **Yes** — configure as Status Callback URL in Twilio console | Receives call lifecycle events (`completed`, `failed`, `busy`, `no-answer`). Cleans up the in-memory session. |
| `POST` | `/handoff/sms` | `application/json` | No — internal | Triggers SMS handoff from an active voice session. Creates token, sends SMS via Twilio REST API. |
| `GET`  | `/handoff/resume` | — | No — browser | Web client redeems the handoff token. Returns partial session context so the widget can continue the booking. |
| `GET`  | `/twilio/voice/sessions` | — | No — dev only | Debug endpoint (development mode only). Lists all active voice sessions with state, intent, turn count. |

### 1.2 Twilio Console Configuration

```
Twilio Phone Number → Voice & Fax
├── A CALL COMES IN:
│   Webhook: POST  https://{TWILIO_WEBHOOK_BASE_URL}/twilio/voice/incoming
│
├── CALL STATUS CHANGES:
│   Webhook: POST  https://{TWILIO_WEBHOOK_BASE_URL}/twilio/status
│
└── PRIMARY HANDLER FAILS:
    Fallback: (none — Twilio plays a default "application error" message)
```

### 1.3 TwiML Templates (Exact XML)

The spec mentioned TwiML but never showed the exact XML structure. There are **three TwiML templates**, all generated in `twiml-builder.ts`:

#### Template 1: `buildGatherTwiML` — Used for every conversational turn

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="{TWILIO_WEBHOOK_BASE_URL}/twilio/voice/continue" method="POST"
    timeout="3" speechTimeout="auto"
    speechModel="phone_call" language="en-US"
    enhanced="true" bargeIn="true" hints="{context-specific hints}">
    <Say voice="Polly.Joanna" language="en-US">{prompt text}</Say>
  </Gather>
  <Redirect method="POST">{TWILIO_WEBHOOK_BASE_URL}/twilio/voice/continue?timeout=true</Redirect>
</Response>
```

**Key attributes explained:**

| Attribute | Value | Why |
|-----------|-------|-----|
| `input` | `"speech"` | We only accept voice input (no DTMF in MVP) |
| `timeout` | `3` | Wait 3 seconds of silence before treating as "no input" |
| `speechTimeout` | `"auto"` | Twilio's ML-based end-of-utterance detection (≈1.5s adaptive pause) |
| `speechModel` | `"phone_call"` | Twilio's telephony-optimized STT model (8kHz μ-law) |
| `enhanced` | `"true"` | Enables Twilio's enhanced speech recognition ($0.02/15s premium) |
| `bargeIn` | `"true"` | Caller can interrupt the `<Say>` — Twilio stops TTS and starts STT |
| `hints` | varies | Comma-separated keywords that boost STT accuracy for expected inputs |

**The `<Redirect>` fallback:** If `<Gather>` times out with no speech detected, Twilio follows the `<Redirect>` and POSTs to `/twilio/voice/continue?timeout=true`. The conversation engine detects `query.timeout === 'true'` and handles it as a silence/retry (see §2).

#### Template 2: `buildSayHangupTwiML` — Terminal responses

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">{farewell message}</Say>
  <Hangup/>
</Response>
```

Used for: booking confirmation, too-many-retries, call expiry, error recovery.

#### Template 3: `buildSayRedirectTwiML` — Say then continue

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">{intermediate message}</Say>
  <Redirect method="POST">{next URL}</Redirect>
</Response>
```

Used for: transitional messages before the next gather (e.g., "Let me check that…").

### 1.4 Complete Call Flow (Request-by-Request)

```
 Caller dials         Twilio                      Our Server
   │                    │                              │
   │─── INVITE ────────►│                              │
   │                    │── POST /twilio/voice/incoming │
   │                    │   Body: { CallSid, From, To } │
   │                    │                              │
   │                    │◄── 200 + TwiML ──────────────│
   │                    │   <Gather bargeIn="true">     │
   │                    │     <Say>"Welcome to Bloom..." │
   │                    │   </Gather>                   │
   │                    │   <Redirect>...?timeout=true  │
   │                    │                              │
   │◄── Plays greeting ─│                              │
   │                    │                              │
 ┌─┤ SCENARIO A: Caller speaks during greeting (barge-in) ├──┐
 │ │                    │                              │     │
 │ │── "book appoint…" ►│                              │     │
 │ │   (interrupts Say) │── POST /twilio/voice/continue │     │
 │ │                    │   Body: { SpeechResult: "book │     │
 │ │                    │     an appointment" }         │     │
 │ └────────────────────┤                              │     │
 │                      │                              │     │
 ├─┤ SCENARIO B: Caller waits, then speaks             ├──┐  │
 │ │                    │                              │  │  │
 │ │── "I'd like to…"──►│                              │  │  │
 │ │   (after Say ends) │── POST /twilio/voice/continue │  │  │
 │ │                    │   Body: { SpeechResult: "..." }  │  │
 │ └────────────────────┤                              │  │  │
 │                      │                              │  │  │
 ├─┤ SCENARIO C: Caller says nothing (timeout)         ├──┘  │
 │ │                    │                              │     │
 │ │   (3s silence)     │── POST /twilio/voice/continue │     │
 │ │                    │   (via <Redirect>)           │     │
 │ │                    │   Query: ?timeout=true        │     │
 │ │                    │   Body: { SpeechResult: "" }  │     │
 │ └────────────────────┤                              │     │
 │                      │                              │     │
 │                      │◄── 200 + TwiML (next turn) ──│     │
 │                      │   <Gather>...<Say>...         │     │
 │                      │                              │     │
 │      ···  (loop continues for each turn)  ···       │     │
 │                      │                              │     │
 │   TERMINAL: Booking confirmed / error / max turns   │     │
 │                      │◄── 200 + TwiML ──────────────│     │
 │                      │   <Say>"Confirmed! Ref..."    │     │
 │                      │   <Hangup/>                   │     │
 │                      │                              │     │
 │◄── Call ends ────────│                              │     │
 │                      │── POST /twilio/status ────────►     │
 │                      │   Body: { CallStatus:        │     │
 │                      │           "completed" }       │     │
 │                      │                              │     │
 │                      │◄── 200 { received: true } ───│     │
 └──────────────────────┴──────────────────────────────┘     │
```

### 1.5 Twilio Signature Validation

Every incoming webhook is validated against `X-Twilio-Signature` using HMAC-SHA1 of the full request URL + sorted body params, compared with constant-time `crypto.timingSafeEqual`. Validation is **skipped** when `TWILIO_AUTH_TOKEN` is empty (local dev mode).

### 1.6 Spec vs Implementation Divergence

| Spec Section | What the Spec Designed | What Was Built | Why |
|---|---|---|---|
| §2.1 Media Streams | WebSocket-based audio streaming (`wss://host/twilio-stream`) with custom STT/TTS pipeline | Twilio's native `<Gather speech>` + `<Say>` | MVP simplification. `<Gather>` handles STT+TTS in one round-trip. No WebSocket server, no audio buffer, no resampler. Dramatically simpler. |
| §2.3 STT Pipeline | Deepgram Nova-2 via WebSocket streaming | Twilio's built-in enhanced speech recognition (`speechModel="phone_call"`) | Eliminated external STT dependency entirely. Twilio's model is sufficient for booking conversations. |
| §2.4 TTS Pipeline | Azure Neural TTS / ElevenLabs with sentence-level streaming | Twilio's `<Say>` with `Polly.Joanna` voice | No external TTS provider needed. Twilio synthesizes directly. Latency tradeoff: slightly less natural voice, but zero added infrastructure. |

---

## 2. Barge-In Handling, Timeouts & Retries

### 2.1 Barge-In (Implemented)

The spec designed a complex barge-in system (§2.5) with VAD energy thresholds, transcript-length gating, cooldowns, and partial-playback tracking. The implementation is **radically simpler** because we use Twilio's native `<Gather bargeIn="true">`:

```
How it actually works:
─────────────────────
1. <Gather bargeIn="true"> wraps a <Say> element
2. Twilio plays the <Say> audio to the caller
3. If the caller starts speaking while <Say> is playing:
   a. Twilio IMMEDIATELY stops <Say> playback
   b. Twilio starts speech recognition on the caller's audio
   c. When the caller stops (speechTimeout="auto"), Twilio POSTs SpeechResult
4. If the caller waits until <Say> finishes:
   a. Twilio waits up to `timeout` seconds (3s) for speech
   b. If speech detected → same as above
   c. If no speech → falls through to <Redirect>
```

**What we DON'T need (eliminated from the spec):**
- No VAD energy threshold tuning (`-26 dBFS`)
- No `min_speech_duration_ms` debounce
- No `min_interim_chars` filtering
- No `cooldown_after_barge_ms`
- No partial-playback position tracking
- No manual TTS cancellation (`<Stop>`)

All of this is handled by Twilio's `bargeIn="true"` internally. The attribute is set on **every** `<Gather>` produced by `buildGatherTwiML`, so barge-in is always active.

**Limitation:** We don't know *how much* of the prompt the caller heard before interrupting. The spec's `interrupted_response` / `heard_up_to` context is not available. In practice this hasn't been a problem because each prompt is a focused question and the caller's response contains enough intent signal.

### 2.2 Timeout Handling

Three levels of timeout protection exist, each implemented:

#### Level 1: Per-Gather silence timeout (Twilio-managed)

| Parameter | Value | Source |
|-----------|-------|--------|
| `timeout` | `3` seconds | Hardcoded in `buildGatherTwiML` |
| `speechTimeout` | `"auto"` | `VOICE_SPEECH_TIMEOUT` env var (default: `"auto"`) |

- `timeout` = how long Twilio waits for the **start** of speech after `<Say>` finishes.
- `speechTimeout="auto"` = Twilio uses ML to detect end-of-utterance. Typically 1–2s of silence after the last word.

When timeout fires with no speech, Twilio follows the `<Redirect>` fallback:
```
POST /twilio/voice/continue?timeout=true
Body: { CallSid: "...", SpeechResult: "" }
```

The conversation engine detects `isTimeout && !speechResult` and triggers the retry flow (see below).

#### Level 2: Per-step retry limit (our state machine)

```typescript
// conversation-engine.ts — entry guard
if (isTimeout && !speechResult) {
  const retries = incrementRetry(session);     // session.retries++
  if (isRetryLimitReached(session)) {          // retries >= VOICE_MAX_RETRIES (3)
    advanceState(session, 'completed');
    return buildSayHangupTwiML(
      "I haven't heard from you, so I'll let you go. ..."
    );
  }
  // Re-ask with a modified prompt
  return buildGatherTwiML({
    prompt: `I didn't catch that. ${session.lastPrompt}`,
    action: CONTINUE_URL(),
  });
}
```

**Key: `session.retries` resets to 0 on every state transition** (`advanceState` calls `session.retries = 0`). So the 3-retry limit is per-step, not per-call.

Each state handler ALSO applies per-step retry logic for **misunderstood input** (speech was received but NLU couldn't extract data):

```
State Handler Retry Pattern:
──────────────────────────────
1. Call detectXxx(speech) — NLU extraction
2. If null/unknown:
   a. incrementRetry(session)
   b. If retries < 3 → re-prompt with clarification
   c. If retries >= 3 → either:
      - Fall back to a default (e.g., first service, raw speech as name)
      - Escalate to SMS handoff
      - Hang up gracefully
```

| State | On max retries (3) |
|-------|-------------------|
| `collecting_intent` | Re-prompt with explicit menu: "book, reschedule, or cancel?" |
| `collecting_service` | Default to first listed service |
| `collecting_date` | Hang up + suggest website |
| `offering_slots` | Default to first available slot |
| `collecting_name` | Accept raw speech as the name |
| `collecting_email` | Offer SMS handoff; if unavailable → hang up |
| `confirming_booking` | Treat as "yes" (user likely agreeing) |
| `collecting_reference` | Hang up + suggest website |
| `confirming_reschedule` | Treat as "yes" |
| `confirming_cancel` | Treat as "yes" |

#### Level 3: Call-level limits (guard rails)

| Guard | Threshold | Env Var | On trigger |
|-------|-----------|---------|------------|
| Max call duration | 600,000ms (10 min) | `VOICE_MAX_CALL_DURATION_MS` | `<Say>` "reached the time limit" + `<Hangup>` |
| Max turns | 20 | `VOICE_MAX_TURNS` | `<Say>` "been chatting for a while, try our website" + `<Hangup>` |
| Max concurrent calls per tenant | 5 | Hardcoded in `voice.routes.ts` | `<Say>` "all lines are busy" + `<Hangup>` |

These are checked **at the top of every turn** in `processVoiceTurn()`, before the state machine dispatch.

### 2.3 Retry Configuration Summary

```
VOICE_MAX_RETRIES=3          # Per-state misunderstanding tolerance
VOICE_MAX_TURNS=20           # Total turns per call
VOICE_MAX_CALL_DURATION_MS=600000  # 10 minutes hard cap
<Gather timeout="3">         # Seconds of silence before "no input"
<Gather speechTimeout="auto"> # ML-based end-of-utterance detection
```

---

## 3. Voice Session State Machine

### 3.1 State Enum

The spec (§2.7) showed a simplified 5-state diagram (`RINGING → ANSWER → CONVERSATION_LOOP → FAREWELL → HANG_UP`). The actual state machine has **16 states** defined in `domain/types.ts`:

```typescript
type VoiceCallState =
  | 'greeting'                    // Initial state — first Gather with welcome message
  | 'collecting_intent'           // "Do you want to book, reschedule, or cancel?"
  | 'collecting_service'          // "What service are you looking for?"
  | 'collecting_date'             // "What date works for you?"
  | 'offering_slots'              // "Available times: 1. 10am, 2. 11am..."
  | 'collecting_slot_choice'      // Re-ask slot if unclear
  | 'collecting_name'             // "What is your full name?"
  | 'collecting_email'            // "What's your email address?"
  | 'confirming_booking'          // "Confirm: Alex, Acupuncture, 2pm. Book it?"
  | 'collecting_reference'        // "What's your reference code?" (reschedule/cancel)
  | 'collecting_reschedule_date'  // "What new date?"
  | 'offering_reschedule_slots'   // "Available times for rescheduling..."
  | 'confirming_reschedule'       // "Reschedule to 3pm Thursday. Confirm?"
  | 'confirming_cancel'           // "Cancel appointment APT-ABC123. Sure?"
  | 'completed'                   // Terminal — booking done, hangup sent
  | 'error';                      // Terminal — unrecoverable error
```

### 3.2 Intents

```typescript
type VoiceIntent = 'book' | 'reschedule' | 'cancel' | 'unknown';
```

### 3.3 Full State Transition Diagram

```
                          ┌───────────────────────────────────────────────┐
                          │              CALL ENTRY                        │
                          │  POST /twilio/voice/incoming                   │
                          └──────────────────┬────────────────────────────┘
                                             │
                                             ▼
                                      ┌──────────────┐
                                      │  greeting     │ ← Initial state
                                      └──────┬───────┘
                                             │ (speech arrives)
                                             ▼
                                      ┌────────────────────┐
                                      │ collecting_intent   │◄──────────────┐
                                      │                    │               │
                                      │ NLU: detectIntent() │               │
                                      └─────┬──────┬──────┬┘               │
                                            │      │      │                │
                               intent=book  │      │      │ intent=reschedule│
                                            │      │      │ or cancel      │
                                            ▼      │      ▼                │
                                ┌─────────────────┐│ ┌───────────────────┐ │
                                │collecting_service││ │collecting_reference│ │
                                │                 ││ │                   │ │
                                │NLU: detectService││ │NLU: detectRefCode │ │
                                └────────┬────────┘│ │or detectEmail     │ │
                                         │         │ └─────────┬─────────┘ │
                                         ▼         │           │           │
                                ┌─────────────────┐│           │           │
                                │ collecting_date  ││           │           │
                                │                  ││           │           │
                                │NLU: detectDate() ││           │           │
                                │→ voiceCheckAvail ││           │           │
                                └────────┬─────────┘│           │           │
                                         │          │           │           │
                           slots found   │          │  ┌────────┴──────┐   │
                                         ▼          │  │ voiceLookup   │   │
                                ┌─────────────────┐ │  │ Booking()     │   │
                                │ offering_slots   │ │  └──┬─────────┬─┘   │
                                │                  │ │     │         │     │
                                │NLU: detectSlot() │ │  cancel?  reschedule?│
                                └────────┬─────────┘ │     │         │     │
                                         │           │     ▼         ▼     │
                                  slot chosen         │ ┌──────────┐ ┌────────────────────┐
                                         │           │ │confirming│ │collecting_reschedule│
                                         ▼           │ │_cancel   │ │_date               │
                                ┌─────────────────┐  │ │          │ │                    │
                                │ voiceHoldSlot() │  │ │yes → cancel│ │NLU: detectDate()  │
                                └────────┬────────┘  │ │no → abort │ │→ voiceCheckAvail   │
                                         │           │ └─────┬────┘ └────────┬───────────┘
                                         ▼           │       │              │
                                ┌─────────────────┐  │       │              ▼
                                │ collecting_name  │  │       │    ┌────────────────────┐
                                │                  │  │       │    │offering_reschedule_│
                                │NLU: detectName() │  │       │    │slots               │
                                └────────┬─────────┘  │       │    │                    │
                                         │            │       │    │NLU: detectSlot()   │
                                         ▼            │       │    │→ voiceHoldSlot()   │
                                ┌─────────────────┐   │       │    └────────┬───────────┘
                                │collecting_email  │   │       │             │
                                │                  │   │       │             ▼
                                │NLU: detectEmail()│   │       │   ┌──────────────────┐
                                └────────┬─────────┘   │       │   │confirming_       │
                                         │             │       │   │reschedule        │
                                         ▼             │       │   │                  │
                                ┌─────────────────────┐│       │   │yes → reschedule  │
                                │confirming_booking    ││       │   │no → abort        │
                                │                     ││       │   └──────┬───────────┘
                                │yes → voiceConfirm   ││       │          │
                                │no  → reset to intent││       │          │
                                └──────────┬──────────┘│       │          │
                                           │           │       │          │
                   ┌───────────────────────┼───────────┘       │          │
                   │                       │                   │          │
                   │                       ▼                   ▼          ▼
                   │              ┌──────────────────────────────────────────┐
                   │              │              completed                   │
                   │              │                                          │
                   │              │  <Say> confirmation/farewell + <Hangup>  │
                   │              └──────────────────────────────────────────┘
                   │
                   │   (on "no" answer)
                   └──────────────► back to collecting_intent
```

### 3.4 State Transition Table (Machine-Readable)

| From State | Trigger | Condition | To State | Side Effect |
|---|---|---|---|---|
| `greeting` | speech received | always | `collecting_intent` | — |
| `collecting_intent` | speech | `detectIntent()` = `book` | `collecting_service` | `session.intent = 'book'` |
| `collecting_intent` | speech | `detectIntent()` = `reschedule\|cancel` | `collecting_reference` | `session.intent = detected` |
| `collecting_intent` | speech | `detectIntent()` = `unknown` | `collecting_intent` | `retries++` |
| `collecting_service` | speech | `detectService()` succeeds | `collecting_date` | `session.service = detected` |
| `collecting_service` | speech | `detectService()` = null, retries ≥ 3 | `collecting_date` | default to first service |
| `collecting_date` | speech | `detectDate()` + slots > 0 | `offering_slots` | `session.date`, `session.availableSlots` set |
| `collecting_date` | speech | `detectDate()` + slots = 0 | `collecting_date` | "No slots, try another date" |
| `collecting_date` | speech | `detectDate()` = null, retries ≥ 3 | `completed` | Hang up + suggest website |
| `offering_slots` | speech | `detectSlotChoice()` succeeds + hold succeeds | `collecting_name` | `session.selectedSlot`, `session.holdId` set |
| `offering_slots` | speech | hold fails (slot taken) | `offering_slots` | "Slot was just taken" |
| `collecting_name` | speech | `detectName()` succeeds | `collecting_email` | `session.clientName` set |
| `collecting_name` | speech | retries ≥ 3 | `collecting_email` | use raw speech as name |
| `collecting_email` | speech | `detectEmail()` succeeds | `confirming_booking` | `session.clientEmail` set |
| `collecting_email` | speech | retries ≥ 3, SMS available | `collecting_email` | offer SMS handoff |
| `collecting_email` | speech | retries ≥ 3, no SMS | `completed` | hang up |
| `confirming_booking` | speech | `detectYesNo()` = `yes` + confirm succeeds | `completed` | `<Say>` + `<Hangup>` with ref code |
| `confirming_booking` | speech | `detectYesNo()` = `no` | `collecting_intent` | reset partial fields |
| `collecting_reference` | speech | `detectReferenceCode()` or `detectEmail()` + lookup succeeds + intent = `cancel` | `confirming_cancel` | `session.appointmentId` set |
| `collecting_reference` | speech | lookup succeeds + intent = `reschedule` | `collecting_reschedule_date` | `session.appointmentId` set |
| `collecting_reschedule_date` | speech | `detectDate()` + slots > 0 | `offering_reschedule_slots` | `session.availableSlots` set |
| `offering_reschedule_slots` | speech | `detectSlotChoice()` + hold succeeds | `confirming_reschedule` | `session.selectedSlot`, `session.holdId` set |
| `confirming_reschedule` | speech | `yes` + reschedule succeeds | `completed` | — |
| `confirming_reschedule` | speech | `no` | `completed` | keep original appointment |
| `confirming_cancel` | speech | `yes` + cancel succeeds | `completed` | — |
| `confirming_cancel` | speech | `no` | `completed` | keep appointment |
| **any state** | `detectHandoffRequest()` = true | SMS enabled + callerPhone present | `completed` | create token, send SMS, hang up |
| **any state** | turn ≥ 20 | — | `completed` | "try our website" + hang up |
| **any state** | call duration ≥ 10min | — | `completed` | "time limit" + hang up |
| **any state** | timeout + retries ≥ 3 | — | `completed` | "haven't heard from you" + hang up |

### 3.5 Session Data Model

The full session object tracked in-memory (keyed by `CallSid`):

```typescript
interface VoiceSession {
  callSid: string;           // Twilio Call SID (primary key)
  tenantId: string;          // Which business this call is for
  sessionId: string;         // "voice-{uuid}" — maps to chat_sessions.id
  state: VoiceCallState;     // Current state machine position
  intent: VoiceIntent;       // book | reschedule | cancel | unknown
  retries: number;           // Consecutive misunderstandings (resets on state change)
  turnCount: number;         // Total turns this call (never resets)
  startedAt: number;         // Date.now() at call start
  lastPrompt: string;        // Last spoken prompt (for retry rephrasing)
  callerPhone: string | null; // E.164 from Twilio (for SMS handoff)

  // Progressively filled by the state machine:
  service: string | null;
  date: string | null;       // "2026-02-10"
  selectedSlot: { start: string; end: string } | null;
  holdId: string | null;     // From voiceHoldSlot()
  clientName: string | null;
  clientEmail: string | null;
  clientNotes: string | null;
  bookingId: string | null;
  referenceCode: string | null;

  // For reschedule/cancel:
  appointmentId: string | null;
  lookupResults: Array<{ appointment_id, reference_code, service, start_time, status }>;
  availableSlots: Array<{ start, end, display_time }>;
}
```

**Storage:** In-memory `Map<string, VoiceSession>`. No DB persistence. Session is created on call start, deleted on call end (or after 5-minute grace period for status callbacks). This is acceptable because voice sessions are short-lived (< 10 min) and the real state (holds, bookings) is in PostgreSQL.

---

## 4. Excel Concurrency & Conflict Resolution

### 4.1 Architecture Implemented: Hybrid (Option B from Spec)

The spec (§3.2) evaluated three options and recommended Option B. This is exactly what was built:

```
PostgreSQL (source of truth)  ──async──►  Excel file (read-only mirror)
         ▲                                        │
         │                                        │
    All reads                              Admin views
    All writes                             (manual edits are NOT
    SERIALIZABLE txns                       ingested back — MVP)
    Advisory locks
    EXCLUDE constraints
```

### 4.2 What Concurrency Controls Actually Exist (in Code)

#### Write Path (Bot Books an Appointment)

```
1. Web chat / voice call → BookingService.confirmBooking()
2. BookingService uses BookingStore interface
3. BookingStoreFactory resolves to:
   ├── PostgresBookingStore (default)
   └── ExcelSyncAdapter wrapping PostgresBookingStore (if Excel enabled)

4. ExcelSyncAdapter.create(data, txClient):
   a. Delegates to inner.create() → PostgresBookingStore
      └── SERIALIZABLE transaction
      └── Advisory lock on (tenant_id, date)
      └── EXCLUDE constraint prevents time overlap
      └── Returns Appointment object
   b. Emits SyncEvent via setImmediate()
      └── syncEmitter.emit('sync', { type: 'booking.created', appointment })
      └── Non-blocking — does NOT delay the response to the caller

5. ExcelSyncWorker picks up the event:
   a. Looks up tenant's ExcelIntegrationConfig
   b. Calls appointmentToExcelRow() → converts to Excel format
   c. Calls upsertExcelRow() → finds row by db_id, updates or appends
   d. Retries on failure: 3 attempts, backoff [2s, 8s, 30s]
   e. On exhaustion → insertDeadLetter() (persisted in sync_dead_letter table)
   f. On success → markSynced() (sets sync_status='synced', last_synced_at)
```

**Key: The Postgres write and the Excel write are completely decoupled.** The API response is sent after step 4a. Step 5 runs asynchronously. If Excel sync fails, the booking still exists in PostgreSQL and the caller gets their confirmation.

#### Excel File Operations (Concurrency within ExcelJS)

```
Problem: exceljs reads the entire file into memory, modifies, writes back.
         If two sync events fire simultaneously for the same file, they'll
         clobber each other (read-modify-write race).

Current mitigation: Node.js single-threaded event loop.
─────────────────────────────────────────────────────────
- syncEmitter is an EventEmitter
- processSyncEvent() is async but events are dispatched serially
  by Node.js (one listener invocation at a time per event)
- upsertExcelRow() calls readFile → modify → writeFile atomically
  within a single async chain (no other event handler can interleave
  between the read and write on the same file)

Limitation: This is safe within a single process ONLY.
            Multiple processes (horizontal scaling) would need
            file-level locking (e.g., lockfile npm package) or
            a queue worker pattern.

For the MVP (single-process): this is sufficient.
For production: the Excel file should be written from a single
                background worker process (see §4.4).
```

#### Batch Upsert (Reconciliation)

The `batchUpsertExcelRows()` function reads the file once, upserts all rows, writes once. This avoids the N×read-modify-write problem for reconciliation:

```
batchUpsertExcelRows(filePath, excelRows[]):
  1. readFile(filePath) → workbook in memory
  2. Build index: Map<db_id, rowNumber> from existing data
  3. For each excelRow:
     - If db_id exists → update in place
     - If new → append
  4. writeFile(filePath) → single atomic write
  Return: Map<db_id, rowNumber> for caller to update sync metadata
```

### 4.3 Reconciliation Job

The `excel-reconciliation.ts` job runs every 5 minutes (configurable) and handles three drift scenarios:

| Scenario | Detection | Resolution |
|---|---|---|
| **DB writes not synced** | `appointments WHERE sync_status IN ('pending', 'failed')` | Re-push to Excel via `batchUpsertExcelRows()` |
| **Dead letter queue** | `sync_dead_letter WHERE resolved = false AND attempts < 10` | Re-attempt sync; resolve if appointment was deleted |
| **DB rows missing from Excel** | Compare `appointments.id` set vs `ExcelRow.db_id` set | Backfill missing rows into Excel |

```
Reconciliation cycle (per tenant):
──────────────────────────────────
1. getUnsyncedAppointments(tenantId) → LIMIT 100
   → batchUpsertExcelRows()
   → markAppointmentSynced() for each

2. getDeadLetterEntries(tenantId) → LIMIT 50
   → for each: re-fetch appointment, retry sync
   → resolveDeadLetter() on success
   → incrementDeadLetterAttempt() on failure

3. getConfirmedAppointments(tenantId) → LIMIT 500
   → readExcelRows() from file
   → diff: find DB IDs not in Excel
   → batchUpsertExcelRows() for missing

4. updateLastReconciliation(tenantId) → timestamp in JSONB
```

### 4.4 What's NOT Implemented (Spec vs Reality)

| Spec Feature (§3.3–3.4) | Status | Why Deferred |
|---|---|---|
| **Inbound sync (Excel → DB)** | ❌ Not built | MVP is outbound-only. Admin edits in Excel are NOT reflected in DB. This is the biggest gap. Planned for Phase 2. |
| **Graph API / OneDrive integration** | ❌ Not built | MVP uses local `.xlsx` files via `exceljs`. `ExcelIntegrationConfig` has `drive_id` / `file_id` fields ready but unused. |
| **SharePoint webhooks** | ❌ Not built | Requires inbound sync first. Config has `last_etag` field ready for ETag-based polling. |
| **`_Locks` sheet (CAS emulation)** | ❌ Not needed | With Hybrid approach, all writes go through PostgreSQL. No Excel-level locking needed. |
| **ETag-based conditional writes** | ❌ Not needed | Same reason — no direct Excel writes that could race. |
| **Co-authoring conflict resolution** | ❌ Not needed (MVP) | In outbound-only mode, conflicts can't occur. Admin can freely edit the Excel file; it just won't be ingested back. |
| **Cell-level conflict highlighting** | ❌ Not built | Requires inbound sync + diff logic. |
| **File-level mutex for multi-process** | ❌ Not built | Single-process MVP. Node.js event loop serialization is sufficient. |

### 4.5 Dead Letter Schema

```sql
CREATE TABLE sync_dead_letter (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  appointment_id  UUID NOT NULL,
  operation       TEXT NOT NULL,       -- 'create' | 'update'
  error_message   TEXT,
  payload         JSONB,              -- ExcelRow snapshot at failure time
  attempts        INTEGER DEFAULT 0,
  last_failed_at  TIMESTAMPTZ,
  resolved        BOOLEAN DEFAULT false,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
```

### 4.6 Sync Status Lifecycle

```
  Appointment created in PostgreSQL
           │
           ▼
  sync_status = 'pending'  ← default on INSERT
           │
     SyncWorker picks up
           │
     ┌─────┴──────┐
     │             │
  success       failure (after 3 retries)
     │             │
     ▼             ▼
  'synced'      'failed'
     │             │
     │        dead_letter row created
     │             │
     │      Reconciliation job retries (every 5 min)
     │             │
     │        ┌────┴────┐
     │        │         │
     │     success   10 attempts exhausted
     │        │         │
     │        ▼         ▼
     │     'synced'   manual intervention required
     │
  (future status changes trigger new sync events)
```

---

## 5. Source of Truth Decision

### 5.1 The Decision

> **PostgreSQL is the single, unconditional source of truth for all booking data.**

Every other data store (Excel, Google Calendar, future Outlook) is a **downstream mirror**. They receive data from PostgreSQL. They never feed data back (MVP). If any mirror diverges from PostgreSQL, PostgreSQL wins and the mirror is overwritten.

### 5.2 Why This Decision Was Made

| Consideration | PostgreSQL | Excel File | Google Calendar |
|---|---|---|---|
| **ACID transactions** | ✅ SERIALIZABLE isolation | ❌ No transactions | ❌ No transactions |
| **Concurrent writes** | ✅ Advisory locks + EXCLUDE | ❌ Last-write-wins | ❌ Last-write-wins |
| **Double-booking prevention** | ✅ `EXCLUDE USING gist` constraint | ❌ No overlap detection | ❌ No overlap detection |
| **Read latency** | ✅ < 5ms | ❌ 200–800ms (file I/O or Graph API) | ❌ 100–500ms (REST API) |
| **Write latency** | ✅ < 10ms | ❌ 200–800ms | ❌ 100–500ms |
| **Availability** | ✅ 99.99% (managed DB) | ❌ File can be locked, moved, deleted | ❌ Google API outages |
| **Programmatic access** | ✅ SQL | ❌ Custom library/API | ❌ REST API with quotas |
| **Schema enforcement** | ✅ DDL + constraints | ❌ User can reformat freely | ❌ Limited schema control |
| **Audit trail** | ✅ Triggers + updated_at | ❌ File versioning only | ❌ Event history limited |
| **Works offline** | ✅ Always (self-hosted) | ✅ Local file (partial) | ❌ Requires internet |

**The core problem PostgreSQL solves that no alternative can:** Two people (or a bot and a human) trying to book the same 2pm slot at the same time. PostgreSQL's `EXCLUDE USING gist` constraint + `SERIALIZABLE` isolation + advisory locks make this **physically impossible at the database level**. Excel and Google Calendar have no equivalent primitive.

### 5.3 How It's Enforced in Code

```
                    ┌─────────────────────────────────────────┐
                    │         BookingStore Interface            │
                    │   findById(), create(), updateStatus()    │
                    └──────────────┬──────────────────────────┘
                                   │
                    ┌──────────────┴──────────────────────────┐
                    │                                          │
          ┌─────────────────────┐               ┌──────────────────────┐
          │ PostgresBookingStore │               │   ExcelSyncAdapter    │
          │                     │               │                      │
          │ Direct DB reads     │               │ inner: BookingStore   │
          │ Direct DB writes    │               │  (always Postgres)    │
          │                     │               │                      │
          │ SERIALIZABLE txn    │               │ reads → inner.read() │
          │ Advisory locks      │               │ writes → inner.write()│
          │ EXCLUDE constraint  │               │   THEN emitSyncEvent │
          └─────────────────────┘               └──────────────────────┘
                                                         │
                                                    async, fire-and-forget
                                                         │
                                                         ▼
                                                ┌──────────────────────┐
                                                │  ExcelSyncWorker     │
                                                │                      │
                                                │  Listens to events   │
                                                │  Pushes to Excel     │
                                                │  3 retries + DLQ     │
                                                │                      │
                                                │  CANNOT change DB    │
                                                │  CANNOT reject a     │
                                                │  booking             │
                                                └──────────────────────┘
```

**The ExcelSyncAdapter is a write-through decorator.** It delegates every read and write to PostgreSQL, then **after a successful Postgres commit**, it asynchronously pushes the result to Excel. The Excel push:

1. Cannot fail the booking (fire-and-forget via `setImmediate`)
2. Cannot modify the booking data
3. Cannot block the API response
4. Can only mirror what PostgreSQL already committed

This architecture means that even if:
- The Excel file is deleted → bookings still exist in PostgreSQL
- The Excel file is corrupted → reconciliation job re-creates it
- The Graph API is down → dead letter queue retries later
- An admin edits Excel directly → their edits exist only in Excel (not ingested back in MVP)

### 5.4 Google Calendar: Same Pattern

The same source-of-truth principle applies to Google Calendar (already implemented in earlier phases):

```
BookingService.confirmBooking()
  │
  ├── 1. PostgreSQL INSERT (source of truth)
  │      └── SERIALIZABLE + EXCLUDE constraint
  │
  └── 2. calendarService.createEvent() (downstream mirror)
         └── Google Calendar API
         └── If fails → booking still exists in DB
         └── google_event_id stored for future sync
```

### 5.5 Future: What Happens When We Add Inbound Excel Sync (Phase 2)

The source-of-truth decision dictates the conflict resolution policy:

```
Admin edits cell in Excel (e.g., changes time of APT-ABC123)
  │
  ▼
IngestWorker detects change (webhook or poll)
  │
  ▼
Read full sheet → diff against PostgreSQL
  │
  ├── Admin added a NEW row → validate → INSERT into Postgres (if no conflict)
  │
  ├── Admin changed a field → validate in SERIALIZABLE txn:
  │     ├── No conflict → UPDATE Postgres, accept change
  │     └── Conflict (bot booked same slot) → REJECT admin change:
  │           ├── Write Postgres version back to Excel
  │           ├── Highlight cell RED
  │           └── Add cell comment: "⚠️ Conflict — reverted"
  │
  └── Admin deleted a row → soft-delete in Postgres (status='cancelled')

RULE: If PostgreSQL and Excel disagree, PostgreSQL wins. Always.
```

This keeps the invariant that the DB's EXCLUDE constraint is the final arbiter of whether a time slot is available.

---

*End of addendum. These five sections fill the gaps identified in the Prompt 4 extension design spec. All details are cross-referenced against the implemented code as of 2026-02-06.*
