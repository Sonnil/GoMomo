# Phase 26 — Autonomous Agent Runtime with Guardrails

> **Status**: Implementation  
> **Date**: 2026-02-07  
> **Goal**: Upgrade gomomo.ai from a reactive chat-bot into an autonomous agent runtime with strict guardrails — policy-gated actions, a typed event bus, a persistent job queue, and a full PII-redacted audit trail.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│  Autonomy: ON/OFF toggle · Scheduled-job indicator           │
└──────────┬──────────────────────────────────────┬───────────┘
           │ Socket.IO / REST                     │
┌──────────▼──────────────────────────────────────▼───────────┐
│                       INDEX.TS (Fastify)                     │
│  /api/autonomy · /api/jobs · /api/policy-rules               │
└──────────┬──────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────┐
│                     ORCHESTRATOR                             │
│  Subscribes to Event Bus → evaluates Policy Engine           │
│  → enqueues Jobs → executes via Tool Executor                │
│                                                              │
│  INVARIANT: every proactive action is:                       │
│    1. Triggered by a domain event                            │
│    2. Gated by the Policy Engine                             │
│    3. Executed ONLY through registered tools (no shell/fs)   │
│    4. Audit-logged (PII redacted)                            │
└──────────┬──────────┬──────────┬───────────────────────────┘
           │          │          │
┌──────────▼───┐ ┌────▼─────┐ ┌─▼─────────────┐
│  EVENT BUS   │ │ POLICY   │ │  JOB QUEUE     │
│  (typed,     │ │ ENGINE   │ │  (persistent,  │
│  in-process) │ │ (DB      │ │  Postgres,     │
│              │ │  rules)  │ │  claim/retry)  │
└──────────────┘ └──────────┘ └───────────────┘
```

## 2. Non-Negotiables (enforced by design)

| Guarantee | Enforcement Mechanism |
|---|---|
| **No overbooking** | Existing: EXCLUDE constraints + SERIALIZABLE txns + advisory locks. Unchanged. |
| **Tool-only actions** | Orchestrator can only call functions in `registered-tools.ts`. No fs/shell/exec in the tool registry. |
| **Policy gates every action** | `policyEngine.evaluate()` returns `allow`/`deny` before any job executes. Default: deny-all. |
| **Full audit trail** | Event Bus auto-logs every emission. Job queue logs claim/complete/fail. All payloads PII-redacted via `redactPII()`. |

## 3. Data Model Additions (Migration 004)

### `policy_rules`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| tenant_id | UUID FK → tenants | NULL = global rule |
| action | TEXT | e.g. `send_confirmation`, `send_reminder`, `auto_cancel_no_show` |
| effect | TEXT | `allow` or `deny` |
| conditions | JSONB | e.g. `{"min_lead_time_minutes": 60}` |
| priority | INT | Higher wins on conflict |
| is_active | BOOLEAN | Soft toggle |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### `jobs`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| tenant_id | UUID FK → tenants | |
| type | TEXT | e.g. `send_confirmation_email`, `send_reminder` |
| payload | JSONB | PII-redacted at write time |
| status | TEXT | `pending`, `claimed`, `completed`, `failed`, `cancelled` |
| priority | INT | Default 0 |
| run_at | TIMESTAMPTZ | Scheduled execution time |
| claimed_at | TIMESTAMPTZ | When a worker claimed it |
| completed_at | TIMESTAMPTZ | |
| attempts | INT | Retry count |
| max_attempts | INT | Default 3 |
| last_error | TEXT | Last failure reason |
| created_at | TIMESTAMPTZ | |

### `notification_outbox`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| tenant_id | UUID FK → tenants | |
| job_id | UUID FK → jobs | Source job |
| channel | TEXT | `email`, `sms`, `webhook` |
| recipient | TEXT | PII-redacted in logs |
| subject | TEXT | |
| body | TEXT | |
| status | TEXT | `pending`, `sent`, `failed` |
| sent_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

## 4. New Modules

```
src/backend/src/
├── orchestrator/
│   ├── event-bus.ts          # Typed EventEmitter with auto-audit
│   ├── events.ts             # Domain event type definitions
│   ├── policy-engine.ts      # Evaluate rules, return allow/deny
│   ├── job-queue.ts          # Persistent Postgres job queue
│   ├── job-runner.ts         # Poll-based runner with concurrency limit
│   ├── orchestrator.ts       # Wires events → policies → jobs
│   ├── handlers/             # Event-specific reaction handlers
│   │   ├── on-booking-created.ts
│   │   ├── on-booking-cancelled.ts
│   │   ├── on-hold-expired.ts
│   │   └── on-calendar-write-failed.ts
│   └── registered-tools.ts   # Whitelist of allowed autonomous actions
├── repos/
│   ├── policy.repo.ts        # CRUD for policy_rules
│   └── job.repo.ts           # CRUD + claim/complete/fail for jobs
└── routes/
    └── autonomy.routes.ts    # REST API for autonomy status + jobs
