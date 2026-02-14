# Phase 27 — Autonomous Workflows: Local Test Guide

## Quick Summary

| Workflow | Handler | Trigger | Tool | Policy |
|---|---|---|---|---|
| A) Hold Follow-up | `on-hold-expired` | Hold expires + session has email | `send_hold_followup` | `hold_followup` |
| B) Waitlist | `on-slot-opened` | Booking cancelled/rescheduled | `send_waitlist_notification` | `waitlist_notify` |
| C) Calendar Retry | `on-calendar-write-failed` | Google Calendar write fails | `retry_calendar_sync` / `escalate_calendar_failure` | `retry_calendar_sync` / `escalate_calendar_failure` |
| D) Reminders | `on-booking-created` | New booking confirmed | `send_reminder` (24h + 2h) | `send_reminder` |

---

## 1. Run Unit Tests (No DB Required)

```bash
cd src/backend
npx vitest run tests/workflows.test.ts
```

Expected: **13 tests passing** — covers all 4 workflows, policy gating, registered tools, and domain events.

Run full unit test suite:

```bash
npx vitest run tests/guardrails.test.ts tests/workflows.test.ts
```

Expected: **26 tests passing** (13 guardrails + 13 workflows).

---

## 2. Start Local Stack

```bash
# From project root
cd /path/to/prj-20260205-001-ai-receptionist

# Clean slate
rm -rf .pg-data
lsof -ti :3000,:5173,:5432 | xargs kill -9 2>/dev/null

# Launch (embedded PostgreSQL + Fastify + Vite)
AUTONOMY_ENABLED=true node local-start.mjs
```

Wait for:
- `✅ PostgreSQL ready on port 5432`
- `✅ Backend ready on http://localhost:3000`
- `✅ Frontend ready on http://localhost:5173`

---

## 3. Test Workflow A — Hold Expiry Follow-up

### What it does
When a user holds a slot but doesn't book, and they've given their email, the system sends "Your slot hold expired — want new options?" Subject to 30-minute cooldown.

### Step-by-step

1. **Open the chat** at `http://localhost:5173`
2. **Ask for availability**: "Do you have anything on Monday?"
3. **Hold a slot**: "Hold the 10am slot for me"
4. **Provide your email**: "My email is test@example.com" (this triggers the agent to capture it)
5. **Wait for hold to expire** (default: 5 minutes, or check `HOLD_TTL_MS` env var)
6. **Check the notification outbox**:

```bash
# In another terminal
psql "postgresql://eon:eon@localhost:5432/ai_receptionist" -c "
  SELECT id, channel, recipient, subject, status, created_at
  FROM notification_outbox
  WHERE subject LIKE '%expired%'
  ORDER BY created_at DESC
  LIMIT 5;
"
```

7. **Check the audit log**:

```bash
psql "postgresql://eon:eon@localhost:5432/ai_receptionist" -c "
  SELECT event_type, entity_type, payload, created_at
  FROM audit_log
  WHERE event_type IN ('hold.expired', 'tool.executed')
  ORDER BY created_at DESC
  LIMIT 10;
"
```

### Expected
- `notification_outbox` has a row with subject containing "hold expired"
- `audit_log` has `hold.expired` event + `tool.executed` for `send_hold_followup`
- If you trigger another expiry within 30 minutes for the same session, **no duplicate** notification (cooldown)

---

## 4. Test Workflow B — Waitlist

### What it does
When no slots are available, the agent captures preferences via `create_inquiry` (waitlist). When a slot opens (cancellation/reschedule), matching waitlist entries get notified.

### Step-by-step

1. **Open chat** → Ask for a time that's fully booked: "Do you have anything at 3pm next Monday?"
2. If the agent says nothing is available, say: "Can you put me on the waitlist? My email is waitlist@example.com, I prefer Mondays and Tuesdays, mornings"
3. The agent should call `create_inquiry` → creates a waitlist entry
4. **Verify waitlist entry**:

```bash
psql "postgresql://eon:eon@localhost:5432/ai_receptionist" -c "
  SELECT id, client_email, preferred_service, preferred_days, preferred_time_range, status
  FROM waitlist_entries
  ORDER BY created_at DESC
  LIMIT 5;
"
```

5. **Now trigger a slot opening** — in another chat session, book a Monday slot and then cancel it
6. The `SlotOpened` event fires → `on-slot-opened` handler checks waitlist

```bash
# Check if notification was queued
psql "postgresql://eon:eon@localhost:5432/ai_receptionist" -c "
  SELECT id, recipient, subject, status
  FROM notification_outbox
  WHERE subject LIKE '%waitlist%' OR subject LIKE '%slot%opened%'
  ORDER BY created_at DESC
  LIMIT 5;
"
```

7. **Check via API**:

```bash
curl -s 'http://localhost:3000/api/autonomy/waitlist?tenant_id=00000000-0000-4000-a000-000000000001' | jq
```

### Expected
- Waitlist entry created with status `waiting`
- After slot opens, waitlist entry updated to `notified`
- Notification queued in outbox

---

## 5. Test Workflow C — Calendar Write Retry

### What it does
When Google Calendar sync fails, the system retries with exponential backoff (30s → 120s → 480s). After 3 failed retries, it escalates by notifying the client.

### Step-by-step

This is hardest to trigger manually (requires a real calendar write failure). To simulate:

1. **Set up a bad calendar config** — ensure `GOOGLE_CALENDAR_ID` is set to an invalid value
2. **Book an appointment** in the chat
3. The calendar sync will fail → `CalendarWriteFailed` event fires
4. **Check retry jobs**:

