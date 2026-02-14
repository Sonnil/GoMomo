# Concurrency & Overbooking Protection — Test Guide

> Verify that two users cannot book the same time slot, no matter how
> hard they try. Covers browser-based, API-based, and DB-level tests.

---

## How the Protection Works (4 Layers)

| Layer | Mechanism | Where | Prevents |
|---|---|---|---|
| **1 — EXCLUDE constraint on `availability_holds`** | GiST range exclusion `(tenant_id, tstzrange(start,end))` | PostgreSQL (`002_hardening.sql`) | Two sessions holding the same slot |
| **2 — EXCLUDE constraint on `appointments`** | GiST range exclusion `WHERE status != 'cancelled'` | PostgreSQL (`001_initial.sql`) | Two confirmed bookings overlapping |
| **3 — SERIALIZABLE transactions** | `BEGIN ISOLATION LEVEL SERIALIZABLE` with automatic retry (up to 3×) | `db/client.ts` → `withSerializableTransaction()` | Phantom-read races during confirm |
| **4 — Advisory lock** | `pg_advisory_xact_lock(hash(tenant_id, hold_id))` | `booking.service.ts` → `confirmBooking()` | Cross-table race between hold + appointment tables |

**Error codes the system produces:**

| PG Code | Meaning | HTTP Response |
|---|---|---|
| `23P01` | EXCLUDE constraint violation | `409 { error: "This time slot is no longer available" }` |
| `40001` | Serialization failure | Auto-retried up to 3× (transparent to client) |
| `23505` | Unique violation (`source_hold_id`) | `409 { error: "This time slot was just booked…" }` |

---

## Prerequisites

```bash
cd /Users/leso01/Documents/AI_Team/EON/projects/prj-20260205-001-ai-receptionist

# 1. Stack is running
docker compose up --build -d
docker compose exec backend npx tsx src/db/seed.ts

# 2. Verify health
curl -s http://localhost:3000/health | jq .status  # "ok"

# 3. Tools installed
which jq >/dev/null && echo "jq ✅" || echo "brew install jq"
```

---

## Test Scenario: Two Users Race for the Same Slot

**Setup:** Alice and Bob both see the same 2:00 PM slot on tomorrow's
calendar. Both click "Book" within milliseconds of each other.

**Expected outcome:**
- ✅ Exactly ONE of them gets the appointment
- ❌ The other gets HTTP 409 — "This time slot is no longer available"
- 📋 Zero duplicate rows in the database

---

## Method A — Browser-Based Test (Manual)

### Step 1: Open two browser windows

| Window | Type | URL |
|---|---|---|
| **Alice** | Normal / Chrome | `http://localhost:5173` |
| **Bob** | Incognito / Firefox | `http://localhost:5173` |

### Step 2: Both users navigate to the same tenant

Enter tenant ID in both windows:
```
00000000-0000-4000-a000-000000000001
```

### Step 3: Both start booking the same service and time

1. In **both** windows, type: *"I'd like to book an appointment"*
2. Both select the **same service** (e.g., "Follow-up Visit")
3. Both select **tomorrow** as the date
4. Both select the **exact same time slot** (e.g., the first offered slot)

### Step 4: Both confirm at the same time

- Have both windows ready at the confirmation prompt
- Click **confirm** in both windows as simultaneously as possible

### Step 5: Observe the results

| Outcome | Alice (expected) | Bob (expected) |
|---|---|---|
| **Winner** | Gets confirmation: `"Your appointment is confirmed! Reference: APT-XXXX"` | |
| **Loser** | | Gets rejection: `"This time slot was just booked by someone else. Please select a different time."` |

> **Note:** Which user "wins" is non-deterministic — it depends on which
> request reaches PostgreSQL first. The critical invariant is that exactly
> one wins.

### Step 6: Verify in the database

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT reference_code, client_name, status, start_time
  FROM appointments
  WHERE tenant_id = '00000000-0000-4000-a000-000000000001'
    AND status = 'confirmed'
    AND start_time = (
      -- The slot both users tried to book
      SELECT start_time FROM appointments
      WHERE tenant_id = '00000000-0000-4000-a000-000000000001'
      ORDER BY created_at DESC LIMIT 1
    );
