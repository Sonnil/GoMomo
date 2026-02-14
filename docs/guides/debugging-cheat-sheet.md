# 🔧 Local Debugging Cheat Sheet

> Quick-reference for daily gomomo.ai development.
> Bookmark this page — it covers 90% of what you'll reach for.

---

## 🔌 Connection Quick-Ref

```
Backend API    http://localhost:3000
Health check   http://localhost:3000/health
Frontend       http://localhost:5173
Demo mode      http://localhost:5173?demo=1
PostgreSQL     localhost:5432  user=receptionist  pass=receptionist_dev  db=receptionist
Tenant ID      00000000-0000-4000-a000-000000000001  (Bloom Wellness Studio)
```

---

## 1 — Common Startup Issues

### Stack won't start

| Symptom | Cause | Fix |
|---------|-------|-----|
| `port 5432 already in use` | Local Postgres running | `lsof -ti:5432 \| xargs kill -9` or `brew services stop postgresql` |
| `port 3000 already in use` | Stale backend process | `lsof -ti:3000 \| xargs kill -9` |
| Backend exits immediately | Missing `OPENAI_API_KEY` | Check `.env` has a real key: `grep OPENAI_API_KEY .env` |
| `❌ Invalid environment variables` | Zod schema rejection | Read the error — usually a missing required var. Compare `.env` against `src/backend/.env.example` |
| `ECONNREFUSED …:5432` | Postgres not ready yet | `docker compose up -d postgres && sleep 3 && docker compose up -d backend` |
| Frontend shows blank page | Backend not running | Check `curl localhost:3000/health` first |

### Quick full-reset start

```bash
docker compose down -v          # stop + destroy volumes
docker compose up --build -d    # rebuild from scratch
docker compose exec backend npx tsx src/db/seed.ts   # re-seed
```

### "Is it running?" checklist

```bash
docker compose ps                               # all 3 services Up?
curl -s localhost:3000/health | jq .             # { "status": "ok" }
docker compose logs backend --tail 20            # last 20 lines
```

---

## 2 — Database Reset

### Soft reset (keep schema, wipe data)

```bash
docker compose exec -T postgres psql -U receptionist -d receptionist -c "
  TRUNCATE appointments, availability_holds, chat_sessions, audit_log CASCADE;
"
docker compose exec backend npx tsx src/db/seed.ts
```

### Hard reset (destroy everything, re-migrate, re-seed)

```bash
docker compose down -v                                  # kills volume
docker compose up -d postgres && sleep 3                # fresh Postgres
docker compose up -d backend                            # runs migrations on start
docker compose exec backend npx tsx src/db/seed.ts      # seed
```

### Nuclear option (rebuild images too)

```bash
docker compose down -v --rmi local
docker compose up --build -d
docker compose exec backend npx tsx src/db/seed.ts
```

---

## 3 — Inspecting Data

### Connect to psql

```bash
# Inside Docker
docker compose exec -it postgres psql -U receptionist -d receptionist

# From host (if you have psql installed)
psql postgresql://receptionist:receptionist_dev@localhost:5432/receptionist
```

### 📋 Bookings (appointments)

```sql
-- All bookings, newest first
SELECT id, reference_code, client_name, client_email,
       service, status, start_time, google_event_id,
       created_at
FROM appointments
ORDER BY created_at DESC
LIMIT 20;

-- Only confirmed, upcoming
SELECT reference_code, client_name, service,
       start_time, end_time
FROM appointments
WHERE status = 'confirmed'
  AND start_time > NOW()
ORDER BY start_time;

-- Find by reference code
SELECT * FROM appointments WHERE reference_code = 'APT-XXXX';

-- Find by email
SELECT * FROM appointments WHERE client_email ILIKE '%jane%';

-- Orphan check: confirmed but no calendar event
SELECT id, reference_code, client_name, status, google_event_id
FROM appointments
WHERE status = 'confirmed'
  AND google_event_id IS NULL;
```

### ⏳ Holds (availability_holds)

```sql
-- Active holds (not expired)
SELECT id, session_id,
       start_time, end_time,
       expires_at,
       expires_at - NOW() AS time_left
FROM availability_holds
WHERE expires_at > NOW()
ORDER BY created_at DESC;

-- Expired holds (should be cleaned up)
SELECT id, session_id, start_time, expires_at
FROM availability_holds
WHERE expires_at <= NOW();

-- Count by session
SELECT session_id, COUNT(*) FROM availability_holds
GROUP BY session_id ORDER BY count DESC;
```

