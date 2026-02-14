# Phone MVP — Testing Guide

> **⚠️ BOOKING-ONLY MODE (Company PC):** Voice is currently disabled
> (`FEATURE_VOICE=false`). Phone testing requires Twilio + ngrok on a
> **personal machine** only. See [`docs/booking-only-mode.md`](./booking-only-mode.md).

## Architecture Decision: Twilio Native STT/TTS

We use **Twilio's built-in `<Gather speech>` for STT** and **`<Say>` for TTS**.
This means:
- No external STT/TTS providers needed for MVP
- No Media Streams WebSocket complexity
- Twilio handles audio encoding/decoding
- Our server only handles HTTP webhooks (POST requests)
- Barge-in is supported natively by `<Gather bargeIn="true">`

All booking operations go through the **same `executeToolCall()`** used by web chat.
Zero booking logic is duplicated.

---

## Environment Variables

Add these to your `.env` file:

```bash
# ── Twilio (optional for local testing — signature validation is skipped if empty) ──
TWILIO_ACCOUNT_SID=""
TWILIO_AUTH_TOKEN=""
TWILIO_PHONE_NUMBER=""
TWILIO_WEBHOOK_BASE_URL="http://localhost:3000"

# ── Voice Channel Settings ──
VOICE_ENABLED="true"
VOICE_DEFAULT_TENANT_ID="demo-tenant-001"     # Tenant to route calls to
VOICE_MAX_CALL_DURATION_MS=600000              # 10 minutes
VOICE_MAX_TURNS=20                             # Max speech turns per call
VOICE_MAX_RETRIES=3                            # Retries per step before giving up
VOICE_TTS_VOICE="Polly.Joanna"                # Twilio <Say> voice
VOICE_TTS_LANGUAGE="en-US"
VOICE_SPEECH_TIMEOUT="auto"                    # Twilio auto-detects end of speech
VOICE_SPEECH_MODEL="phone_call"                # Optimized for telephony audio
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/twilio/voice/incoming` | Twilio calls this when a call arrives |
| POST | `/twilio/voice/continue` | Twilio calls this with each speech result |
| POST | `/twilio/status` | Twilio calls this on call status changes |
| GET | `/twilio/voice/sessions` | Debug: list active voice sessions (dev only) |

---

## Local Testing (No Twilio Account Needed)

### Option 1: Voice Simulator Script

The simulator sends the same form-encoded POST requests that Twilio would send:

```bash
cd src/backend

# Happy path: book appointment
npx tsx tests/voice-simulator.ts --scenario=book

# Cancel flow
npx tsx tests/voice-simulator.ts --scenario=cancel

# Caller silence (timeout handling)
npx tsx tests/voice-simulator.ts --scenario=silence

# Unrecognized speech (retry handling)
npx tsx tests/voice-simulator.ts --scenario=unknown
```

**NOTE:** The simulator requires the server to be running. For the mock server (no DB):
```bash
# Terminal 1 — start mock server
npx tsx src/mock-server.ts

# Terminal 2 — run simulator
npx tsx tests/voice-simulator.ts --scenario=book
```

For the real server (with DB):
```bash
# Terminal 1
npx tsx src/index.ts

# Terminal 2
npx tsx tests/voice-simulator.ts --scenario=book
```

### Option 2: Manual curl Testing

```bash
# 1. Simulate incoming call
curl -X POST http://localhost:3000/twilio/voice/incoming \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_test_001&From=%2B15551234567&To=%2B15559876543&CallStatus=ringing"

# 2. Simulate speech: "I want to book an appointment"
curl -X POST http://localhost:3000/twilio/voice/continue \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_test_001&SpeechResult=I+want+to+book+an+appointment&CallStatus=in-progress"

# 3. Simulate speech: "General consultation"
curl -X POST http://localhost:3000/twilio/voice/continue \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_test_001&SpeechResult=general+consultation&CallStatus=in-progress"

# 4. Simulate speech: "Tomorrow"
curl -X POST http://localhost:3000/twilio/voice/continue \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_test_001&SpeechResult=tomorrow&CallStatus=in-progress"

# 5. Simulate speech: "The first one" (pick slot)
curl -X POST http://localhost:3000/twilio/voice/continue \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_test_001&SpeechResult=the+first+one&CallStatus=in-progress"

# 6. Simulate speech: "Alex Morrison" (name)
curl -X POST http://localhost:3000/twilio/voice/continue \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_test_001&SpeechResult=Alex+Morrison&CallStatus=in-progress"

# 7. Simulate speech: "alex at example dot com" (email)
curl -X POST http://localhost:3000/twilio/voice/continue \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_test_001&SpeechResult=alex+at+example+dot+com&CallStatus=in-progress"

# 8. Simulate speech: "Yes" (confirm booking)
curl -X POST http://localhost:3000/twilio/voice/continue \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA_test_001&SpeechResult=yes&CallStatus=in-progress"

# Debug: check active sessions
curl http://localhost:3000/twilio/voice/sessions
```

