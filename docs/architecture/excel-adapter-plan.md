# Excel Adapter — Design & Migration Plan

> **Status:** Design only — no code  
> **Parent spec:** `docs/architecture/extension-design-spec.md` §3  
> **Date:** 2026-02-06  
> **Architecture decision:** Option B (Hybrid) — Postgres is source of truth, Excel is human-readable mirror

---

## Table of Contents

1. [Current Architecture Audit](#1-current-architecture-audit)
2. [ExcelAdapter Interface Proposal](#2-exceladapter-interface-proposal)
3. [Concurrency Strategy](#3-concurrency-strategy)
4. [Data Format](#4-data-format)
5. [Failure Handling](#5-failure-handling)
6. [MVP Recommendation](#6-mvp-recommendation)
7. [Migration Plan](#7-migration-plan)

---

## 1. Current Architecture Audit

### What exists today

The codebase has **no formal `BookingStore` interface**. Instead, concrete
implementations are imported directly:

```
tool-executor.ts
  └── bookingService       (src/services/booking.service.ts)
        ├── appointmentRepo  (src/repos/appointment.repo.ts) — raw pg queries
        ├── holdRepo         (src/repos/hold.repo.ts)        — raw pg queries
        ├── auditRepo        (src/repos/audit.repo.ts)       — raw pg queries
        └── calendarService  (src/services/calendar.service.ts) — Google Calendar
```

### Current service surface (what the agent calls)

| Tool Name            | bookingService method  | Repos touched                        |
|----------------------|-----------------------|--------------------------------------|
| `check_availability` | (availabilityService) | appointmentRepo, holdRepo            |
| `hold_slot`          | (availabilityService) | holdRepo                             |
| `confirm_booking`    | `confirmBooking()`    | appointmentRepo, holdRepo, auditRepo |
| `lookup_booking`     | `lookup()`            | appointmentRepo                      |
| `reschedule_booking` | `reschedule()`        | appointmentRepo, holdRepo, auditRepo |
| `cancel_booking`     | `cancel()`            | appointmentRepo, auditRepo           |

### Key invariant

All channels (web chat, voice, SMS-handoff resume) funnel through `executeToolCall()` → `bookingService` → `appointmentRepo`. **The Excel adapter must NOT create a parallel write path.** It plugs in below `bookingService`, either as an alternative `appointmentRepo` implementation or as a post-commit sync layer.

---

## 2. ExcelAdapter Interface Proposal

### 2.1 Why an interface is needed first

The current `appointmentRepo` is a concrete object with raw SQL. To support
Excel (or any future store), we need an abstract `BookingStore` interface
that both `PostgresBookingStore` and `ExcelSyncAdapter` implement.

### 2.2 BookingStore interface

```typescript
/**
 * BookingStore — Abstract interface for appointment persistence.
 *
 * Implementations:
 *   PostgresBookingStore  — current default (wraps appointmentRepo)
 *   ExcelSyncAdapter      — Hybrid: delegates to Postgres, syncs to Excel
 *   ExcelDirectStore      — NOT recommended for MVP (Option A, no ACID)
 */
export interface BookingStore {
  // ── Reads ──────────────────────────────────────────────────
  findById(id: string, tenantId: string): Promise<Appointment | null>;
  findByReference(referenceCode: string, tenantId: string): Promise<Appointment | null>;
  findByEmail(email: string, tenantId: string): Promise<Appointment[]>;
  findBySourceHold(holdId: string): Promise<Appointment | null>;
  listByTenantAndRange(tenantId: string, start: Date, end: Date): Promise<Appointment[]>;
  listByTenant(tenantId: string, limit?: number, offset?: number): Promise<Appointment[]>;

  // ── Writes ─────────────────────────────────────────────────
  create(data: AppointmentCreateData, txClient?: TransactionClient): Promise<Appointment>;
  updateStatus(id: string, tenantId: string, status: AppointmentStatus, txClient?: TransactionClient): Promise<Appointment | null>;
  updateExternalEventId(id: string, externalEventId: string): Promise<void>;
}

// Supporting types
interface AppointmentCreateData {
  tenant_id: string;
  client_name: string;
  client_email: string;
  client_notes?: string;
  service?: string;
  start_time: Date;
  end_time: Date;
  timezone: string;
  external_event_id?: string;  // Google Calendar event ID or Excel row ref
  source_hold_id?: string;
}

type TransactionClient = unknown;  // pg.PoolClient in Postgres; no-op in Excel-direct
```

### 2.3 ExcelSyncAdapter (Option B — Hybrid)

This is a **decorator** over `PostgresBookingStore`, not a replacement:

```
┌──────────────────────────────────────────────────────────┐
│  ExcelSyncAdapter implements BookingStore                  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  inner: PostgresBookingStore   (all reads & writes) │  │
│  └───────────────────────┬─────────────────────────────┘  │
│                          │                                │
│  On every write:         │                                │
│    1. Delegate to inner  │                                │
│    2. On success → emit  │                                │
│       sync event         │                                │
│                          ▼                                │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  ExcelSyncWorker                                    │  │
│  │    - Consumes events from in-process EventEmitter   │  │
│  │    - Translates Appointment → Excel row             │  │
│  │    - Calls Graph API                                │  │
│  │    - Retries on failure                             │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  ExcelIngestWorker                                  │  │
│  │    - Polls Excel via ETag / webhook                 │  │
│  │    - Diffs against Postgres                         │  │
│  │    - Applies admin changes (DB wins on conflict)    │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 2.4 Method-by-method mapping

| BookingStore method      | ExcelSyncAdapter behavior                                                                                      |
|--------------------------|----------------------------------------------------------------------------------------------------------------|
| `findById()`             | Delegate to `inner.findById()`. No Excel involvement. Reads always from Postgres.                              |
| `findByReference()`      | Delegate to `inner.findByReference()`. No Excel involvement.                                                   |
| `findByEmail()`          | Delegate to `inner.findByEmail()`. No Excel involvement.                                                       |
| `findBySourceHold()`     | Delegate to `inner.findBySourceHold()`. No Excel involvement.                                                  |
| `listByTenantAndRange()` | Delegate to `inner.listByTenantAndRange()`. No Excel involvement.                                              |
| `listByTenant()`         | Delegate to `inner.listByTenant()`. No Excel involvement.                                                      |
| `create()`               | 1) Delegate to `inner.create()`. 2) On success → `syncEmitter.emit('booking.created', appointment)`.          |
| `updateStatus()`         | 1) Delegate to `inner.updateStatus()`. 2) On success → `syncEmitter.emit('booking.statusChanged', result)`.   |
| `updateExternalEventId()`| Delegate to `inner.updateExternalEventId()`. No sync needed (this is metadata).                                |

**Key principle:** All reads hit Postgres (sub-5ms). All writes commit to Postgres first (SERIALIZABLE), then async-sync to Excel. The AI agent's response latency is unaffected.

### 2.5 How it plugs into the existing code

The refactoring surface is small because `bookingService` is the only consumer of `appointmentRepo`:

```
BEFORE:
  bookingService → appointmentRepo (concrete, raw SQL)

AFTER:
  bookingService → bookingStore: BookingStore
                     ├── PostgresBookingStore   (wraps appointmentRepo — default)
                     └── ExcelSyncAdapter       (wraps PostgresBookingStore + sync)

SELECTION:
  Factory function reads tenant config:
    if (tenant.excel_integration?.enabled)  → ExcelSyncAdapter
    else                                     → PostgresBookingStore
```

The `tool-executor.ts` and `voice-tool-executor.ts` **require zero changes**. They call `bookingService`, which internally resolves the store.

---

## 3. Concurrency Strategy

### 3.1 The invariant we must preserve

> **No double-booking, ever.** If the AI bot confirms a booking, it cannot be
> silently overwritten by an admin saving an Excel file 3 seconds later.

### 3.2 Locking approach: Postgres remains source of truth

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CONCURRENCY MODEL                                │
│                                                                      │
│  WRITE PATH: AI Bot books a slot                                     │
│  ─────────────────────────────────                                   │
│  1. hold_slot  → holdRepo.create() with EXCLUDE constraint           │
│  2. confirm    → bookingService.confirmBooking()                     │
│     a. SERIALIZABLE transaction                                      │
│     b. pg_advisory_xact_lock on tenant+slot hash                     │
│     c. EXCLUDE constraint on (tenant_id, start_time, end_time)       │
│     d. COMMIT                                                        │
│  3. Post-commit → ExcelSyncWorker pushes row to Excel (async)        │
│                                                                      │
│  Excel is NOT consulted during the write. Zero latency impact.       │
│  Zero concurrency risk from Graph API.                               │
│                                                                      │
│  WRITE PATH: Admin edits Excel                                       │
│  ───────────────────────────────                                     │
│  1. Admin changes cell in Excel Desktop / Web                        │
│  2. SharePoint webhook or polling detects change (≤30s)              │
│  3. ExcelIngestWorker reads full Appointments sheet                  │
│  4. Diffs against Postgres:                                          │
│     a. New row in Excel → Validate → INSERT in Postgres              │
│        - Run through SERIALIZABLE + EXCLUDE                          │
│        - If slot already booked → REJECT + write-back DB version     │
│     b. Modified row → Validate → UPDATE in Postgres                  │
│        - Check version column: if DB.version > Excel.version → REJECT│
│     c. Deleted row → Validate → Cancel in Postgres                   │
│        - Only if status is still 'confirmed'                         │
│  5. On conflict → DB wins. Excel cell highlighted red + comment.     │
│                                                                      │
│  CONFLICT RESOLUTION: DATABASE ALWAYS WINS                           │
│  ─────────────────────────────────────────                           │
│  The bot operates at sub-second velocity. Admin operates at human    │
│  velocity. In the 30-second sync window, the bot may have already    │
│  booked the slot the admin is trying to claim. DB wins because:      │
│    • It has ACID guarantees                                          │
│    • It enforces the EXCLUDE constraint                              │
│    • The client was already told "confirmed"                         │
│    • Rolling back a confirmed booking is a UX disaster               │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 How we guarantee no double-booking even with "eventually consistent" Excel

```
GUARANTEE CHAIN:

1. EXCLUDE constraint on appointments table
   → Physical impossibility of overlapping time ranges per tenant in Postgres
   → Even if two transactions race, one gets 23P01 exclusion violation

2. Advisory lock (pg_advisory_xact_lock)
   → Serializes concurrent bookings for the same tenant+slot combination
   → Prevents phantom reads during the hold→appointment promotion

3. SERIALIZABLE isolation level
   → Detects read-then-write anomalies across concurrent transactions
   → Aborts and retries on serialization failure

4. Excel sync is OUTBOUND-ONLY during bot writes
   → Graph API is called AFTER commit, never during
   → If Graph API is down, booking is still confirmed in DB
   → Excel sync can lag hours and the data is never inconsistent

5. Excel inbound changes are VALIDATED against Postgres
   → Admin adds a booking at 2pm? Postgres checks EXCLUDE first.
   → Admin cancels a bot booking? Only if it hasn't been rescheduled since.
   → Every inbound change runs through the same SERIALIZABLE path.

RESULT: Double-booking is impossible because no write path bypasses Postgres.
Excel is a VIEW with eventual consistency, not a database.
```

### 3.4 Version tracking for conflict detection

Every appointment row in Postgres gets a `sync_version` column:

```
ALTER TABLE appointments ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE appointments ADD COLUMN excel_row_ref TEXT;           -- e.g., "Appointments!A15"
ALTER TABLE appointments ADD COLUMN last_synced_at TIMESTAMPTZ;
```

Every write to Postgres increments `sync_version`. The sync worker writes
this version into the Excel `Ver` column. When the ingest worker reads Excel,
it compares `Ver` values:

```
if excel_row.ver < db_row.sync_version:
    # Excel is stale — write-back the DB version (admin's change is outdated)
    rejectAndWriteBack(db_row)
elif excel_row.ver == db_row.sync_version:
    # Excel has the latest — admin's change is valid, apply it
    applyAdminChange(excel_row)
elif excel_row.ver > db_row.sync_version:
    # Should never happen (version is server-generated)
    flagAnomaly(excel_row)
```

### 3.5 ETag strategy for change detection

```
ExcelIngestWorker loop:

1. GET /drives/{driveId}/items/{fileId}
   Header: If-None-Match: "{last_known_etag}"

2. Response:
   304 Not Modified → sleep(30s), loop
   200 OK → file changed, extract new ETag

3. GET /drives/{driveId}/items/{fileId}/workbook/worksheets('Appointments')/usedRange
   Header: workbook-session-id: {sessionId}  (short-lived, read-only)

4. Parse rows → diff → apply → update last_known_etag

Note: ETag is FILE-level. Any cell change (even Config sheet) triggers a
re-read. This is acceptable because we only diff the Appointments sheet
and skip unchanged rows via sync_version comparison.
```

---

## 4. Data Format

### 4.1 Required columns — Appointments sheet

| Column | Excel Header       | Type       | Validation                              | Maps to DB column     |
|--------|--------------------|------------|----------------------------------------|----------------------|
| A      | `Appt ID`          | String     | `APT-[A-Z0-9]{6}`, unique              | `reference_code`     |
| B      | `Date`             | Date       | `YYYY-MM-DD`, not in past (for new)     | derived from `start_time` |
| C      | `Start Time`       | Time       | `HH:MM` (24h), valid against biz hours | derived from `start_time` |
| D      | `End Time`         | Time       | `HH:MM` (24h), `End > Start`           | derived from `end_time`   |
| E      | `Service`          | String     | Must match tenant's service list        | `service`            |
| F      | `Client Name`      | String     | Non-empty, max 200 chars               | `client_name`        |
| G      | `Client Email`     | String     | Valid email format                      | `client_email`       |
| H      | `Client Phone`     | String     | Optional, E.164 if present             | (future column)      |
| I      | `Notes`            | String     | Optional, max 500 chars                | `client_notes`       |
| J      | `Status`           | Enum       | `confirmed\|cancelled\|completed\|no_show` | `status`         |
| K      | `Booked By`        | String     | `ai-bot\|admin\|phone` (read-only)     | `actor` (from audit) |
| L      | `Created At`       | DateTime   | ISO-8601 (read-only, system-set)       | `created_at`         |
| M      | `Modified At`      | DateTime   | ISO-8601 (read-only, system-set)       | `updated_at`         |
| N      | `Ver`              | Integer    | System-managed, DO NOT EDIT            | `sync_version`       |
| O      | `DB ID`            | String     | UUID (hidden column, system-managed)   | `id`                 |

### 4.2 Example rows

```
┌───────────┬────────────┬───────┬───────┬──────────────┬──────────────┬─────────────────┬─────────┬───────┬───────────┬──────────┬──────────────────────┬──────────────────────┬─────┬──────────────────────────────────────┐
│ Appt ID   │ Date       │ Start │ End   │ Service      │ Client Name  │ Client Email    │ Phone   │ Notes │ Status    │ Booked By│ Created At           │ Modified At          │ Ver │ DB ID                                │
├───────────┼────────────┼───────┼───────┼──────────────┼──────────────┼─────────────────┼─────────┼───────┼───────────┼──────────┼──────────────────────┼──────────────────────┼─────┼──────────────────────────────────────┤
│ APT-7X3M9K│ 2026-02-10 │ 14:00 │ 15:00 │ Deep Tissue  │ Alex Morrison│ alex@email.com  │ +155512│       │ confirmed │ ai-bot   │ 2026-02-05T14:23:00Z │ 2026-02-05T14:23:00Z │ 1   │ f47ac10b-58cc-4372-a567-0e02b2c3d479 │
│ APT-4R8T2W│ 2026-02-08 │ 13:00 │ 13:30 │ Facial Treat │ Jennifer Wu  │ jen@gmail.com   │         │       │ cancelled │ ai-bot   │ 2026-02-05T15:00:00Z │ 2026-02-05T15:01:00Z │ 3   │ 6ba7b810-9dad-11d1-80b4-00c04fd430c8 │
│ APT-M2N5P8│ 2026-02-12 │ 09:00 │ 09:30 │ General Cons │ Sarah Park   │ spark@work.com  │         │ New pt│ confirmed │ admin    │ 2026-02-06T08:15:00Z │ 2026-02-06T08:15:00Z │ 1   │ 550e8400-e29b-41d4-a716-446655440000 │
└───────────┴────────────┴───────┴───────┴──────────────┴──────────────┴─────────────────┴─────────┴───────┴───────────┴──────────┴──────────────────────┴──────────────────────┴─────┴──────────────────────────────────────┘
```

### 4.3 Schema validation rules (enforced on every ingest)

```
HARD FAIL (reject entire ingest if violated):
  1. Header row mismatch — any required column missing or renamed
  2. Appt ID format invalid — not matching /^APT-[A-Z0-9]{6}$/
  3. Date or time unparseable
  4. Status not in allowed enum

SOFT FAIL (reject row, continue processing others):
  1. Email format invalid
  2. Service name not in tenant's configured list
  3. End ≤ Start
  4. Date in past (for new bookings only; existing can be historical)
  5. Overlap with another confirmed booking (EXCLUDE would catch it anyway)

IGNORED CHANGES (silently skipped):
  1. Read-only columns modified (Created At, Modified At, Ver, DB ID, Booked By)
     → Overwritten with DB values on next sync cycle
```

### 4.4 Availability sheet (optional — read-only mirror)

```
┌────────────┬───────┬───────┬──────────┬──────────────┐
│ Date       │ Start │ End   │ Status   │ Held By      │
├────────────┼───────┼───────┼──────────┼──────────────┤
│ 2026-02-10 │ 09:00 │ 09:30 │ open     │              │
│ 2026-02-10 │ 09:30 │ 10:00 │ held     │ (bot session)│
│ 2026-02-10 │ 14:00 │ 15:00 │ booked   │ APT-7X3M9K   │
└────────────┴───────┴───────┴──────────┴──────────────┘

This sheet is FULLY GENERATED by the sync worker. Admin edits are IGNORED.
It exists purely as a visual reference so admins can see what's free.
Regenerated on every outbound sync cycle.
```

### 4.5 Config sheet (read by server on startup / refresh)

```
┌─────────────────────┬──────────────────────────────┐
│ Key                 │ Value                        │
├─────────────────────┼──────────────────────────────┤
│ business_name       │ Bloom Wellness Studio         │
│ timezone            │ America/New_York             │
│ slot_duration_min   │ 30                           │
│ hold_ttl_min        │ 5                            │
│ mon_start           │ 09:00                        │
│ mon_end             │ 18:00                        │
│ tue_start           │ 09:00                        │
│ tue_end             │ 18:00                        │
│ ...                 │ ...                          │
│ sun_start           │ CLOSED                       │
└─────────────────────┴──────────────────────────────┘

This sheet is READ by the ExcelIngestWorker to detect admin config changes.
Changes are validated and applied to the tenant record in Postgres.
Invalid values (e.g., "banana" for timezone) are rejected with a comment.
```

---

## 5. Failure Handling

### 5.1 Outbound sync failures (DB → Excel)

```
SCENARIO: Bot confirms booking, but Graph API is unreachable.

┌──────────────────────────────────────────────────────────────────┐
│ ExcelSyncWorker failure pipeline                                  │
│                                                                   │
│ Attempt 1: Graph API call                                         │
│   → 5xx / timeout / network error                                 │
│   → Mark sync_status = 'pending' on appointment row              │
│   → Schedule retry in 2s                                          │
│                                                                   │
│ Attempt 2: Retry (backoff 2s)                                     │
│   → Same error                                                    │
│   → Schedule retry in 8s                                          │
│                                                                   │
│ Attempt 3: Retry (backoff 8s)                                     │
│   → Same error                                                    │
│   → Mark sync_status = 'failed'                                  │
│   → Insert into sync_dead_letter table:                           │
│     { appointment_id, operation, error, failed_at, attempts: 3 }  │
│   → Log warning: "Excel sync failed for APT-XXXXXX"             │
│                                                                   │
│ Recovery:                                                         │
│   → Reconciliation job (runs every 5 min):                        │
│     SELECT * FROM appointments                                    │
│     WHERE sync_status = 'failed'                                  │
│     AND updated_at > now() - interval '24 hours'                 │
│     → Re-attempt sync for each                                    │
│     → After 24h with no success → alert admin                    │
│                                                                   │
│ IMPORTANT: The booking IS confirmed in Postgres.                  │
│ The client has their reference code. Only the Excel mirror lags.  │
│ This is a cosmetic issue, not a data integrity issue.             │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 Inbound sync failures (Excel → DB)

```
SCENARIO: Admin adds a row in Excel, but it violates business rules.

┌──────────────────────────────────────────────────────────────────┐
│ ExcelIngestWorker failure pipeline                                │
│                                                                   │
│ 1. Parse failure (unparseable date, missing required field):     │
│    → Skip row                                                     │
│    → Write Excel comment on cell A{row}:                          │
│      "⚠️ Sync error: Invalid date format. Expected YYYY-MM-DD."  │
│    → Highlight row YELLOW                                         │
│    → Log: { row, error, timestamp }                               │
│                                                                   │
│ 2. Business rule violation (overlap, past date, unknown service): │
│    → Skip row                                                     │
│    → Write Excel comment:                                         │
│      "⚠️ Conflict: This slot is already booked (APT-XXXXXX)."   │
│    → Highlight row RED                                            │
│    → Log: { row, conflicting_appointment_id, timestamp }          │
│                                                                   │
│ 3. Version conflict (admin edited a row the bot just updated):   │
│    → DB wins — overwrite Excel row with DB values                 │
│    → Write Excel comment:                                         │
│      "⚠️ Overwritten: Bot updated this at {time}. Your change    │
│       was reverted."                                              │
│    → Highlight row ORANGE                                         │
│    → Log: { row, db_version, excel_version, timestamp }           │
│                                                                   │
│ 4. Graph API error during write-back:                             │
│    → Queue for retry (same 3-attempt pipeline as outbound)       │
│    → The DB state is correct; only the Excel visual is stale     │
└──────────────────────────────────────────────────────────────────┘
```

### 5.3 Partial writes

```
SCENARIO: Outbound sync of 5 new bookings, #3 fails mid-batch.

STRATEGY: Individual row operations, not batch.

Each booking is synced independently:
  ✅ APT-1 → Excel row written
  ✅ APT-2 → Excel row written
  ❌ APT-3 → Graph API error → queued for retry
  ✅ APT-4 → Excel row written  (continues despite #3 failing)
  ✅ APT-5 → Excel row written

Result: 4/5 visible in Excel immediately. #3 appears after retry.
No transaction rollback of the other 4 — each is independent.

WHY NOT BATCH: Graph API batch requests (POST /$batch) are limited to
20 requests per batch and failures are hard to attribute to specific rows.
Individual operations give us precise error handling per booking.
```

### 5.4 Reconciliation job

```
PURPOSE: Catch any drift between Postgres and Excel that wasn't handled
by the real-time sync (missed webhooks, crashed worker, etc.).

SCHEDULE: Every 5 minutes (configurable per tenant)

ALGORITHM:
  1. Read all 'confirmed' appointments from Postgres for tenant
     WHERE updated_at > last_reconciliation_at
  2. Read full Appointments sheet from Excel
  3. Build maps: db_by_ref_code, excel_by_ref_code
  4. For each DB appointment:
     a. If missing from Excel → push to Excel (outbound sync missed)
     b. If present but differs → compare sync_version
        - DB version higher → overwrite Excel
        - Equal versions, content differs → admin changed it, apply inbound rules
  5. For each Excel row NOT in DB:
     a. New admin-added booking → validate + insert into Postgres
     b. Or: orphaned row (DB booking was deleted) → mark row as "removed" in Excel
  6. Update last_reconciliation_at

SAFETY: Reconciliation runs inside SERIALIZABLE transactions.
         It cannot create double-bookings because the same EXCLUDE constraint applies.
```

### 5.5 New DB columns for sync state

```sql
-- Appointment sync tracking
ALTER TABLE appointments
  ADD COLUMN sync_version   INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN sync_status    VARCHAR(20)  NOT NULL DEFAULT 'synced',  -- synced | pending | failed
  ADD COLUMN excel_row_ref  TEXT,                                     -- e.g., "15" (row number)
  ADD COLUMN last_synced_at TIMESTAMPTZ;

-- Sync dead letter queue
CREATE TABLE sync_dead_letter (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  appointment_id UUID REFERENCES appointments(id),
  operation     VARCHAR(20) NOT NULL,  -- create | update | delete
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  first_failed  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved      BOOLEAN NOT NULL DEFAULT false,
  resolved_at   TIMESTAMPTZ
);

-- Tenant Excel config
ALTER TABLE tenants
  ADD COLUMN excel_integration JSONB;
  -- {
  --   "enabled": true,
  --   "drive_id": "b!XXXXX",
  --   "file_id": "01XXXXXX",
  --   "sheet_name": "Appointments",
  --   "last_etag": "\"abc123\"",
  --   "last_reconciliation_at": "2026-02-06T00:00:00Z",
  --   "sync_interval_seconds": 30,
  --   "auth_tokens": { "access_token": "...", "refresh_token": "...", "expires_at": "..." }
  -- }
```

---

## 6. MVP Recommendation

### 6.1 Safest first release: Outbound-Only Sync

For MVP, implement **only the DB → Excel direction**. Do not attempt
inbound sync (Excel → DB) in the first release.

```
MVP SCOPE (Phase 1):
  ✅ ExcelSyncAdapter decorator over PostgresBookingStore
  ✅ Outbound sync: every booking.created / statusChanged → push to Excel
  ✅ Graph API client with retry + dead letter
  ✅ Reconciliation job (outbound only — push missing rows)
  ✅ Availability sheet generation (read-only mirror)
  ✅ Microsoft Entra ID OAuth flow for tenant Excel access
  ✅ Admin UI: "Connect Excel" button in tenant settings
  ✅ Excel file template auto-creation on first connect

  ❌ NOT in MVP: Inbound sync (admin Excel edits → DB)
  ❌ NOT in MVP: Config sheet reading
  ❌ NOT in MVP: SharePoint webhooks (polling only)
  ❌ NOT in MVP: Conflict resolution / visual highlighting
```

### 6.2 Why outbound-only is safest

| Risk                                    | Outbound-only | Full bidirectional |
|-----------------------------------------|---------------|--------------------|
| Double-booking from admin Excel edit     | Impossible    | Possible if bug in ingest |
| Schema drift from admin reformatting     | No impact     | Breaks inbound parsing |
| Co-authoring conflict                    | Rare (write-after-commit) | Frequent |
| Graph API rate limit impact              | Low (write-only) | High (read + write) |
| Development complexity                   | ~1 week       | ~3–4 weeks |
| Testing complexity                       | Unit + integration | + E2E with real Excel |
| Rollback safety                          | Remove adapter, data intact | Must freeze Excel edits |

### 6.3 What admin sees in MVP

```
MVP Admin Experience:
  1. Admin clicks "Connect Excel" in tenant settings
  2. Microsoft Entra ID consent flow → grants Files.ReadWrite access
  3. Server creates "Bloom_Appointments.xlsx" in their OneDrive/SharePoint
  4. Every booking made by the AI bot appears in Excel within ~5 seconds
  5. Admin can VIEW, SORT, FILTER, PRINT, EXPORT — full Excel power
  6. Admin CANNOT edit bookings via Excel (changes will be overwritten)
  7. To edit bookings, admin uses the web dashboard (existing) or calls in

MVP Limitation (documented to admin):
  "Excel is a read-only mirror of your bookings. Changes made directly
   in Excel will be overwritten by the next sync cycle. To modify bookings,
   use the admin dashboard. Full two-way sync coming in a future update."
```

### 6.4 Phase 2 additions (post-MVP)

```
Phase 2: Inbound Sync
  - ExcelIngestWorker with polling (30s)
  - Row-level diff engine
  - Version-based conflict detection
  - Conflict visualization (red highlighting + comments)
  - Soft-delete detection (admin deletes row)

Phase 3: Real-time + Config
  - SharePoint webhooks for near-instant inbound sync
  - Config sheet reading (admin changes business hours in Excel)
  - Availability sheet becomes editable (admin blocks time off)
  - _Locks sheet for direct-to-Excel tenants (Option A support)

Phase 4: Multi-file + Scale
  - Archive sheet (auto-move rows older than 90 days)
  - Multiple Excel files per tenant (e.g., per-location)
  - Batch Graph API operations for high-volume tenants
```

---

## 7. Migration Plan

### 7.1 Refactoring steps (ordered)

```
STEP 1: Extract BookingStore interface (non-breaking)
  File: src/domain/interfaces.ts (new)
  - Define BookingStore interface
  - Define AppointmentCreateData type
  - Export TransactionClient type alias

STEP 2: Create PostgresBookingStore (wraps existing appointmentRepo)
  File: src/stores/postgres-booking-store.ts (new)
  - Implements BookingStore
  - Delegates every method to appointmentRepo (1:1 mapping)
  - Add sync_version increment on every write
  - Zero behavior change — this is a structural refactor

STEP 3: Create BookingStore factory
  File: src/stores/booking-store-factory.ts (new)
  - getBookingStore(tenant: Tenant): BookingStore
  - Returns PostgresBookingStore if no Excel integration
  - Returns ExcelSyncAdapter if tenant.excel_integration.enabled

STEP 4: Wire bookingService to use factory
  File: src/services/booking.service.ts (modify)
  - Replace direct appointmentRepo imports with factory calls
  - bookingService methods receive tenantId → resolve store → delegate
  - Run full test suite — behavior must be identical

STEP 5: DB migration for sync columns
  File: src/db/migrations/XXX_add_excel_sync_columns.sql (new)
  - Add sync_version, sync_status, excel_row_ref, last_synced_at to appointments
  - Add excel_integration JSONB to tenants
  - Create sync_dead_letter table
  - All columns have defaults — no breaking change to existing data

STEP 6: Implement Graph API client
  File: src/integrations/graph-api-client.ts (new)
  - Microsoft Graph API wrapper
  - Auth: Entra ID OAuth 2.0 token management (refresh, cache)
  - Methods: createSession, readRange, patchRow, addRow, closeSession
  - Retry: 3 attempts, exponential backoff, 429 Retry-After support
  - Rate limiter: per-tenant token bucket (configurable)

STEP 7: Implement ExcelSyncWorker (outbound)
  File: src/integrations/excel-sync-worker.ts (new)
  - Listens to sync events from ExcelSyncAdapter
  - Translates Appointment → Excel row format
  - Calls Graph API client to upsert row
  - Handles failures → sync_dead_letter

STEP 8: Implement ExcelSyncAdapter (decorator)
  File: src/stores/excel-sync-adapter.ts (new)
  - Implements BookingStore
  - Wraps PostgresBookingStore
  - Emits events on write methods
  - Reads delegate entirely to inner store

STEP 9: Implement reconciliation job
  File: src/jobs/excel-reconciliation.ts (new)
  - Runs on interval (setInterval, unref'd)
  - Outbound-only for MVP: push missing rows to Excel
  - Tenant-scoped: only runs for tenants with Excel enabled

STEP 10: Add Microsoft OAuth routes + tenant config UI
  Files: src/routes/microsoft-oauth.routes.ts (new), tenant admin UI updates
  - Entra ID consent flow (similar to existing Google OAuth pattern)
  - Store refresh token in tenant.excel_integration.auth_tokens
  - Excel file creation on first connect

STEP 11: Integration tests
  - Mock Graph API (similar to how we mock Google Calendar)
  - Test: booking → verify sync event emitted → verify Excel row shape
  - Test: sync failure → verify dead letter → verify reconciliation recovery
  - Test: concurrent booking + sync → verify no race conditions
```

### 7.2 Dependency graph

```
Steps 1–4 are structural refactoring (no new features, no new deps)
  → Can be done and shipped as a "refactor PR" with zero risk

Step 5 is a DB migration (additive, no breaking changes)
  → Ships alongside Step 4

Steps 6–8 are the core Excel integration
  → Requires: @microsoft/microsoft-graph-client or raw fetch
  → Requires: Microsoft Entra ID app registration in tenant's M365

Step 9 is the safety net
  → Requires Steps 7–8

Step 10 is the admin experience
  → Requires Steps 6, 8

Step 11 validates everything
  → Runs after all steps

Minimum shippable unit: Steps 1–8 (with 6–8 behind feature flag)
```

### 7.3 Feature flag

```
Tenant-level flag in tenant.excel_integration.enabled:

  if (tenant.excel_integration?.enabled) {
    // Use ExcelSyncAdapter
  } else {
    // Use PostgresBookingStore (current behavior, zero changes)
  }

Global kill switch in env:
  EXCEL_INTEGRATION_GLOBAL_ENABLED=false  (default)

Both must be true for any Excel sync to occur. This allows:
  - Deploying the code without activating it
  - Enabling per-tenant for gradual rollout
  - Emergency disable via env var (no redeploy needed)
```

### 7.4 Estimated effort

| Step | Description                          | Estimate |
|------|--------------------------------------|----------|
| 1–4  | Interface extraction + factory       | 1 day    |
| 5    | DB migration                         | 0.5 day  |
| 6    | Graph API client                     | 2 days   |
| 7    | ExcelSyncWorker (outbound)           | 1.5 days |
| 8    | ExcelSyncAdapter (decorator)         | 0.5 day  |
| 9    | Reconciliation job                   | 1 day    |
| 10   | Microsoft OAuth + admin UI           | 1.5 days |
| 11   | Integration tests                    | 1.5 days |
|      | **Total MVP (outbound-only)**        | **~10 days** |
|      | Phase 2: Inbound sync                | +5 days  |
|      | Phase 3: Webhooks + Config           | +3 days  |

---

## Appendix: Decision Summary

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | Postgres remains source of truth (Option B Hybrid) | Preserves SERIALIZABLE + EXCLUDE + advisory locks. Zero regression risk. |
| A2 | Decorator pattern (not replacement) | ExcelSyncAdapter wraps PostgresBookingStore. Reads never touch Excel. |
| A3 | MVP is outbound-only | Eliminates all inbound sync risks: schema drift, co-authoring, version conflicts. |
| A4 | DB-wins conflict resolution | Bot confirmations are irrevocable. Admin changes are slower and reviewable. |
| A5 | Individual row sync (not batch) | Precise error handling per booking. Batch failures are hard to attribute. |
| A6 | Feature flag per tenant + global | Safe rollout. Emergency disable without redeploy. |
| A7 | Reconciliation job as safety net | Catches drift from missed events, crashed workers, API outages. |
| A8 | BookingStore interface extracted first | Structural refactor ships separately, de-risks the integration work. |
