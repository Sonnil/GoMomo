# Failure Simulation — Local Testing Guide

> Test that gomomo.ai behaves safely when external systems
> fail. Covers calendar auth errors, network failures, and timeouts.

---

## What Was Added

### New Environment Variables

| Variable | Values | Default | Purpose |
|---|---|---|---|
| `CALENDAR_FAIL_MODE` | `none`, `auth_error`, `network_error`, `timeout`, `all_ops_fail` | `none` | Tells the mock calendar provider which failure to simulate |
| `CALENDAR_SYNC_REQUIRED` | `true`, `false` | `false` | When `true`, a calendar failure **rolls back** the booking |

### Behavioral Modes

| CALENDAR_SYNC_REQUIRED | Calendar Fails | Result |
|---|---|---|
| `false` (default) | Yes | ⚠️ Booking **still succeeds** — calendar sync is best-effort. `google_event_id` will be `null`. |
| `true` | Yes | 🚫 Booking is **rolled back** — appointment cancelled, hold restored, agent tells user to retry. |
| `false` | No | ✅ Normal — booking succeeds with calendar event. |
| `true` | No | ✅ Normal — booking succeeds with calendar event. |

### Failure Types

| `CALENDAR_FAIL_MODE` | Simulates | Error Shape |
|---|---|---|
| `auth_error` | Invalid/expired OAuth token | `401 Invalid Credentials` |
| `network_error` | Google API unreachable | `ECONNREFUSED 142.250.80.106:443` |
| `timeout` | Network timeout (5s delay) | `ETIMEDOUT googleapis.com` |
| `all_ops_fail` | Both createEvent AND deleteEvent fail | Same as `auth_error`, but also breaks cancel/reschedule calendar sync |

---

## Prerequisites

```bash
cd /Users/leso01/Documents/AI_Team/EON/projects/prj-20260205-001-ai-receptionist

# Stack running with seed data
docker compose up --build -d
docker compose exec backend npx tsx src/db/seed.ts

# Verify
curl -s http://localhost:3000/health | jq .status  # "ok"
```

---

## Test 1 — Lenient Mode (default): Calendar Fails but Booking Succeeds

This is the default behavior. The booking goes through even when
the calendar API is broken.

### Step 1: Start with calendar failure enabled

```bash
# Stop and restart with failure simulation
CALENDAR_FAIL_MODE=auth_error docker compose up -d backend
```

Or without restarting (edit `.env` in project root):
```bash
echo "CALENDAR_FAIL_MODE=auth_error" >> .env
docker compose up -d backend
```

### Step 2: Create a booking via curl

```bash
TENANT_ID="00000000-0000-4000-a000-000000000001"
BASE="http://localhost:3000"
SESSION_ID="fail-test-$(date +%s)"

# Get tomorrow's date
TOMORROW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d "+1 day" +%Y-%m-%d)

# Find a slot
SLOT_START=$(curl -s "$BASE/api/tenants/$TENANT_ID/availability?start=${TOMORROW}T00:00:00&end=${TOMORROW}T23:59:59" \
  | jq -r '[.slots[] | select(.available==true)] | .[0].start')
SLOT_END=$(curl -s "$BASE/api/tenants/$TENANT_ID/availability?start=${TOMORROW}T00:00:00&end=${TOMORROW}T23:59:59" \
  | jq -r '[.slots[] | select(.available==true)] | .[0].end')

# Hold the slot
HOLD_ID=$(curl -s -X POST "$BASE/api/tenants/$TENANT_ID/holds" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SESSION_ID\",\"start_time\":\"$SLOT_START\",\"end_time\":\"$SLOT_END\"}" \
  | jq -r '.id')
echo "Hold: $HOLD_ID"

# Confirm booking (calendar will fail)
RESULT=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/tenants/$TENANT_ID/appointments" \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\":\"$SESSION_ID\",
    \"hold_id\":\"$HOLD_ID\",
    \"client_name\":\"Calendar Fail Test\",
    \"client_email\":\"fail-test@example.com\",
    \"service\":\"Follow-up Visit\"
  }")

echo "$RESULT"
```

### Expected (lenient mode):

```
HTTP 201 — booking STILL succeeds
```
```json
{
  "status": "confirmed",
  "google_event_id": null,
  "reference_code": "APT-XXXX"
}
```

### Step 3: Check the logs

```bash
docker compose logs backend --tail=20 | grep -E "\[mock-calendar\]|Calendar event creation failed"
```

**Expected:**
```
[mock-calendar] ⚡ FAILURE SIMULATION: auth_error on createEvent
Calendar event creation failed (booking still confirmed): MockCalendarAuthError: Request had invalid authentication credentials…
```

✅ **Pass:** Booking confirmed, calendar error logged, `google_event_id` is `null`.

### Step 4: Clean up

```bash
# Reset to normal
CALENDAR_FAIL_MODE=none docker compose up -d backend
```

---

## Test 2 — Strict Mode: Calendar Fails → Booking Rolled Back

This simulates a tenant where calendar sync is mandatory (e.g., a clinic
that requires every appointment to appear on the shared calendar).

