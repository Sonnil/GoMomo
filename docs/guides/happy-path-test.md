# Local Happy-Path Test

> End-to-end walkthrough: start the stack → book an appointment via curl →
> verify the database and calendar state. Takes ~5 minutes.

---

## Prerequisites

| Requirement | Check |
|---|---|
| Docker Desktop running | `docker compose version` |
| `.env` file exists with `OPENAI_API_KEY` | `cat .env` |
| No other services on ports 3000 / 5173 / 5432 | `lsof -i :3000 :5173 :5432` |

---

## Part 1 — Start Services

### Step 1: Clean start

```bash
cd /Users/leso01/Documents/AI_Team/EON/projects/prj-20260205-001-ai-receptionist

# Wipe old data for a clean test
docker compose down -v

# Build & start everything
docker compose up --build -d
```

### Step 2: Wait for healthy

```bash
# Watch until all 3 services are "Up" / "healthy"
docker compose ps
```

**Expected output:**
```
NAME        SERVICE    STATUS
postgres    postgres   Up (healthy)
backend     backend    Up
frontend    frontend   Up
```

### Step 3: Verify health check

```bash
curl -s http://localhost:3000/health | jq .
```

**Expected:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-06T..."
}
```

### Step 4: Seed demo data

```bash
docker compose exec backend npx tsx src/db/seed.ts
```

**Expected output:**
```
🌱 Seeding database…

  ✅ Bloom Wellness Studio created (ID: 00000000-0000-4000-a000-000000000001)
  ✅ Demo Clinic created (ID: ...)
  📅 Creating sample appointments for Bloom Wellness…
     ✅ APT-BLOOM-001: Sarah Johnson — Initial Wellness Consultation
     ✅ APT-BLOOM-002: Michael Chen — Acupuncture Session
     ...

🌱 Seed complete!
```

---

## Part 2 — HTTP Happy-Path Test (curl)

> These commands simulate exactly what the chat agent does when a user books an appointment.

### Variables (copy these into your shell)

```bash
# Bloom Wellness Studio tenant ID (from seed)
TENANT_ID="00000000-0000-4000-a000-000000000001"
BASE="http://localhost:3000"
SESSION_ID="test-session-$(date +%s)"
```

---

### Step 5: Verify tenant exists

```bash
curl -s "$BASE/api/tenants/$TENANT_ID" | jq '{name, slug, timezone, services: [.services[].name]}'
```

**Expected:**
```json
{
  "name": "Bloom Wellness Studio",
  "slug": "bloom-wellness",
  "timezone": "America/New_York",
  "services": [
    "Initial Wellness Consultation",
    "Follow-up Visit",
    "Acupuncture Session",
    "Nutrition Counseling",
    "Stress & Anxiety Consultation"
  ]
}
```

---

### Step 6: Check availability (tomorrow)

```bash
# Build tomorrow's date range dynamically
TOMORROW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d "+1 day" +%Y-%m-%d)
START="${TOMORROW}T00:00:00"
END="${TOMORROW}T23:59:59"

curl -s "$BASE/api/tenants/$TENANT_ID/availability?start=$START&end=$END" \
  | jq '{timezone, total: (.slots | length), available: [.slots[] | select(.available==true)] | length, first_3_available: [.slots[] | select(.available==true)] | .[0:3]}'
```

**Expected (shape — actual times depend on day/seed data):**
```json
{
  "timezone": "America/New_York",
  "total": 18,
  "available": 16,
  "first_3_available": [
    { "start": "2026-02-07T14:00:00.000Z", "end": "2026-02-07T14:30:00.000Z", "available": true },
    { "start": "2026-02-07T14:30:00.000Z", "end": "2026-02-07T15:00:00.000Z", "available": true },
    { "start": "2026-02-07T15:00:00.000Z", "end": "2026-02-07T15:30:00.000Z", "available": true }
  ]
}
```

✅ **Verify:** `available` > 0. If `available` is 0, the date may be a weekend (Bloom is closed on Sundays). Try the next weekday.

---

### Step 7: Pick a slot and create a hold

```bash
# Grab the first available slot
SLOT=$(curl -s "$BASE/api/tenants/$TENANT_ID/availability?start=$START&end=$END" \
  | jq -r '[.slots[] | select(.available==true)] | .[0]')
SLOT_START=$(echo "$SLOT" | jq -r '.start')
SLOT_END=$(echo "$SLOT" | jq -r '.end')

echo "Holding slot: $SLOT_START → $SLOT_END"