```

## 5. Domain Events

| Event Name | Emitted By | Payload |
|---|---|---|
| `BookingCreated` | booking.service.confirmBooking | appointment, tenant_id |
| `BookingCancelled` | booking.service.cancel | appointment, tenant_id |
| `BookingRescheduled` | booking.service.reschedule | old_apt, new_apt, tenant_id |
| `HoldExpired` | hold cleanup timer | hold_id, tenant_id, slot_start, slot_end |
| `HoldCreated` | availability.service.holdSlot | hold, tenant_id |
| `CalendarWriteFailed` | booking.service (catch block) | appointment_id, error, tenant_id |

## 6. Policy Rules (seeded defaults)

| Action | Default Effect | Description |
|---|---|---|
| `send_confirmation` | `allow` | Email confirmation after booking |
| `send_reminder` | `allow` | Reminder before appointment |
| `auto_cancel_no_show` | `deny` | Cancel if no-show after N minutes |
| `send_follow_up` | `deny` | Post-visit follow-up |
| `retry_calendar_sync` | `allow` | Retry failed calendar writes |

## 7. PR-Sized Chunks (each ≤ 2 hours)

| # | Chunk | Files | Est. |
|---|---|---|---|
| 1 | Migration 004 + domain types | 004_agent_runtime.sql, types.ts, events.ts | 30 min |
| 2 | Event Bus + PII redaction | event-bus.ts, redact.ts | 45 min |
| 3 | Policy Engine + repo | policy-engine.ts, policy.repo.ts | 45 min |
| 4 | Job Queue + repo | job-queue.ts, job.repo.ts | 45 min |
| 5 | Job Runner | job-runner.ts | 30 min |
| 6 | Orchestrator + handlers | orchestrator.ts, handlers/* | 60 min |
| 7 | Wire events into booking/hold services | booking.service.ts, index.ts | 30 min |
| 8 | Registered tools whitelist | registered-tools.ts | 15 min |
| 9 | API routes + seed | autonomy.routes.ts, seed.ts | 45 min |
| 10 | Frontend indicator | DemoChatWidget.tsx | 30 min |
| 11 | Env vars + startup wiring | env.ts, .env, index.ts | 15 min |
| 12 | Guardrail tests | tests/guardrails.test.ts | 60 min |

## 8. Env Vars

| Variable | Default | Description |
|---|---|---|
| `AUTONOMY_ENABLED` | `false` | Master kill-switch for the agent runtime |
| `AGENT_MAX_CONCURRENT_JOBS` | `3` | Max jobs executing simultaneously |
| `AGENT_JOB_POLL_INTERVAL_MS` | `5000` | How often the runner polls for new jobs |
| `AGENT_JOB_STALE_TIMEOUT_MS` | `300000` | Claimed jobs older than this are reclaimed |

---

*This document is the source of truth for Phase 26 implementation.*