### Step 1: Enable strict mode + failure

```bash
CALENDAR_FAIL_MODE=auth_error CALENDAR_SYNC_REQUIRED=true docker compose up -d backend
```

### Step 2: Try to book

```bash
TENANT_ID="00000000-0000-4000-a000-000000000001"
BASE="http://localhost:3000"
SESSION_ID="strict-fail-$(date +%s)"

TOMORROW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d "+1 day" +%Y-%m-%d)

SLOT_START=$(curl -s "$BASE/api/tenants/$TENANT_ID/availability?start=${TOMORROW}T00:00:00&end=${TOMORROW}T23:59:59" \
  | jq -r '[.slots[] | select(.available==true)] | .[0].start')
SLOT_END=$(curl -s "$BASE/api/tenants/$TENANT_ID/availability?start=${TOMORROW}T00:00:00&end=${TOMORROW}T23:59:59" \
  | jq -r '[.slots[] | select(.available==true)] | .[0].end')

# Hold the slot
HOLD_ID=$(curl -s -X POST "$BASE/api/tenants/$TENANT_ID/holds" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SESSION_ID\",\"start_time\":\"$SLOT_START\",\"end_time\":\"$SLOT_END\"}" \
  | jq -r '.id')
echo "Hold: $HOLD_ID"

# Confirm booking (should FAIL in strict mode)
curl -s -X POST "$BASE/api/tenants/$TENANT_ID/appointments" \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\":\"$SESSION_ID\",
    \"hold_id\":\"$HOLD_ID\",
    \"client_name\":\"Strict Fail Test\",
    \"client_email\":\"strict-fail@example.com\",
    \"service\":\"Follow-up Visit\"
  }" | jq .
```

### Expected (strict mode):

```
HTTP 409
```
```json
{
  "error": "Unable to sync with the calendar system. The booking has been rolled back. Please try again in a moment, or contact the office directly."
}
```

### Step 3: Verify the rollback

**a) Appointment was cancelled:**
```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT reference_code, status, google_event_id
  FROM appointments
  WHERE client_email = 'strict-fail@example.com'
  ORDER BY created_at DESC LIMIT 1;
"
```

**Expected:**
```
 reference_code | status    | google_event_id
----------------+-----------+-----------------
 APT-XXXX       | cancelled | (null)
```

**b) Hold was restored:**
```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT id, session_id, start_time, expires_at > NOW() AS still_active
  FROM availability_holds
  WHERE session_id LIKE 'strict-fail-%'
  ORDER BY created_at DESC LIMIT 1;
"
```

**Expected:**
```
 id  | session_id       | start_time          | still_active
-----+------------------+---------------------+--------------
 ... | strict-fail-...  | 2026-02-07 14:00:00 | t
```

The hold is restored so the slot isn't permanently lost. The user can retry.

**c) Slot is still available:**
```bash
curl -s "$BASE/api/tenants/$TENANT_ID/availability?start=${TOMORROW}T00:00:00&end=${TOMORROW}T23:59:59" \
  | jq "[.slots[] | select(.start == \"$SLOT_START\")] | .[0].available"
```

**Expected:** `false` (held by the restored hold, which will expire in 5 min).

**d) Audit trail shows the rollback:**
```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT event_type, payload->>'reason' AS reason
  FROM audit_log
  WHERE event_type = 'appointment.calendar_rollback'
  ORDER BY created_at DESC LIMIT 1;
"
```

**Expected:**
```
         event_type                |              reason
-----------------------------------+------------------------------------
 appointment.calendar_rollback     | MockCalendarAuthError: Request had invalid authentication…
```

### Step 4: Check backend logs

```bash
docker compose logs backend --tail=30 | grep -E "FAILURE SIMULATION|rolling back|CALENDAR_SYNC_REQUIRED"
```

**Expected:**
```
[mock-calendar] ⚡ FAILURE SIMULATION: auth_error on createEvent
🚨 Calendar sync FAILED and CALENDAR_SYNC_REQUIRED=true — rolling back booking: MockCalendarAuthError: …
```

---

## Test 3 — Network Error Simulation

```bash
CALENDAR_FAIL_MODE=network_error CALENDAR_SYNC_REQUIRED=true docker compose up -d backend
```

Repeat the booking flow from Test 2. Expected:

```json
{
  "error": "Unable to sync with the calendar system. The booking has been rolled back. Please try again in a moment, or contact the office directly."
}
```

**Backend logs:**
```
[mock-calendar] ⚡ FAILURE SIMULATION: network_error on createEvent
🚨 Calendar sync FAILED and CALENDAR_SYNC_REQUIRED=true — rolling back booking: MockCalendarNetworkError: connect ECONNREFUSED…
```

---

## Test 4 — Timeout Simulation

```bash
CALENDAR_FAIL_MODE=timeout CALENDAR_SYNC_REQUIRED=true docker compose up -d backend
```

> ⏱️ **Note:** This test takes ~5 seconds per booking attempt (simulated network timeout).

Repeat the booking flow. The `confirm_booking` call will hang for 5 seconds then return:

