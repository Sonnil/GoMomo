# gomomo.ai — System Architecture

> Project: prj-20260205-001 | Version: 1.0.0 | Date: 2026-02-05

---

## 1. System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        BROWSER                                   │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐ │
│  │  Admin Dashboard  │  │  Embeddable Chat Widget (React)      │ │
│  │  /admin           │  │  <script src="widget.js"/>           │ │
│  └────────┬─────────┘  └────────────────┬─────────────────────┘ │
└───────────┼─────────────────────────────┼───────────────────────┘
            │ REST                        │ WebSocket (Socket.IO)
            ▼                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FASTIFY API SERVER                             │
│                    (Node.js / TypeScript)                         │
│                                                                   │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────────────┐ │
│  │ REST Routes  │ │  WS Handler  │ │  Background Workers       │ │
│  │             │ │              │ │  - Hold expiry cleanup     │ │
│  │ /api/v1/    │ │ /chat        │ │  - Calendar sync           │ │
│  └──────┬──────┘ └──────┬───────┘ └───────────┬───────────────┘ │
│         │               │                     │                   │
│         ▼               ▼                     ▼                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                   SERVICE LAYER                             │  │
│  │                                                             │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌───────────────────┐  │  │
│  │  │ BookingService│ │AvailService  │ │ TenantService     │  │  │
│  │  │              │ │              │ │                    │  │  │
│  │  │ book()       │ │ getSlots()   │ │ getConfig()       │  │  │
│  │  │ reschedule() │ │ holdSlot()   │ │ getOAuthTokens()  │  │  │
│  │  │ cancel()     │ │ releaseHold()│ │                    │  │  │
│  │  └──────┬───────┘ └──────┬───────┘ └───────┬───────────┘  │  │
│  │         │               │                   │               │  │
│  │         ▼               ▼                   ▼               │  │
│  │  ┌────────────────────────────────────────────────────┐    │  │
│  │  │              REPOSITORY LAYER (pg)                  │    │  │
│  │  │  AppointmentRepo | HoldRepo | TenantRepo | AuditLog│    │  │
│  │  └────────────────────────┬───────────────────────────┘    │  │
│  └───────────────────────────┼────────────────────────────────┘  │
│                              │                                    │
│  ┌───────────────────────────┼────────────────────────────────┐  │
│  │         AI AGENT LAYER    │                                 │  │
│  │                           │                                 │  │
│  │  ┌─────────────────────┐  │  ┌──────────────────────────┐  │  │
│  │  │ ReceptionistAgent   │  │  │  Tool Definitions        │  │  │
│  │  │                     │──┼──│  check_availability      │  │  │
│  │  │ System prompt       │  │  │  hold_slot               │  │  │
│  │  │ Conversation state  │  │  │  confirm_booking         │  │  │
│  │  │ Tool execution      │  │  │  lookup_booking          │  │  │
│  │  └─────────────────────┘  │  │  reschedule_booking      │  │  │
│  │                           │  │  cancel_booking          │  │  │
│  └───────────────────────────┘  └──────────────────────────┘  │  │
│                                                                   │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          ┌─────────────────┐    ┌──────────────────┐
          │   PostgreSQL    │    │  Google Calendar  │
          │                 │    │  API (v3)         │
          │ tenants         │    │                   │
          │ appointments    │    │  - Create event   │
          │ availability_   │    │  - Update event   │
          │   holds         │    │  - Delete event   │
          │ audit_log       │    │  - List events    │
          │ chat_sessions   │    │                   │
          └─────────────────┘    └──────────────────┘
```

## 2. Key Design Decisions

### 2.1 Availability Hold Algorithm

```
1. Client requests slot → API checks DB + Google Calendar for conflicts
2. If free → INSERT availability_hold (slot, tenant, session, expires_at=now+5min)
   - DB EXCLUDE constraint prevents overlapping holds for same tenant
3. Hold exists → user provides details → API commits booking
4. INSERT appointment (within transaction):
   a. Verify hold still valid (not expired)
   b. Insert appointment with EXCLUDE constraint (no overlap)
   c. Delete the hold
   d. Create Google Calendar event
   e. If GCal fails → rollback transaction
   f. Log audit event
5. Background job: DELETE expired holds every 60 seconds
```

### 2.2 Concurrency Safety

| Layer | Mechanism |
|---|---|
| DB: holds | `EXCLUDE USING gist` on `(tenant_id, tstzrange(start_time, end_time))` |
| DB: appointments | `EXCLUDE USING gist` on `(tenant_id, tstzrange(start_time, end_time))` with `status != cancelled` |
| Application | Serializable transaction for hold→book flow |
| Calendar | Optimistic: create event, check for conflicts, rollback if conflict |

### 2.3 Multi-Tenancy

- `tenant_id` column on every business table
- Tenant-scoped queries enforced at repository layer
- OAuth refresh tokens encrypted at rest per tenant
- Tenant config: business hours, slot duration, timezone, services

### 2.4 AI Agent Architecture

- **Deterministic**: Agent MUST use tools for every data operation
- **Stateless per message**: conversation history maintained server-side
- **Tool results drive responses**: Agent never fabricates availability or confirmation
- **Error propagation**: tool failures become explicit agent messages ("I couldn't complete that")

## 3. Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5+ |
| HTTP Framework | Fastify |
| WebSocket | Socket.IO (via fastify-socket.io) |
| Database | PostgreSQL 16 with btree_gist extension |
| ORM/Query | Raw SQL via pg (node-postgres) |
| AI | OpenAI-compatible API (tool calling) |
| Calendar | Google Calendar API v3 (googleapis) |
| Frontend | React 18 + Vite |
| Containerization | Docker + Docker Compose |

## 4. API Overview

| Method | Path | Description |
|---|---|---|
| POST | /api/v1/tenants | Create tenant |
| GET | /api/v1/tenants/:id | Get tenant config |
| PUT | /api/v1/tenants/:id | Update tenant config |
| GET | /api/v1/tenants/:id/availability | Get available slots |
| POST | /api/v1/tenants/:id/appointments | Book appointment |
| GET | /api/v1/tenants/:id/appointments/:aid | Get appointment |
| PUT | /api/v1/tenants/:id/appointments/:aid | Reschedule |
| DELETE | /api/v1/tenants/:id/appointments/:aid | Cancel |
| GET | /api/v1/tenants/:id/appointments | List appointments |
| POST | /api/v1/tenants/:id/holds | Create hold |
| DELETE | /api/v1/tenants/:id/holds/:hid | Release hold |
| GET | /api/v1/tenants/:id/oauth/url | Get OAuth URL |
| GET | /api/v1/tenants/:id/oauth/callback | OAuth callback |
| WS | /chat | Chat WebSocket (Socket.IO) |
