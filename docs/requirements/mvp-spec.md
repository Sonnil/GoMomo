# gomomo.ai — MVP Product Specification

> Project: prj-20260205-001 | Version: 1.0.0 | Date: 2026-02-05

---

## 1. Vision

A virtual AI receptionist that lets end-users book, reschedule, and cancel
appointments through a web chat widget. The system integrates with Google
Calendar to guarantee zero double-bookings.

## 2. Users

| Persona | Description |
|---|---|
| **End-User** | Anyone visiting the tenant's website who wants to book an appointment |
| **Tenant Admin** | Business owner who configures the receptionist (hours, services, calendar) |

## 3. Core Flows

### 3.1 Book Appointment
1. User opens chat widget
2. AI greets user, asks what service they need
3. AI calls `check_availability` tool → shows available slots
4. User picks a slot → AI calls `hold_slot` tool (5-min TTL)
5. AI collects name, email, notes
6. AI calls `confirm_booking` tool → backend commits to DB + Google Calendar
7. AI confirms with details (date, time, timezone)

### 3.2 Reschedule Appointment
1. User provides booking reference or email
2. AI calls `lookup_booking` tool → retrieves existing booking
3. AI calls `check_availability` tool → shows new slots
4. User picks new slot → AI calls `reschedule_booking` tool
5. Backend: cancel old GCal event → hold new slot → commit new → release old
6. AI confirms new details

### 3.3 Cancel Appointment
1. User provides booking reference or email
2. AI calls `lookup_booking` tool → retrieves existing booking
3. AI confirms cancellation intent
4. AI calls `cancel_booking` tool → backend removes from DB + GCal
5. AI confirms cancellation

## 4. Non-Negotiable Constraints

| # | Constraint | Implementation |
|---|---|---|
| 1 | No overbooking | AvailabilityHold with 5-min TTL; DB EXCLUDE constraint; atomic flow |
| 2 | Deterministic AI | Tool-based only; never claim success without backend confirmation |
| 3 | Timezone-safe | IANA timezones stored on tenant; all API I/O in ISO-8601 with offset |
| 4 | Multi-tenant | Tenant ID on every record; scoped queries; per-tenant OAuth tokens |
| 5 | Auditability | `audit_log` table with event_type, entity, payload, timestamp |

## 5. Out of Scope (MVP)

- Phone/voice channel
- Excel/CSV integration
- Payment processing
- Reminders/notifications
- Marketing/analytics

## 6. Success Criteria

- [ ] End-user can book via chat in <60 seconds
- [ ] No double-booking under concurrent load
- [ ] Booking appears on Google Calendar within 5 seconds
- [ ] System handles 10 concurrent chat sessions per tenant
- [ ] Runs locally with `docker compose up`