### Option 3: With Real Twilio (Production Testing)

1. Sign up at [twilio.com](https://www.twilio.com) and get a phone number
2. Install [ngrok](https://ngrok.com): `ngrok http 3000`
3. Set environment variables:
   ```bash
   TWILIO_ACCOUNT_SID="ACxxxxxxxxxx"
   TWILIO_AUTH_TOKEN="your-auth-token"
   TWILIO_PHONE_NUMBER="+1234567890"
   TWILIO_WEBHOOK_BASE_URL="https://xxxx.ngrok.io"
   ```
4. In Twilio Console → Phone Numbers → your number:
   - Voice Webhook: `https://xxxx.ngrok.io/twilio/voice/incoming` (POST)
   - Status Callback: `https://xxxx.ngrok.io/twilio/status` (POST)
5. Call your Twilio number from any phone!

---

## Voice Flow Diagrams

### Happy Path: Book Appointment

```
Caller dials in
    │
    ▼
🤖 "Welcome to [Business]! I can help you book, reschedule, or cancel."
    │
📞 "I'd like to book an appointment"
    │
    ▼
🤖 "What service are you looking for?"
    │
📞 "General consultation"
    │
    ▼
🤖 "What date would you prefer?"
    │
📞 "Tomorrow"
    │
    ▼  ← calls check_availability (same as web chat)
🤖 "Available times: 1. 9:00 AM, 2. 10:00 AM, 3. 11:30 AM. Which time?"
    │
📞 "The first one"
    │
    ▼  ← calls hold_slot (same as web chat)
🤖 "I've held that for 5 minutes. What is your full name?"
    │
📞 "Alex Morrison"
    │
    ▼
🤖 "And your email address?"
    │
📞 "alex at example dot com"
    │
    ▼
🤖 "Confirm: Alex Morrison, General Consultation on [date/time]. Shall I book?"
    │
📞 "Yes"
    │
    ▼  ← calls confirm_booking (same as web chat)
🤖 "Confirmed! Reference: A.P.T.dash.X.Y.Z.1.2.3. Have a great day!"
    │
    ▼
[Hangup]
```

### Failure Path 1: Caller Silence

```
Caller dials in
    │
    ▼
🤖 "Welcome to [Business]! ..."
    │
📞 (silence for 3 seconds)
    │
    ▼
🤖 "I didn't catch that. Welcome to..."  (retry 1)
    │
📞 (silence)
    │
    ▼
🤖 "I didn't catch that. Welcome to..."  (retry 2)
    │
📞 (silence)
    │
    ▼
🤖 "I haven't heard from you, so I'll let you go. Call back anytime. Goodbye!"
    │
    ▼
[Hangup]
```

### Failure Path 2: Slot Taken (Race Condition)

```
Caller dials in → "book" → "massage" → "tomorrow"
    │
    ▼  ← check_availability returns [9:00 AM, 10:00 AM]
🤖 "Available: 1. 9:00 AM, 2. 10:00 AM..."
    │
📞 "9 AM please"
    │
    ▼  ← hold_slot fails (another session grabbed it via web!)
🤖 "I'm sorry, that slot was just taken. Would you like to pick a different time?"
    │
📞 "10 AM then"
    │
    ▼  ← hold_slot succeeds
🤖 "Got it! What's your name?"
    │
    ... (continues normally)
```

---

## Files Created/Modified

### New Files (8)
```
src/backend/src/voice/
├── nlu.ts                    — Intent & entity extraction from speech
├── session-manager.ts        — In-memory VoiceSession store + state helpers
├── twiml-builder.ts          — TwiML XML construction (no Twilio SDK needed)
├── voice-tool-executor.ts    — Bridges voice sessions to existing backend tools
├── conversation-engine.ts    — State machine processing each speech turn
└── voice.routes.ts           — Fastify routes for Twilio webhooks

src/backend/tests/
└── voice-simulator.ts        — Local testing script

docs/
└── voice-testing-guide.md    — This file
```

### Modified Files (3)
```
src/backend/src/domain/types.ts    — Added VoiceSession, VoiceCallState, VoiceIntent
src/backend/src/config/env.ts      — Added 11 voice-related env vars
src/backend/src/index.ts           — Import formbody + voiceRoutes, register both
src/backend/package.json           — Added test:voice script
```
