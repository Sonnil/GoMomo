# Feature 3 — Proactive Push in the Web UI

## Test Script (GUI-Only)

**Pre-requisites:**
```bash
# Terminal 1: Start database
docker compose up -d postgres

# Terminal 2: Start backend
cd src/backend && npm run dev

# Terminal 3: Start frontend
cd src/frontend && npm run dev
```

Ensure `.env` has:
```
AUTONOMY_ENABLED=true
CALENDAR_MODE=mock
DEMO_AVAILABILITY=true
```

---

## Scenario A: Waitlist Match → Proactive Push

**Goal:** When a waitlisted user is in the chat and a matching slot opens, a proactive message with a clickable slot button appears in the chat thread.

### Steps

1. **Open the chat UI** at `http://localhost:5173`
2. **Verify session banner** shows `Autonomy: ON` (green)
3. **Join the waitlist:**
   - Click the `📝 Join waitlist` quick action chip
   - Follow the prompts: provide name, email, preferred service, and day/time
   - Verify the bot confirms: "You've been added to the waitlist"
4. **Note the session ID** from the top banner (e.g., `a1b2c3d4e5f6…`)
5. **Trigger a slot opening** — in a second terminal:
   ```bash
   # Book an appointment, then cancel it to trigger SlotOpened
   curl -X POST http://localhost:3000/api/tenants/00000000-0000-4000-a000-000000000001/appointments \
     -H 'Content-Type: application/json' \
     -d '{
       "session_id": "trigger-session",
       "client_name": "Trigger User",
       "client_email": "trigger@test.com",
       "service": "Deep Tissue Massage",
       "start_time": "<PICK A SLOT MATCHING YOUR WAITLIST PREFS>",
       "end_time": "<END TIME>",
       "timezone": "America/New_York"
     }'

   # Note the appointment ID from the response, then cancel:
   curl -X PATCH http://localhost:3000/api/tenants/00000000-0000-4000-a000-000000000001/appointments/<APT_ID> \
     -H 'Content-Type: application/json' \
     -d '{"status": "cancelled"}'
   ```
6. **Watch the chat UI** — within a few seconds you should see:
   - ✅ A **proactive push message** from the assistant: "Good news — I found a new opening! [Day, Time – Time] …"
   - ✅ A **green PushSlotCard** with a clickable `📅` slot button
   - ✅ A **toast notification**: "Slot Available!"
7. **Click the slot button** — verify it sends a user message like "I'd like to book the [time] slot for [service]"
8. **Continue the booking flow** — the bot should process the booking request

### Expected Backend Logs
```
[on-slot-opened] Found 1 waitlist match(es) for slot …
[push-service] Push emitted: type=waitlist_match session=a1b2c3d4… id=…
```

---

## Scenario B: Calendar Retry Success → Proactive Push

**Goal:** When a calendar write fails and the retry succeeds, the user sees a confirmation push in the chat.

### Steps

1. **Open the chat UI** and book an appointment normally
2. **Verify** the booking is confirmed in the chat
3. **Simulate a calendar write failure** — This scenario is harder to trigger in GUI-only mode because the mock calendar always succeeds. To test:

   **Option 1: Modify the mock calendar temporarily**
   - In `src/backend/src/integrations/calendar/mock-calendar.ts`, make `createEvent()` throw on the first call, then succeed on retry
   - Restart the backend

   **Option 2: Use the autonomy dashboard**
   - Check `http://localhost:3000/api/autonomy/workflows?tenant_id=00000000-0000-4000-a000-000000000001`
   - Look for `retry_calendar_sync` jobs

4. **When the retry succeeds**, the chat should show:
   - ✅ A push message: "Your booking is now confirmed! Ref: APT-XXXX — [Day, Time] …"
   - ✅ A **confirmation card** with the reference code
   - ✅ A **toast**: "Booking Confirmed"

---

## Scenario C: REST Polling Fallback

**Goal:** Verify push events are available via REST for clients not using WebSocket.

### Steps

1. **Complete Scenario A** so at least one push event exists
2. **Query the REST endpoint:**
   ```bash
   curl http://localhost:3000/api/sessions/<SESSION_ID>/push-events
   ```
3. **Expected response:**
   ```json
   {
     "session_id": "<SESSION_ID>",
     "events": [
       {
         "id": "...",
         "type": "waitlist_match",
         "payload": {
           "type": "waitlist_match",
           "slots": [{ "start": "...", "end": "...", "display_time": "...", "service": "..." }],
           "service": "...",
           "message": "Good news — I found a new opening! ..."
         },
         "created_at": "..."
       }
     ]
   }
   ```
4. **Query again** — events should now show `[]` (already delivered)

---

## Scenario D: Cooldown Guard

**Goal:** Verify that duplicate pushes within 60 seconds are suppressed.

### Steps

1. **Trigger two cancellations in rapid succession** for the same service
2. The first should generate a push. The second should be suppressed.
3. **Check backend logs** for:
   ```
   [push-service] Cooldown active for session=... type=waitlist_match — skipping
   ```

---

## Scenario E: Reconnection Delivery

**Goal:** Pushes that arrive while the client is disconnected are delivered on reconnect.

### Steps

1. **Join the waitlist** in the chat
2. **Disconnect** by stopping the frontend or closing the tab
3. **Trigger a slot opening** (Scenario A step 5)
4. **Reconnect** by reopening the chat
5. **Verify** the pending push is delivered immediately on reconnect
6. **Check backend logs** for:
   ```
   [push-service] Delivered 1 pending push(es) to session=...
   ```

---

## Guardrails Checklist

| # | Guardrail | How to verify |
|---|-----------|---------------|
| 1 | Never push without backend-confirmed availability | Only `send_waitlist_notification` (after policy check) triggers a push |
| 2 | Respect cooldown policy | Rapid duplicate pushes are suppressed (Scenario D) |
| 3 | PII redaction in audit logs | Check `audit_log` table — push entries should have redacted client fields |
| 4 | Session-safe delivery | Push only goes to the correct session (Scenario A step 6) |
| 5 | Tenant-safe delivery | Events are scoped by tenant_id in the DB |

---

## Quick Verification Commands

```bash
# Check push_events table
psql $DATABASE_URL -c "SELECT id, session_id, type, delivered, created_at FROM push_events ORDER BY created_at DESC LIMIT 10;"

# Check audit log for push events
psql $DATABASE_URL -c "SELECT event_type, entity_type, payload FROM audit_log WHERE event_type LIKE 'push.%' ORDER BY created_at DESC LIMIT 5;"

# Check autonomy dashboard
curl http://localhost:3000/api/autonomy/status | jq .
```