# Create hold
HOLD_RESPONSE=$(curl -s -X POST "$BASE/api/tenants/$TENANT_ID/holds" \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION_ID\",
    \"start_time\": \"$SLOT_START\",
    \"end_time\": \"$SLOT_END\"
  }")

echo "$HOLD_RESPONSE" | jq .

HOLD_ID=$(echo "$HOLD_RESPONSE" | jq -r '.id')
echo "Hold ID: $HOLD_ID"
```

**Expected (HTTP 201):**
```json
{
  "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "tenant_id": "00000000-0000-4000-a000-000000000001",
  "session_id": "test-session-...",
  "start_time": "2026-02-07T14:00:00.000Z",
  "end_time": "2026-02-07T14:30:00.000Z",
  "expires_at": "2026-02-06T...",
  "created_at": "2026-02-06T..."
}
```

✅ **Verify:** `HOLD_ID` is a UUID (not `null`). The hold expires in 5 minutes.

---

### Step 8: Verify slot is now unavailable

```bash
curl -s "$BASE/api/tenants/$TENANT_ID/availability?start=$START&end=$END" \
  | jq "[.slots[] | select(.start == \"$SLOT_START\")] | .[0]"
```

**Expected:**
```json
{
  "start": "2026-02-07T14:00:00.000Z",
  "end": "2026-02-07T14:30:00.000Z",
  "available": false
}
```

✅ **Verify:** `available` is now `false` for the held slot.

---

### Step 9: Confirm booking

```bash
BOOKING_RESPONSE=$(curl -s -X POST "$BASE/api/tenants/$TENANT_ID/appointments" \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"$SESSION_ID\",
    \"hold_id\": \"$HOLD_ID\",
    \"client_name\": \"Test User\",
    \"client_email\": \"test@example.com\",
    \"client_notes\": \"Happy path test booking\",
    \"service\": \"Follow-up Visit\"
  }")

echo "$BOOKING_RESPONSE" | jq .

APT_ID=$(echo "$BOOKING_RESPONSE" | jq -r '.id')
REF_CODE=$(echo "$BOOKING_RESPONSE" | jq -r '.reference_code')
GCAL_ID=$(echo "$BOOKING_RESPONSE" | jq -r '.google_event_id')

echo ""
echo "Appointment ID:    $APT_ID"
echo "Reference Code:    $REF_CODE"
echo "Calendar Event ID: $GCAL_ID"
```

**Expected (HTTP 201):**
```json
{
  "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "tenant_id": "00000000-0000-4000-a000-000000000001",
  "reference_code": "APT-XXXX",
  "client_name": "Test User",
  "client_email": "test@example.com",
  "client_notes": "Happy path test booking",
  "service": "Follow-up Visit",
  "start_time": "2026-02-07T14:00:00.000Z",
  "end_time": "2026-02-07T14:30:00.000Z",
  "timezone": "America/New_York",
  "status": "confirmed",
  "google_event_id": "mock-event-1-...",
  "created_at": "...",
  "updated_at": "..."
}
```

✅ **Verify:**
- `status` = `"confirmed"`
- `reference_code` starts with `APT-`
- `google_event_id` starts with `mock-event-` (in mock calendar mode)

---

### Step 10: Look up the booking

```bash
# By reference code
curl -s "$BASE/api/tenants/$TENANT_ID/appointments/lookup?ref=$REF_CODE" | jq '.appointments[0] | {reference_code, client_name, status}'

# By email
curl -s "$BASE/api/tenants/$TENANT_ID/appointments/lookup?email=test@example.com" | jq '.appointments | length'
```

**Expected:**
```json
{ "reference_code": "APT-XXXX", "client_name": "Test User", "status": "confirmed" }
```
```
1
```

---

### Step 11: Cancel the booking

```bash
curl -s -X POST "$BASE/api/tenants/$TENANT_ID/appointments/$APT_ID/cancel" | jq '{reference_code, status}'
```

**Expected:**
```json
{ "reference_code": "APT-XXXX", "status": "cancelled" }
```

---

## Part 3 — Verification

### 3A: Verify in the Database

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT reference_code, client_name, status, google_event_id, start_time
  FROM appointments
  WHERE client_email = 'test@example.com'
  ORDER BY created_at DESC
  LIMIT 1;
"
```

**Expected:**
```
 reference_code | client_name | status    | google_event_id      | start_time
----------------+-------------+-----------+----------------------+---------------------
 APT-XXXX       | Test User   | cancelled | mock-event-1-...     | 2026-02-07 14:00:00+00
```