"
```

**Pass criterion:** Exactly **1 row** returned for that time slot.

---

## Method B — API-Based Test (Automated)

This is the more rigorous test. We fire parallel curl requests.

### Shell variables

```bash
TENANT_ID="00000000-0000-4000-a000-000000000001"
BASE="http://localhost:3000"
```

### Step 1: Pick a target slot

```bash
# Find a weekday in the near future
TOMORROW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d "+1 day" +%Y-%m-%d)
START="${TOMORROW}T00:00:00"
END="${TOMORROW}T23:59:59"

# Grab the first available slot
SLOT=$(curl -s "$BASE/api/tenants/$TENANT_ID/availability?start=$START&end=$END" \
  | jq '[.slots[] | select(.available==true)] | .[0]')
SLOT_START=$(echo "$SLOT" | jq -r '.start')
SLOT_END=$(echo "$SLOT" | jq -r '.end')

echo "Target slot: $SLOT_START → $SLOT_END"
```

### Step 2: Fire two parallel hold requests

```bash
# Two different sessions try to hold the SAME slot simultaneously
curl -s -w "\nHTTP_CODE:%{http_code}\n" -X POST "$BASE/api/tenants/$TENANT_ID/holds" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"alice-$(date +%s)\",\"start_time\":\"$SLOT_START\",\"end_time\":\"$SLOT_END\"}" \
  > /tmp/alice_hold.txt &

curl -s -w "\nHTTP_CODE:%{http_code}\n" -X POST "$BASE/api/tenants/$TENANT_ID/holds" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"bob-$(date +%s)\",\"start_time\":\"$SLOT_START\",\"end_time\":\"$SLOT_END\"}" \
  > /tmp/bob_hold.txt &

wait
echo "=== Alice ==="
cat /tmp/alice_hold.txt
echo ""
echo "=== Bob ==="
cat /tmp/bob_hold.txt
```

**Expected output:**

One request returns **HTTP 201** (hold created):
```json
{"id":"xxxxxxxx-...","tenant_id":"00000000-...","session_id":"alice-...","start_time":"...","end_time":"...","expires_at":"...","created_at":"..."}
HTTP_CODE:201
```

The other returns **HTTP 409** (EXCLUDE constraint blocked it):
```json
{"error":"This time slot is no longer available"}
HTTP_CODE:409
```

**Pass criterion:**
- Exactly **one 201** and **one 409**
- Never **two 201s**

### Step 3: Fire N parallel hold requests (stress test)

```bash
# Hammer the same slot with 10 concurrent requests
for i in $(seq 1 10); do
  curl -s -o /tmp/hold_$i.txt -w "%{http_code}" -X POST "$BASE/api/tenants/$TENANT_ID/holds" \
    -H "Content-Type: application/json" \
    -d "{\"session_id\":\"racer-$i-$(date +%s)\",\"start_time\":\"$SLOT_START\",\"end_time\":\"$SLOT_END\"}" &
done
wait

echo "Results:"
for i in $(seq 1 10); do
  CODE=$(cat /tmp/hold_$i.txt)
  echo "  Racer $i: HTTP $CODE"
done

WINNERS=$(for i in $(seq 1 10); do cat /tmp/hold_$i.txt; done | grep -c "201")
echo ""
echo "Winners: $WINNERS / 10"
echo "Expected: exactly 1"
```

**Pass criterion:** `Winners: 1 / 10`

### Step 4: Confirm the winning hold, then race to confirm again

```bash
# Find which hold won (the 201 response)
for i in $(seq 1 10); do
  BODY=$(cat /tmp/hold_$i.txt)
  if echo "$BODY" | grep -q '"id"'; then
    WINNING_HOLD=$(echo "${BODY%???}" | jq -r '.id')
    WINNING_SESSION=$(echo "${BODY%???}" | jq -r '.session_id')
    break
  fi
done
echo "Winning hold: $WINNING_HOLD (session: $WINNING_SESSION)"

