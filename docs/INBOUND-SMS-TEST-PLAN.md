# Inbound SMS Channel — Test Plan

> **⚠️ BOOKING-ONLY MODE (Company PC):** SMS is currently disabled
> (`FEATURE_SMS=false`). Inbound SMS testing requires Twilio + ngrok on a
> **personal machine** only. See [`docs/booking-only-mode.md`](./booking-only-mode.md).

## Overview

This document covers manual testing for the **Inbound SMS as First-Class Channel** feature.
The feature adds full two-way conversational SMS (book, reschedule, cancel) using the same
chat handler as web chat, plus carrier-compliant STOP/opt-out handling and DB-backed rate limits.

---

## Prerequisites

1. Backend running: `npm run dev` from `src/backend`
2. Database migrated (migration 008 runs automatically on startup)
3. `SMS_INBOUND_ENABLED=true` in `.env` (default)
4. Twilio credentials optional for local testing (signature validation skipped in dev mode)

---

## Part A — curl Tests (Local, No Twilio)

All tests hit `POST /twilio/sms/incoming` which accepts `application/x-www-form-urlencoded`
(Twilio's format). In dev mode, signature validation is skipped.

### A.1 Basic SMS Conversation — New Session

```bash
# First message from a new phone number
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM001&From=+15551110001&To=+15559990001&Body=Hi, I'd like to book an appointment" \
  | xmllint --format -
```

**Expected:** TwiML `<Response><Message>...</Message></Response>` with a greeting asking about
service/date preferences. The response should come from the AI receptionist.

### A.2 Multi-Turn SMS Booking

```bash
# Turn 2 — ask for availability
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM002&From=+15551110001&To=+15559990001&Body=Tomorrow afternoon please" \
  | xmllint --format -

# Turn 3 — select a time (depends on availability response)
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM003&From=+15551110001&To=+15559990001&Body=2 PM works" \
  | xmllint --format -

# Turn 4 — provide name and email
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM004&From=+15551110001&To=+15559990001&Body=John Smith, john@example.com" \
  | xmllint --format -
```

**Expected:** Each response should be a concise SMS-style reply. The booking flow should
mirror web chat (check availability → hold → confirm), but with shorter messages.

### A.3 Session Persistence (Resume)

```bash
# Same phone, later message — should resume the existing session
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM010&From=+15551110001&To=+15559990001&Body=Can I reschedule?" \
  | xmllint --format -
```

**Expected:** The agent should recognize the caller's context from the previous session.

### A.4 STOP — Opt-Out

```bash
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM020&From=+15551110001&To=+15559990001&Body=STOP" \
  | xmllint --format -
```

**Expected:**
```xml
<Response>
  <Message>You have been unsubscribed and will no longer receive text messages from us. Reply START to re-subscribe.</Message>
</Response>
```

### A.5 Message After Opt-Out (Blocked)

```bash
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM021&From=+15551110001&To=+15559990001&Body=Hello again" \
  | xmllint --format -
```

**Expected:** Empty TwiML response `<Response></Response>` — the opted-out phone is silently ignored.

### A.6 START — Opt Back In

```bash
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM022&From=+15551110001&To=+15559990001&Body=START" \
  | xmllint --format -
```

**Expected:**
```xml
<Response>
  <Message>You have been re-subscribed! You can now text us to book, reschedule, or cancel appointments. Reply STOP at any time to unsubscribe.</Message>
</Response>
```

### A.7 STOP Keyword Variations

```bash
for keyword in "stop" "UNSUBSCRIBE" "Cancel" "END" "quit"; do
  echo "--- Testing: $keyword ---"
  curl -s -X POST http://localhost:3000/twilio/sms/incoming \
    -d "MessageSid=SMvar&From=+15552220001&To=+15559990001&Body=$keyword" \
    | xmllint --format -
  # Re-subscribe after each test
  curl -s -X POST http://localhost:3000/twilio/sms/incoming \
    -d "MessageSid=SMvar&From=+15552220001&To=+15559990001&Body=START" > /dev/null
done
```

**Expected:** All 5 keywords trigger the unsubscribe confirmation.

### A.8 Non-STOP Messages With STOP Substring

```bash
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM030&From=+15553330001&To=+15559990001&Body=Please stop the appointment" \
  | xmllint --format -
```

**Expected:** This should NOT trigger opt-out (it's not the exact keyword). The message
should be processed normally by the chat handler.

### A.9 Empty Body

```bash
curl -s -X POST http://localhost:3000/twilio/sms/incoming \
  -d "MessageSid=SM040&From=+15554440001&To=+15559990001&Body=" \
  | xmllint --format -
```

**Expected:** Empty TwiML `<Response></Response>` — empty messages are ignored.

### A.10 Debug Endpoints (Dev Only)

```bash
# List all SMS sessions
curl -s http://localhost:3000/twilio/sms/sessions | jq .

# List all opt-outs
curl -s http://localhost:3000/twilio/sms/opt-outs | jq .
```

**Expected:** JSON arrays with session/opt-out records from previous tests.

### A.11 Verify Audit Trail

```bash
# Check audit_log for SMS events
curl -s http://localhost:3000/twilio/sms/sessions | jq '.[0].session_id' -r | xargs -I{} echo "Session: {}"
# Audit events should include sms.inbound, sms.outbound, sms.opt_out, sms.opt_in
```

---

## Part B — GUI / Integration Tests

These require a Twilio account with a real phone number configured to forward to your
ngrok/tunnel URL.

### B.1 Setup

1. Start backend with Twilio credentials in `.env`
2. Run ngrok: `ngrok http 3000`
3. Configure Twilio phone number webhook:
   - **Messaging → A message comes in**: `https://<ngrok>.ngrok-free.app/twilio/sms/incoming` (POST)

### B.2 Real SMS Booking Flow

1. Text "Hi, I'd like to book" to the Twilio number from your personal phone
2. Follow the booking flow via text:
   - Service selection
   - Date/time preference
   - Name and email
3. **Verify:** You receive a confirmation with reference code, date, time
4. **Verify:** Messages are concise (SMS-appropriate length)

### B.3 Real STOP/START

1. Text "STOP" to the Twilio number
2. **Verify:** You receive the unsubscribe confirmation
3. Text "Hello" — **Verify:** No response (opted out)
4. Text "START" — **Verify:** Re-subscribe confirmation
5. Text "Hi" — **Verify:** Normal response resumes

### B.4 Web Chat Symmetry

1. Open the web chat widget in a browser
2. Book an appointment via web chat
3. Open a different browser/phone and book via SMS
4. **Verify:** Both bookings appear in the database
5. **Verify:** Both use the same agent tools and booking flow

### B.5 Session Persistence Over Time

1. Text "I want to book a consultation" → receive response
2. Wait 5+ minutes
3. Text "Tomorrow at 10 AM" → **Verify:** The agent remembers the context

### B.6 Multiple Phone Numbers (Different Sessions)

1. From phone A: Text "Book a consultation"
2. From phone B: Text "Book a haircut"
3. **Verify:** Each phone has its own independent session
4. Continue conversations on each phone — contexts should not cross

---

## Part C — Rate Limit Testing

### C.1 DB-Backed Rate Limit

```bash
# Send more messages than the rate limit allows (default: 3 per 60 min)
for i in $(seq 1 5); do
  echo "--- Message $i ---"
  curl -s -X POST http://localhost:3000/twilio/sms/incoming \
    -d "MessageSid=SMRL$i&From=+15555550099&To=+15559990001&Body=Message $i" \
    | xmllint --format -
done
```

**Expected:** First 3 messages get normal responses. Messages 4+ get:
```xml
<Response>
  <Message>You've sent too many messages. Please wait a bit and try again, or visit our website to book online.</Message>
</Response>
```

### C.2 Rate Limit Survives Restart

1. Send messages to trigger rate limiting
2. Restart the backend (`Ctrl+C` → `npm run dev`)
3. Send another message from the same number
4. **Verify:** Still rate-limited (DB persists across restarts)

---

## Part D — Automated Test Suite

```bash
cd src/backend
npx vitest run tests/inbound-sms.test.ts
```

**Expected:** 53/53 tests pass, covering:
- STOP/START keyword detection (19 tests)
- Deterministic session ID generation (3 tests)
- Opt-out repo SQL verification (5 tests)
- Rate limit repo SQL verification (5 tests)
- SmsSendResult interface (1 test)
- Message splitting logic (5 tests)
- XML escaping (2 tests)
- System prompt SMS section (1 test)
- E.164 phone validation (10 tests)
- ENV toggle existence (1 test)
- Migration 008 schema (1 test)

### Full Suite Regression

```bash
npx vitest run
```

**Expected:** 118/118 tests pass (53 new + 65 existing).

---

## Files Changed

| File | Change |
|------|--------|
| `src/backend/src/db/migrations/008_inbound_sms.sql` | NEW — sms_opt_outs, sms_rate_limits, sms_phone_sessions tables |
| `src/backend/src/repos/sms-opt-out.repo.ts` | NEW — opt-out/opt-in CRUD |
| `src/backend/src/repos/sms-rate-limit.repo.ts` | NEW — DB-backed sliding window rate limits |
| `src/backend/src/voice/sms-session-resolver.ts` | NEW — phone → tenant → session mapping |
| `src/backend/src/voice/inbound-sms.routes.ts` | NEW — POST /twilio/sms/incoming + debug endpoints |
| `src/backend/src/voice/sms-sender.ts` | MODIFIED — opt-out guard, DB rate limits, `optedOut` field |
| `src/backend/src/config/env.ts` | MODIFIED — added SMS_INBOUND_ENABLED toggle |
| `src/backend/src/index.ts` | MODIFIED — wire inboundSmsRoutes |
| `src/backend/src/agent/system-prompt.ts` | MODIFIED — SMS CHANNEL BEHAVIOR section |
| `src/backend/tests/inbound-sms.test.ts` | NEW — 53 tests |