```json
{
  "error": "Unable to sync with the calendar system. The booking has been rolled back. Please try again in a moment, or contact the office directly."
}
```

---

## Test 5 — Chat Agent Behavior (Web UI)

### Step 1: Enable strict failure mode

```bash
CALENDAR_FAIL_MODE=auth_error CALENDAR_SYNC_REQUIRED=true docker compose up -d backend
```

### Step 2: Open the chat widget

1. Go to `http://localhost:5173`
2. Enter tenant ID: `00000000-0000-4000-a000-000000000001`
3. Say: **"I'd like to book a follow-up visit for tomorrow"**

### Step 3: Complete the booking flow

Follow the agent's prompts through service → date → time → name → email → confirm.

### Step 4: Observe the failure

After you confirm, the agent should respond with something like:

> *"I'm sorry, I wasn't able to complete the booking due to a system issue. The time slot has been preserved for you — would you like to try again, or would you prefer to leave your contact details so the office can reach out?"*

The exact wording depends on the LLM, but the key is:
- ✅ The agent does **NOT** fabricate a confirmation
- ✅ The agent communicates the failure honestly
- ✅ The agent suggests alternatives (retry or leave a message)

This behavior comes from:
1. `booking.service.ts` throwing `BookingError` in strict mode
2. `tool-executor.ts` catching it and returning `{ success: false, error: "..." }`
3. The system prompt rule: *"If a tool call fails, inform the user honestly and suggest alternatives"*

---

## Test 6 — Verify Recovery After Fix

### Step 1: "Fix" the calendar (disable failure)

```bash
CALENDAR_FAIL_MODE=none CALENDAR_SYNC_REQUIRED=true docker compose up -d backend
```

### Step 2: Retry the booking

Use the same chat session or fresh curl commands. The booking should now succeed:

```json
{
  "status": "confirmed",
  "google_event_id": "mock-event-N-...",
  "reference_code": "APT-XXXX"
}
```

✅ **Pass:** System recovers cleanly when the calendar comes back online.

---

## All Failure Modes Reference

| `CALENDAR_FAIL_MODE` | `CALENDAR_SYNC_REQUIRED` | HTTP Result | Appointment Status | Hold Status | Agent Says |
|---|---|---|---|---|---|
| `none` | `false` | 201 ✅ | `confirmed` | deleted | "Your appointment is confirmed!" |
| `none` | `true` | 201 ✅ | `confirmed` | deleted | "Your appointment is confirmed!" |
| `auth_error` | `false` | 201 ⚠️ | `confirmed` (no cal event) | deleted | "Your appointment is confirmed!" (but `google_event_id` = null) |
| `auth_error` | `true` | 409 🚫 | `cancelled` (rolled back) | restored | "Unable to complete booking…" |
| `network_error` | `false` | 201 ⚠️ | `confirmed` (no cal event) | deleted | "Your appointment is confirmed!" |
| `network_error` | `true` | 409 🚫 | `cancelled` (rolled back) | restored | "Unable to complete booking…" |
| `timeout` | `false` | 201 ⚠️ (slow) | `confirmed` (no cal event) | deleted | "Your appointment is confirmed!" |
| `timeout` | `true` | 409 🚫 (5s delay) | `cancelled` (rolled back) | restored | "Unable to complete booking…" |
| `all_ops_fail` | `true` | 409 🚫 | `cancelled` (rolled back) | restored | "Unable to complete booking…" |

---

## SQL Verification Queries

### Rolled-back appointments (strict mode failures)

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT a.reference_code, a.status, a.google_event_id,
         al.event_type, al.payload->>'reason' AS failure_reason
  FROM appointments a
  JOIN audit_log al ON al.entity_id = a.id::text
                   AND al.event_type = 'appointment.calendar_rollback'
  WHERE a.tenant_id = '00000000-0000-4000-a000-000000000001'
  ORDER BY a.created_at DESC;
"
```

### Orphan check — no confirmed bookings without calendar events (strict mode)

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT reference_code, client_name, status, google_event_id
  FROM appointments
  WHERE status = 'confirmed'
    AND google_event_id IS NULL
    AND tenant_id = '00000000-0000-4000-a000-000000000001'
  ORDER BY created_at DESC;
"
```

In strict mode, this should return **0 rows** (all confirmed bookings
have a calendar event, and failed ones were rolled back).

In lenient mode, rows here are expected (calendar failed but booking went through).

---

## Automated Script

```bash
bash tests/failure-simulation.sh
```

Runs all failure modes programmatically with pass/fail assertions.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Booking succeeds despite failure | `CALENDAR_SYNC_REQUIRED` is `false` (default) | Set to `true` |
| No failure simulation logs | `CALENDAR_FAIL_MODE=none` | Set to `auth_error`, `network_error`, or `timeout` |
| `CALENDAR_MODE=real` ignores FAIL_MODE | Fail simulation only works in mock mode | Set `CALENDAR_MODE=mock` |
| Hold not restored after rollback | EXCLUDE constraint blocked re-creation | The cancelled appointment still occupies the slot — wait for it or manually delete |
| Env changes not taking effect | Docker Compose caches env | `docker compose up -d --force-recreate backend` |