# Now fire 5 parallel confirm requests for the SAME hold
for i in $(seq 1 5); do
  curl -s -o /tmp/confirm_$i.txt -w "%{http_code}" -X POST "$BASE/api/tenants/$TENANT_ID/appointments" \
    -H "Content-Type: application/json" \
    -d "{
      \"session_id\":\"$WINNING_SESSION\",
      \"hold_id\":\"$WINNING_HOLD\",
      \"client_name\":\"Racer $i\",
      \"client_email\":\"racer$i@test.com\",
      \"service\":\"Follow-up Visit\"
    }" &
done
wait

echo "Confirm results:"
CONFIRMATIONS=0
for i in $(seq 1 5); do
  CODE=$(cat /tmp/confirm_$i.txt)
  echo "  Attempt $i: HTTP $CODE"
  if echo "$CODE" | grep -q "201"; then
    ((CONFIRMATIONS++))
  fi
done

echo ""
echo "Confirmed: $CONFIRMATIONS / 5"
echo "Expected: exactly 1 (idempotent responses may also return the same appointment)"
```

**Pass criterion:** At most 1 unique appointment created (idempotent retries return the same appointment).

---

## Method C — Direct Database Race Test

The existing `race-condition.test.ts` runs 5 tests directly against PostgreSQL:

```bash
docker compose exec backend npx tsx tests/race-condition.test.ts
```

**What it tests:**

| # | Test | Concurrency | Pass Criterion |
|---|---|---|---|
| 1 | Concurrent holds (same slot) | 10 parallel INSERTs | Exactly 1 succeeds |
| 2 | Concurrent appointments (same slot) | 10 parallel INSERTs | Exactly 1 succeeds |
| 3 | SERIALIZABLE transaction contention | 3 txns read-then-write | ≤ 1 commits |
| 4 | Expired holds don't block new holds | Insert expired + fresh | Fresh hold succeeds |
| 5 | Idempotent booking (source_hold_id) | Duplicate hold_id | Second INSERT rejected |

**Expected output:**
```
═══════════════════════════════════════════════
  gomomo.ai — Race-Condition Test Suite
═══════════════════════════════════════════════
  Database: postgresql://***:***@localhost:5432/ai_receptionist
  Concurrency: 10 parallel workers

  Test tenant created: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

📝 Test 1: Concurrent hold attempts for the SAME slot
   Firing 10 parallel INSERT into availability_holds…
   ✅ Succeeded: 1  ❌ Rejected (EXCLUDE): 9
   ✅ PASS: Exactly 1 hold succeeded, all others rejected by EXCLUDE constraint.

📝 Test 2: Concurrent appointment inserts for the SAME slot
   Firing 10 parallel INSERT into appointments…
   ✅ Succeeded: 1  ❌ Rejected (EXCLUDE): 9
   ✅ PASS: Exactly 1 appointment succeeded, all others rejected by EXCLUDE constraint.

📝 Test 3: SERIALIZABLE transaction contention
   Two transactions both read, then try to write to the same slot…
   ↻ txn-B: serialization failure (40001) — would retry
   ✗ txn-C: EXCLUDE constraint violation — slot taken
   Winners: 1/3
   ✅ PASS: At most 1 transaction committed for the same slot.

📝 Test 4: Expired holds should NOT block new holds
   ✅ PASS: New hold inserted despite expired hold on same slot.

📝 Test 5: Idempotent booking via source_hold_id
   ✅ PASS: Duplicate source_hold_id correctly rejected (unique constraint).

═══════════════════════════════════════════════
  RESULTS
═══════════════════════════════════════════════
  ✅ Concurrent holds
  ✅ Concurrent appointments
  ✅ Serializable txn
  ✅ Expired holds passthrough
  ✅ Idempotent booking
═══════════════════════════════════════════════
  🎉 ALL TESTS PASSED
```

---

## SQL Verification Queries

Run these after any test to confirm database integrity.

### 4A: No duplicate confirmed bookings for the same slot

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT
    a1.reference_code AS booking_1,
    a2.reference_code AS booking_2,
    a1.start_time,
    a1.end_time,
    a1.tenant_id
  FROM appointments a1
  JOIN appointments a2
    ON a1.tenant_id = a2.tenant_id
   AND a1.id < a2.id
   AND a1.status = 'confirmed'
   AND a2.status = 'confirmed'
   AND a1.start_time < a2.end_time
   AND a1.end_time > a2.start_time;
"
```