### 📜 Audit Events (audit_log)

```sql
-- Latest 30 events
SELECT id, event_type, entity_type, entity_id,
       actor, created_at,
       payload->>'reference_code' AS ref
FROM audit_log
ORDER BY created_at DESC
LIMIT 30;

-- All events for a specific booking
SELECT event_type, actor, created_at, payload
FROM audit_log
WHERE entity_id = '<appointment-uuid>'
ORDER BY created_at;

-- Calendar rollbacks (failure simulation)
SELECT * FROM audit_log
WHERE event_type = 'appointment.calendar_rollback'
ORDER BY created_at DESC;

-- Booking lifecycle for a reference code
SELECT al.event_type, al.actor, al.created_at
FROM audit_log al
WHERE al.payload->>'reference_code' = 'APT-XXXX'
ORDER BY al.created_at;
```

### 💬 Chat Sessions

```sql
-- Recent sessions
SELECT id, tenant_id, created_at, updated_at,
       jsonb_array_length(conversation) AS msg_count
FROM chat_sessions
ORDER BY updated_at DESC
LIMIT 10;

-- Read conversation for a session (pretty-print)
SELECT jsonb_pretty(conversation)
FROM chat_sessions
WHERE id = '<session-id>';
```

---

## 4 — Logs to Watch During Booking

### Tail backend logs

```bash
docker compose logs -f backend          # all logs
docker compose logs -f backend 2>&1 | grep -i 'error\|warn\|fail'   # errors only
```

### What to look for in a successful booking flow

```
1.  WebSocket connected: <socket-id>
2.  (user sends "book an appointment")
3.  — no explicit log for tool calls, but you'll see DB activity —
4.  [hold-cleanup] Purged N expired hold(s)     ← periodic, not per-booking
5.  — if CALENDAR_MODE=mock —
    [mock-calendar] createEvent: <start> → <end> → mock-evt-<uuid>
6.  — booking complete, no errors = success —
```

### Key error signatures

| Log pattern | What happened |
|-------------|---------------|
| `Tool execution error (confirm_booking):` | `tool-executor.ts` caught a throw from booking service |
| `Calendar event creation failed (booking still confirmed)` | Calendar sync failed but lenient mode — booking OK |
| `⚠️ Rollback after calendar failure also failed:` | Strict mode rollback itself threw — needs investigation |
| `[mock-calendar] ⚡ FAILURE SIMULATION:` | `CALENDAR_FAIL_MODE` is active — intentional |
| `Chat error:` | Unhandled error in WebSocket chat handler |
| `[voice] Error processing turn for <callSid>:` | Voice conversation engine threw |
| `[sms] Twilio credentials not configured` | Expected locally — Twilio not set up |
| `❌ Invalid environment variables:` | Zod rejected .env — read the schema error |

---

## 5 — Agent vs Backend: Who Caused the Issue?

### Decision tree

```
User reports wrong behavior
  │
  ├─ Is the HTTP/DB state correct?
  │   │
  │   ├─ YES → Agent issue (LLM said the wrong thing)
  │   │         Check: chat_sessions.conversation for tool_calls + tool results
  │   │
  │   └─ NO  → Backend issue (service/DB logic)
  │             Check: audit_log + docker compose logs backend
  │
  └─ Did a tool call return { success: false }?
      │
      ├─ YES, with meaningful error → Backend threw correctly, agent should handle
      │   • If agent didn't handle it → Agent issue (system prompt / model)
      │   • If error message is wrong → Backend issue (wrong error text)
      │
      └─ YES, with "An internal error occurred" → Unknown backend crash
          Check: docker compose logs backend | grep "Tool execution error"
```

### How to inspect what the agent saw

```sql
-- Get the full conversation including tool calls and results
SELECT jsonb_pretty(conversation)
FROM chat_sessions
WHERE id = '<session-id>';
```

Look for entries like:

```json
{ "role": "assistant", "tool_calls": [{ "function": { "name": "confirm_booking", "arguments": "..." } }] }
{ "role": "tool", "content": "{\"success\": false, \"error\": \"Unable to sync with the calendar...\"}" }
{ "role": "assistant", "content": "I'm sorry, I wasn't able to complete..." }
```

- **Agent issue**: tool result was correct but the assistant's next message was wrong
- **Backend issue**: tool result was wrong, or the tool threw unexpectedly

### Quick checks