### 3B: Verify hold was cleaned up

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT COUNT(*) AS remaining_holds
  FROM availability_holds
  WHERE session_id LIKE 'test-session-%';
"
```

**Expected:**
```
 remaining_holds
-----------------
               0
```

(The hold is deleted when the booking is confirmed.)

### 3C: Verify audit trail

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT event_type, entity_type, actor, created_at
  FROM audit_log
  WHERE payload::text LIKE '%test@example.com%' OR payload::text LIKE '%Test User%'
  ORDER BY created_at;
"
```

**Expected (3 rows):**
```
     event_type          | entity_type  | actor    | created_at
-------------------------+--------------+----------+-----------
 hold.created            | availability_hold | ai_agent | ...
 appointment.booked      | appointment  | ai_agent | ...
 appointment.cancelled   | appointment  | ai_agent | ...
```

### 3D: Verify calendar state (mock mode)

In mock mode (`CALENDAR_MODE=mock`, the default), check the backend logs:

```bash
docker compose logs backend | grep "\[mock-calendar\]"
```

**Expected (2 log entries):**
```
[mock-calendar] Created event: mock-event-1-1738857600000
  Tenant:  Bloom Wellness Studio (00000000-0000-4000-a000-000000000001)
  Summary: Follow-up Visit - Test User
  Time:    2026-02-07T14:00:00.000Z → 2026-02-07T14:30:00.000Z
  TZ:      America/New_York

[mock-calendar] Deleted event: mock-event-1-1738857600000 (tenant: Bloom Wellness Studio)
```

✅ Both `Created event` and `Deleted event` should appear.

### 3E: Verify calendar state (real mode)

If you're running with `CALENDAR_MODE=real` and valid Google OAuth tokens:

1. Open [Google Calendar](https://calendar.google.com)
2. Navigate to the appointment date
3. The event should appear as "Follow-up Visit - Test User" (then disappear after cancel)

---

## Part 4 — Chat Widget Test (Manual)

### Step 12: Open the chat widget

1. Open **http://localhost:5173** in your browser
2. Enter tenant ID: `00000000-0000-4000-a000-000000000001`
3. Type: **"I'd like to book an appointment"**

### Step 13: Complete the booking flow

Follow the AI agent's prompts:
1. **Service selection** → Pick any service (e.g., "Nutrition Counseling")
2. **Date selection** → Say "tomorrow" or a specific date
3. **Time selection** → Pick from the offered slots
4. **Contact info** → Provide name and email
5. **Confirmation** → Confirm the booking

### Step 14: Verify in the database

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT reference_code, client_name, service, status, start_time
  FROM appointments
  WHERE tenant_id = '00000000-0000-4000-a000-000000000001'
    AND status = 'confirmed'
  ORDER BY created_at DESC
  LIMIT 3;
"
```

You should see your chat-booked appointment alongside the seed data appointments.

---

## Part 5 — Quick Automated Script

For a single copy-paste test, there's also an automated script:

```bash
bash tests/happy-path.sh
```

This runs Steps 5–11 automatically and prints PASS/FAIL for each step.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl: (7) Failed to connect` | Services not started: `docker compose up -d` |
| `"Tenant not found"` | Seed not run: `docker compose exec backend npx tsx src/db/seed.ts` |
| All slots `available: false` | Date is a Sunday (Bloom closed) — use a weekday |
| `"Hold has expired"` | More than 5 min between hold and confirm — re-run from Step 7 |
| `google_event_id: null` | Expected if `CALENDAR_MODE=mock` and no tenant OAuth tokens set. Check logs for `[mock-calendar]` entries — the mock only creates events when the booking flow calls the provider. |
| No `[mock-calendar]` logs | Verify `CALENDAR_MODE=mock` in `docker compose exec backend env \| grep CALENDAR` |

---

## Switching Calendar Modes

```bash
# Mock mode (default — no Google credentials needed)
CALENDAR_MODE=mock docker compose up -d

# Real mode (requires Google OAuth)
CALENDAR_MODE=real \
  GOOGLE_CLIENT_ID=xxx \
  GOOGLE_CLIENT_SECRET=yyy \
  docker compose up -d
```

In real mode, you'll need to connect the tenant's Google Calendar first via:
```bash
curl -s "$BASE/api/tenants/$TENANT_ID/oauth/google" | jq .authorization_url
# → Open the returned URL in a browser to complete OAuth
```