**Pass:** `(0 rows)` — No overlapping confirmed appointments exist.

**Fail:** Any rows = overbooking bug. 🚨

### 4B: No duplicate holds for the same slot (active only)

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT
    h1.id AS hold_1,
    h2.id AS hold_2,
    h1.session_id AS session_1,
    h2.session_id AS session_2,
    h1.start_time,
    h1.end_time,
    h1.tenant_id
  FROM availability_holds h1
  JOIN availability_holds h2
    ON h1.tenant_id = h2.tenant_id
   AND h1.id < h2.id
   AND h1.expires_at > NOW()
   AND h2.expires_at > NOW()
   AND h1.start_time < h2.end_time
   AND h1.end_time > h2.start_time;
"
```

**Pass:** `(0 rows)` — No overlapping active holds.

### 4C: No stale holds (expired but not cleaned up)

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT
    COUNT(*) AS stale_holds,
    MIN(expires_at) AS oldest_expiry,
    MAX(expires_at) AS newest_expiry
  FROM availability_holds
  WHERE expires_at <= NOW();
"
```

**Acceptable:** `stale_holds` may be > 0 (cleanup is periodic). The
important thing is that the EXCLUDE constraint has `WHERE (expires_at > NOW())`
so stale holds do **not** block new bookings.

To force cleanup:
```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  DELETE FROM availability_holds WHERE expires_at <= NOW();
"
```

### 4D: Appointment ↔ hold cross-check

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  -- Every confirmed appointment should have its hold deleted
  SELECT a.reference_code, a.source_hold_id, h.id AS hold_still_exists
  FROM appointments a
  LEFT JOIN availability_holds h ON h.id = a.source_hold_id
  WHERE a.status = 'confirmed'
    AND a.source_hold_id IS NOT NULL
    AND h.id IS NOT NULL;
"
```

**Pass:** `(0 rows)` — Confirmed appointments have had their holds cleaned up.

**Fail:** Any rows = hold wasn't deleted during confirmation (transaction bug).

### 4E: Audit trail completeness

```bash
docker compose exec postgres psql -U receptionist -d receptionist -c "
  SELECT event_type, COUNT(*) as count
  FROM audit_log
  WHERE tenant_id = '00000000-0000-4000-a000-000000000001'
  GROUP BY event_type
  ORDER BY event_type;
"
```

**Expected:** You should see `hold.created` ≥ `appointment.booked`, since some holds
expire without becoming bookings.

---

## Automated Script

For a single-command test, run:

```bash
bash tests/concurrency-race.sh
```

This fires parallel holds + confirms and reports PASS/FAIL.

---

## Pass/Fail Summary

| Test | Pass Criterion | Method |
|---|---|---|
| Parallel holds (same slot) | Exactly 1 gets HTTP 201, rest get 409 | B.2, B.3, C.1 |
| Parallel confirms (same hold) | ≤ 1 unique appointment created | B.4, C.3 |
| Parallel appointments (same slot) | Exactly 1 INSERT succeeds | C.2 |
| Expired holds don't block | New hold succeeds despite expired hold | C.4 |
| Idempotent confirm | Duplicate source_hold_id rejected | C.5 |
| No DB duplicates | Overlap query returns 0 rows | SQL 4A |
| No stale holds blocking | EXCLUDE filters expired holds | SQL 4C |
| Hold cleanup after confirm | No orphan holds for confirmed bookings | SQL 4D |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Both requests get 201 | Missing EXCLUDE constraint | Run `002_hardening.sql` migration |
| `btree_gist` not found | Extension not created | `CREATE EXTENSION IF NOT EXISTS btree_gist;` |
| All requests get 409 | Stale hold from previous test | `DELETE FROM availability_holds WHERE expires_at <= NOW();` |
| `40001` errors in app logs | Normal — serialization retries | Transparent; `withSerializableTransaction` retries 3× |
| Hold succeeds but confirm fails | Hold expired (5 min TTL) | Re-run hold → confirm faster |
