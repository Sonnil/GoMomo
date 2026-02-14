# gomomo.ai MVP

gomomo.ai — Intelligent scheduling powered by AI. Books appointments via web chat and integrates with Google Calendar — without overbooking.

## Architecture

```
Browser (React Widget)
    │  Socket.IO / REST
    ▼
Fastify Server (:3000)
    ├── REST API Routes
    ├── WebSocket Handler
    └── AI Agent (OpenAI function-calling)
           │
           ├── AvailabilityService  → generates slots, holds
           ├── BookingService       → atomic confirm/reschedule/cancel
           └── CalendarService      → Google Calendar sync
                   │
                   ▼
           PostgreSQL 16
           (EXCLUDE constraints prevent overbooking)
```

## Key Guarantees

| Constraint | How |
|---|---|
| **No overbooking** | PostgreSQL `EXCLUDE USING gist` on `tstzrange(start_time, end_time)` per tenant — DB rejects overlaps at the row level |
| **Deterministic AI** | System prompt forbids fabrication; all bookings go through backend tools; AI never confirms unless `confirm_booking` returns success |
| **Timezone-safe** | All times stored as `TIMESTAMPTZ`; business hours evaluated in tenant timezone via `date-fns-tz` |
| **Multi-tenant** | Every table keyed by `tenant_id`; tenants are fully isolated |
| **Auditability** | Append-only `audit_log` table; every state change recorded |

## Quick Start

### Prerequisites

- Docker & Docker Compose
- OpenAI API key (or compatible endpoint)
- Google Cloud project with Calendar API enabled (optional — works without for core booking)

### 1. Clone & Configure

```bash
cd EON/projects/prj-20260205-001-ai-receptionist

# Copy environment template
cp src/backend/.env.example .env

# Edit .env — at minimum set:
#   OPENAI_API_KEY=sk-...
#   (Optional) GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
```

### 2. Start with Docker Compose

```bash
docker compose up --build
```

This starts:
- **PostgreSQL** on port 5432
- **Backend API + WebSocket** on port 3000
- **React frontend** on port 5173

### 3. Seed Demo Data

```bash
docker compose exec backend npx tsx src/db/seed.ts
```

Creates a "Demo Clinic" tenant with:
- Mon–Thu 9AM–5PM, Fri 9AM–4PM (America/New_York)
- Services: General Consultation (30m), Follow-up (15m), Extended (60m)

### 4. Open the Chat

Visit **http://localhost:5173** — the chat widget auto-connects via WebSocket.

### 5. (Optional) Connect Google Calendar

```bash
# Get the demo tenant ID
curl http://localhost:3000/api/tenants/demo-clinic

# Get OAuth authorization URL
curl http://localhost:3000/api/tenants/<TENANT_ID>/oauth/google

# Visit the returned URL, authorize, and the callback auto-saves tokens
```

## Local Development (without Docker)

### Backend

```bash
cd src/backend
npm install

# Start PostgreSQL locally (ensure btree_gist extension is available)
# Set DATABASE_URL in .env

npx tsx src/db/migrate.ts   # Run migrations
npx tsx src/db/seed.ts      # Seed demo tenant
npx tsx src/index.ts        # Start server
```

### Frontend

```bash
cd src/frontend
npm install
# ⚠️  Do NOT run `npm run dev` in a regular terminal — see below.
```

## Local Development & Restarts

> **Full instructions:** [`docs/manual-restart-instructions.md`](docs/manual-restart-instructions.md)

### The One Rule

**The frontend (Vite) MUST run as a VS Code Task, never in a regular terminal.**

VS Code's automation tools reuse terminal sessions. If Vite is running in a regular terminal, the next command routed there sends SIGINT and kills Vite instantly. VS Code Tasks run in isolated terminals that are immune to this.

### Start the Frontend

1. `⌘⇧P` → **Tasks: Run Task** → **`vite-dev-server`**
2. Vite starts on `http://localhost:5173`

> **EON rule:** Frontend must be started via VS Code Task (`vite-dev-server`) to avoid terminal multiplexing SIGINT issues. Never use `run_in_terminal` for Vite. All ops commands (`curl`, tests, health checks) must run in a separate ops terminal.

### Start the Backend

```bash
cd src/backend && npx tsx src/index.ts
# Wait for: Server listening on http://0.0.0.0:3000
```

### Health Check

```bash
bash scripts/ops-health.sh
```

This prints port status, `/health`, `/health/sms`, and frontend reachability. Run it from a **dedicated ops terminal** — never from the frontend task or backend terminal.

### When Things Are Hung

See the **Recovery Procedure** in [`docs/manual-restart-instructions.md`](docs/manual-restart-instructions.md#h-recovery-procedure-when-things-look-hung).

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/tenants/:id` | Get tenant info |
| `POST` | `/api/tenants` | Create tenant |
| `PATCH` | `/api/tenants/:id` | Update tenant |
| `GET` | `/api/tenants/:id/availability?start=...&end=...` | Get available slots |
| `POST` | `/api/tenants/:id/holds` | Hold a time slot (5min TTL) |
| `POST` | `/api/tenants/:id/appointments` | Confirm booking |
| `GET` | `/api/tenants/:id/appointments/lookup?ref=...&email=...` | Lookup booking |
| `POST` | `/api/tenants/:id/appointments/:aid/reschedule` | Reschedule |
| `POST` | `/api/tenants/:id/appointments/:aid/cancel` | Cancel |
| `GET` | `/api/tenants/:id/oauth/google` | Get Google OAuth URL |
| `GET` | `/api/oauth/google/callback` | OAuth callback |
| `POST` | `/api/tenants/:id/chat` | REST chat (fallback) |
| `WS` | `/ws` | WebSocket chat (preferred) |

## WebSocket Protocol

```
Client → Server:  "join"    { tenant_id, session_id? }
Server → Client:  "joined"  { session_id }
Client → Server:  "message" { message }
Server → Client:  "typing"  { typing: boolean }
Server → Client:  "response"{ session_id, response }
Server → Client:  "error"   { error }
```

## Project Structure

```
src/
├── backend/
│   ├── src/
│   │   ├── agent/           # AI receptionist
│   │   │   ├── system-prompt.ts
│   │   │   ├── tools.ts
│   │   │   ├── chat-handler.ts
│   │   │   └── tool-executor.ts
│   │   ├── config/env.ts    # Zod-validated env
│   │   ├── db/
│   │   │   ├── client.ts    # pg pool + transactions
│   │   │   ├── migrate.ts   # SQL migration runner
│   │   │   ├── seed.ts      # Demo data
│   │   │   └── migrations/  # SQL files
│   │   ├── domain/types.ts  # TypeScript interfaces
│   │   ├── repos/           # Data access layer
│   │   ├── routes/          # Fastify route handlers
│   │   ├── services/        # Business logic
│   │   └── index.ts         # Server entry point
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/ChatWidget.tsx
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── Dockerfile
│   └── package.json
└── docker-compose.yml
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript 5+ |
| HTTP | Fastify |
| WebSocket | Socket.IO |
| Database | PostgreSQL 16 with `btree_gist` |
| AI | OpenAI API (function calling) |
| Calendar | Google Calendar API v3 |
| Frontend | React 18 + Vite |
| Validation | Zod |
| Timezone | date-fns + date-fns-tz |
| Containers | Docker + Docker Compose |

## EON Governance

This project is governed by the EON agency framework. See `/EON/governance/` for:
- Charter & agent responsibility matrix
- Gate sequence (this project follows **standard** mode — non-GxP)
- Model routing policy (tier assignments)

---

**Built by EON Agency** · Project `prj-20260205-001-gomomo`
