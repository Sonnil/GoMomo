# Voice Channel Setup Guide

> **⚠️ BOOKING-ONLY MODE (Company PC):** Voice is currently disabled
> (`FEATURE_VOICE=false`). This guide applies only when re-enabling voice
> on a **personal machine** with Twilio credentials and a tunnel (ngrok or
> similar). See [`docs/booking-only-mode.md`](./booking-only-mode.md).

## Overview

gomomo.ai supports inbound voice calls via Twilio's native
`<Gather input="speech">` for STT and `<Say>` for TTS. No external STT/TTS
providers or Media Streams WebSocket are needed — Twilio handles all audio
encoding/decoding.

All booking operations use the **same backend tools** as web chat and SMS.
No booking logic is duplicated in the voice layer.

---

## Architecture

```
Caller → Twilio → POST /twilio/voice/incoming → Greeting TwiML (<Gather>)
                                ↕
                  POST /twilio/voice/continue ← Speech result
                                ↓
                  conversation-engine (state machine)
                                ↓
                  voice-tool-executor → executeToolCall() (shared with web chat)
                                ↓
                  TwiML response → <Say> + <Gather> or <Hangup>
```

---

## Prerequisites

1. **Twilio Account** with a phone number (local or toll-free)
2. **ngrok** or similar tunnel for local development (Twilio must reach your server)
3. Backend running with `VOICE_ENABLED=true`

---

## 1. Environment Variables

Add these to `src/backend/.env`:

```env
# Voice Channel
VOICE_ENABLED=true
VOICE_DEFAULT_TENANT_ID=00000000-0000-4000-a000-000000000001
VOICE_MAX_CALL_DURATION_MS=600000     # 10 min max per call
VOICE_MAX_TURNS=20                     # Max conversation turns
VOICE_MAX_RETRIES=3                    # Retries per step before giving up
VOICE_TTS_VOICE=Polly.Joanna          # Twilio <Say> voice
VOICE_TTS_LANGUAGE=en-US
VOICE_SPEECH_TIMEOUT=auto              # Twilio speechTimeout
VOICE_SPEECH_MODEL=phone_call          # Twilio speechModel

# CRITICAL — Set this to your publicly-reachable URL
TWILIO_WEBHOOK_BASE_URL=https://your-domain.ngrok-free.app
```

---

## 2. Twilio Console Configuration

### Phone Number → Voice Configuration

1. Go to **Twilio Console** → **Phone Numbers** → **Manage** → **Active Numbers**
2. Select your voice number (e.g., `+15738777070`)
3. Under **Voice Configuration**:

| Setting | Value |
|---------|-------|
| **A call comes in** | Webhook |
| **URL** | `https://your-domain/twilio/voice/incoming` |
| **HTTP Method** | POST |
| **Call status changes** | `https://your-domain/twilio/status` |

4. Click **Save configuration**

### Twilio Signature Validation

The webhook routes validate `X-Twilio-Signature` on every request. In development
with ngrok, ensure your `TWILIO_WEBHOOK_BASE_URL` matches the URL Twilio sees
(including the ngrok hostname).

---

## 3. Local Development with ngrok

```bash
# Start the backend
cd src/backend && npm run dev

# In another terminal, start ngrok
ngrok http 3000

# Copy the https URL and update .env:
# TWILIO_WEBHOOK_BASE_URL=https://abc123.ngrok-free.app
```

Then update your Twilio phone number's webhook URLs in the Console.

---

## 4. Webhook Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/twilio/voice/incoming` | Initial call handler — returns greeting + `<Gather>` |
| POST | `/twilio/voice/continue` | Receives each speech turn — processes via state machine |
| POST | `/twilio/status` | Call lifecycle events (completed, failed, busy, no-answer) |
| GET | `/twilio/voice/sessions` | Debug: list active sessions (dev mode only, admin key required) |

---

## 5. Call Flow

1. **Incoming call** → Twilio POSTs to `/twilio/voice/incoming`
2. **Greeting** → TwiML responds with `<Say>Welcome to…</Say>` inside `<Gather input="speech">`
3. **Caller speaks** → Twilio transcribes speech, POSTs `SpeechResult` to `/twilio/voice/continue`
4. **Conversation engine** processes the speech through a state machine:
   - `collecting_intent` → book / reschedule / cancel
   - `collecting_service` → which service
   - `collecting_date` → when
   - `offering_slots` → present available times
   - `collecting_name` / `collecting_email` → client details
   - `confirming_booking` → final confirmation
5. **Booking** → Uses the same `executeToolCall()` as web chat
6. **Completion** → `<Say>` confirmation + reference code + `<Hangup/>`

### SMS Handoff

At any point the caller can say "text me a link" and the system will:
1. Generate a handoff token
2. Send an SMS with a resume URL
3. Hang up with instructions to check their phone

---

## 6. Audit Trail

All voice events are logged to `audit_log`:

| Event | When | Payload |
|-------|------|---------|
| `voice.call_started` | Call received | `caller_masked` |
| `voice.turn_received` | Each speech turn | `turn`, `state`, `has_speech`, `is_timeout` |
| `voice.turn_responded` | After engine processes | `turn`, `new_state`, `intent` |
| `voice.call_ended` | Call completes | `outcome`, `final_state`, `total_turns`, `booking_id`, `reference_code` |

**PII Safety**: Raw speech and phone numbers are **never** logged. Phone numbers
are masked (`***4567`), speech presence is logged as boolean only.

---

## 7. Guardrails

- **Twilio signature validation** on all webhook endpoints
- **Concurrent call limit**: 5 per tenant (configurable)
- **Call duration limit**: 10 minutes (VOICE_MAX_CALL_DURATION_MS)
- **Turn limit**: 20 turns (VOICE_MAX_TURNS)
- **Retry limit**: 3 per step (VOICE_MAX_RETRIES)
- **Policy engine**: All tool calls route through `executeToolCall()` → policy engine
- **No PII in logs**: Speech content and phone numbers are masked

---

## 8. Testing

### Voice Simulator (no phone needed)

```bash
cd src/backend

# Happy path booking
npx tsx tests/voice-simulator.ts --scenario=book

# Cancel flow
npx tsx tests/voice-simulator.ts --scenario=cancel

# Silence handling
npx tsx tests/voice-simulator.ts --scenario=silence

# SMS handoff
npx tsx tests/voice-simulator.ts --scenario=handoff
```

### CEO Phone Test Script

1. Ensure ngrok is running and webhooks are configured
2. Call `+15738777070` from your phone
3. Say: "I'd like to book an appointment"
4. Follow the prompts to select a service, date, and time
5. Provide your name and email
6. Confirm the booking
7. You should receive a reference code (spelled out letter by letter)
8. Verify the booking appears in the CEO test dashboard

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "This phone line is not configured" | Tenant not found | Check `VOICE_DEFAULT_TENANT_ID` matches a seeded tenant |
| "All our lines are currently busy" | 5+ concurrent calls | Wait or increase limit |
| Twilio returns 403/11200 | Signature validation failed | Ensure `TWILIO_WEBHOOK_BASE_URL` matches exactly |
| No speech recognition | Wrong speechModel | Verify `VOICE_SPEECH_MODEL=phone_call` |
| Call drops immediately | Voice not enabled | Set `VOICE_ENABLED=true` |
| "I lost track of our conversation" | Session expired/missing | Call duration may have exceeded limit |