```bash
# Did the backend throw on this tool call?
docker compose logs backend 2>&1 | grep "Tool execution error"

# Did calendar fail?
docker compose logs backend 2>&1 | grep -i "calendar.*fail\|calendar.*error\|mock-calendar"

# Is the system prompt loaded?
docker compose logs backend 2>&1 | grep -i "system.*prompt\|tool.*definition"
```

---

## 6 — Useful One-Liners

### API smoke test

```bash
T="00000000-0000-4000-a000-000000000001"

# Health
curl -s localhost:3000/health | jq .

# Get tenant
curl -s localhost:3000/api/tenants/$T | jq .name

# Check availability (tomorrow)
DAY=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d "+1 day" +%Y-%m-%d)
curl -s "localhost:3000/api/tenants/$T/availability?start=${DAY}T00:00:00&end=${DAY}T23:59:59" | jq '.slots | length'

# Send a chat message (REST, not WebSocket)
curl -s -X POST "localhost:3000/api/tenants/$T/chat" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"debug-123","message":"What services do you offer?"}' | jq .reply
```

### DB row counts

```bash
docker compose exec -T postgres psql -U receptionist -d receptionist -c "
  SELECT 'appointments' AS t, COUNT(*) FROM appointments
  UNION ALL SELECT 'holds', COUNT(*) FROM availability_holds
  UNION ALL SELECT 'sessions', COUNT(*) FROM chat_sessions
  UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log
  UNION ALL SELECT 'tenants', COUNT(*) FROM tenants;
"
```

### Watch hold expiry in real time

```bash
watch -n5 'docker compose exec -T postgres psql -U receptionist -d receptionist -tAc "
  SELECT COUNT(*) || \" active holds\" FROM availability_holds WHERE expires_at > NOW();
"'
```

### TypeScript compile check (no emit)

```bash
cd src/backend && npx tsc --noEmit
```

### Restart just the backend (fast)

```bash
docker compose restart backend
docker compose logs -f backend
```

---

## 7 — Environment Toggles

| Variable | Values | What it does |
|----------|--------|-------------|
| `CALENDAR_MODE` | `mock` / `real` | Mock = no Google API calls |
| `CALENDAR_FAIL_MODE` | `none` / `auth_error` / `network_error` / `timeout` / `all_ops_fail` | Simulates calendar failures (mock mode only) |
| `CALENDAR_SYNC_REQUIRED` | `false` / `true` | `true` = booking fails if calendar sync fails |
| `LOG_LEVEL` | `fatal` `error` `warn` `info` `debug` `trace` | Fastify/Pino log verbosity |
| `HOLD_TTL_MINUTES` | number (default `5`) | How long a slot hold lasts |
| `VOICE_ENABLED` | `true` / `false` | Enable Twilio voice routes |
| `SMS_HANDOFF_ENABLED` | `true` / `false` | Enable SMS handoff during calls |
| `EXCEL_ENABLED` | `true` / `false` | Enable Excel sync worker |

Toggle at runtime by setting in `.env` and restarting:

```bash
# Example: enable verbose logging + failure simulation
echo "LOG_LEVEL=debug" >> .env
echo "CALENDAR_FAIL_MODE=auth_error" >> .env
docker compose restart backend
```

---

## 8 — File Map (Where to Look)

| What | File |
|------|------|
| Startup / route registration | `src/backend/src/index.ts` |
| Env schema (all config) | `src/backend/src/config/env.ts` |
| AI system prompt | `src/backend/src/agent/system-prompt.ts` |
| Tool definitions (what agent can call) | `src/backend/src/agent/tools.ts` |
| Tool execution (how calls are handled) | `src/backend/src/agent/tool-executor.ts` |
| Chat orchestration loop | `src/backend/src/agent/chat-handler.ts` |
| Booking logic (hold → confirm) | `src/backend/src/services/booking.service.ts` |
| Availability / conflict detection | `src/backend/src/services/availability.service.ts` |
| DB schema | `src/backend/src/db/migrations/001_initial.sql` |
| Seed data | `src/backend/src/db/seed.ts` |
| Calendar mock (+ failure sim) | `src/backend/src/integrations/calendar/mock-calendar.ts` |
| Calendar factory | `src/backend/src/integrations/calendar/index.ts` |
| Voice state machine | `src/backend/src/voice/conversation-engine.ts` |
| Voice routes (Twilio webhooks) | `src/backend/src/voice/voice.routes.ts` |
| SMS sender | `src/backend/src/voice/sms-sender.ts` |
| SMS handoff routes | `src/backend/src/voice/handoff.routes.ts` |

---

*Last updated: 2026-02-06*