```bash
psql "postgresql://eon:eon@localhost:5432/ai_receptionist" -c "
  SELECT id, type, status, payload->>'reference_code' as ref, priority,
         run_at, attempts, created_at
  FROM jobs
  WHERE type IN ('retry_calendar_sync', 'escalate_calendar_failure')
  ORDER BY created_at DESC
  LIMIT 10;
"
```

5. **Check backoff timing**: each retry should be further out:
   - Retry 1: ~30s after failure
   - Retry 2: ~120s after failure
   - Retry 3: ~480s after failure

6. **After 3 failures**, check for escalation:

```bash
psql "postgresql://eon:eon@localhost:5432/ai_receptionist" -c "
  SELECT event_type, payload
  FROM audit_log
  WHERE event_type = 'calendar.retry_exhausted'
  ORDER BY created_at DESC
  LIMIT 5;
"
```

### Expected
- 3 `retry_calendar_sync` jobs with increasing `run_at` values
- After exhaustion: 1 `escalate_calendar_failure` job
- Audit log shows `calendar.retry_exhausted` event

---

## 6. Test Workflow D — Reminders (24h + 2h)

### What it does
For every confirmed booking, the system schedules two reminders: 24 hours before and 2 hours before.

### Step-by-step

1. **Book an appointment** far enough in the future (at least 2 days out)
2. **Check the jobs table**:

```bash
psql "postgresql://eon:eon@localhost:5432/ai_receptionist" -c "
  SELECT id, type, payload->>'reminder_type' as reminder_type,
         payload->>'reference_code' as ref,
         run_at, priority, status
  FROM jobs
  WHERE type IN ('send_confirmation', 'send_reminder')
  ORDER BY created_at DESC
  LIMIT 10;
"
```

### Expected
Three jobs created for each booking:
| Type | Reminder Type | Priority | Run At |
|---|---|---|---|
| `send_confirmation` | — | 10 | immediately |
| `send_reminder` | `24h` | 5 | start_time - 24h |
| `send_reminder` | `2h` | 7 | start_time - 2h |

---

## 7. Verify GUI Indicators

1. Open `http://localhost:5173`
2. Click **"⚡ Autonomy: ON"** in the header (ensure `AUTONOMY_ENABLED=true`)
3. After triggering workflows above, the session banner should show:
   - **📋 Waitlist: N** — count of active waitlist entries
   - **⏳ Pending: N** — count of pending/claimed jobs
4. Quick action "📝 Join waitlist" should be visible

---

## 8. Test Policy Gating

Policies can block workflows. To test:

1. **Disable a workflow policy** (e.g., hold follow-up):

```bash
curl -X PATCH 'http://localhost:3000/api/autonomy/policies' \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"00000000-0000-4000-a000-000000000001","action":"hold_followup","effect":"deny"}'
```

2. **Trigger the workflow** (let a hold expire with email captured)
3. **Verify no notification was sent**:

```bash
psql "postgresql://eon:eon@localhost:5432/ai_receptionist" -c "
  SELECT event_type, payload
  FROM audit_log
  WHERE event_type = 'policy.evaluated'
    AND payload->>'action' = 'hold_followup'
  ORDER BY created_at DESC
  LIMIT 5;
"
```

4. **Re-enable**:

```bash
curl -X PATCH 'http://localhost:3000/api/autonomy/policies' \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":"00000000-0000-4000-a000-000000000001","action":"hold_followup","effect":"allow"}'
```

### Expected
- When policy is `deny`, no job is created (audit shows `effect: deny`)
- When policy is `allow`, job is created normally

---

## 9. Workflow Activity API

```bash
curl -s 'http://localhost:3000/api/autonomy/workflows?tenant_id=00000000-0000-4000-a000-000000000001' | jq
```

Returns:
```json
{
  "waitlist_count": 2,
  "pending_jobs": 5,
  "recent_events": [...]
}
```

---

## Files Modified in Phase 27

| File | Change |
|---|---|
| `db/migrations/005_workflows.sql` | NEW — waitlist_entries table |
| `domain/events.ts` | Added SlotOpened, CalendarRetryExhausted events |
| `domain/types.ts` | Added WaitlistStatus, WaitlistEntry |
| `repos/waitlist.repo.ts` | NEW — CRUD for waitlist |
| `orchestrator/handlers/on-hold-expired.ts` | Rewritten — Workflow A |
| `orchestrator/handlers/on-slot-opened.ts` | NEW — Workflow B |
| `orchestrator/handlers/on-calendar-write-failed.ts` | Rewritten — exponential backoff |
| `orchestrator/handlers/on-calendar-retry-exhausted.ts` | NEW — Workflow C escalation |
| `orchestrator/handlers/on-booking-created.ts` | Enhanced — 2h reminder |
| `orchestrator/registered-tools.ts` | 3 new tools |
| `orchestrator/orchestrator.ts` | Wired new handlers |
| `services/booking.service.ts` | SlotOpened emission |
| `index.ts` | HoldExpired enriched with session_id |
| `agent/tools.ts` | create_inquiry tool |
| `agent/tool-executor.ts` | create_inquiry handler |
| `agent/chat-handler.ts` | Client info capture |
| `agent/system-prompt.ts` | Waitlist flow in instructions |
| `db/seed.ts` | 3 new policy rules |
| `routes/autonomy.routes.ts` | 2 new endpoints |
| `frontend/DemoChatWidget.tsx` | Workflow indicators + waitlist quick action |
| `tests/workflows.test.ts` | NEW — 13 tests |
| `PHASE-27-TEST.md` | NEW — this file |
