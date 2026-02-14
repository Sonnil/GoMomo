# Local Development Guide

> **gomomo.ai** — get the full stack running on your machine in under 5 minutes.

---

## Prerequisites

| Tool | Minimum Version | Check |
|------|----------------|-------|
| **Docker Desktop** | 4.x (Compose v2) | `docker compose version` |
| **Node.js** | 20+ | `node -v` |
| **npm** | 10+ | `npm -v` |
| An **OpenAI API key** | — | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

---

## Quick Start (3 commands)

```bash
# 1. Create your .env from the template
cp .env.example .env
# → Edit .env and paste your OPENAI_API_KEY

# 2. Start everything (Postgres + Backend + Frontend)
docker compose up --build -d

# 3. Seed the demo data
docker compose exec backend npx tsx src/db/seed.ts
```

Open **http://localhost:5173** — the chat widget is live.

---

## Expected URLs

| Service | URL | Notes |
|---------|-----|-------|
| **Chat Widget** | http://localhost:5173 | React dev server (Vite) |
| **Demo Mode** | http://localhost:5173?demo=1 | No DB needed — canned Bloom Wellness responses |
| **Backend API** | http://localhost:3000 | Fastify + Socket.IO |
| **Health Check** | http://localhost:3000/health | `{ "status": "ok" }` |
| **PostgreSQL** | `localhost:5432` | User: `receptionist` / Pass: `receptionist_dev` / DB: `receptionist` |

---

## Detailed Setup

### 1. Clone & enter the project

```bash
cd EON/projects/prj-20260205-001-ai-receptionist
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```dotenv
OPENAI_API_KEY=sk-your-actual-key-here
```

All other values have safe defaults for local dev.

### 3. Build & start

```bash
docker compose up --build -d
```

This starts three services:
- **postgres** — PostgreSQL 16 Alpine (healthcheck-gated)
- **backend** — Node.js 20 running `tsx watch src/index.ts` (auto-restart on file changes)
- **frontend** — Vite dev server with HMR

The backend automatically runs migrations on startup.

### 4. Seed demo data

```bash
docker compose exec backend npx tsx src/db/seed.ts
```

This creates:
- **Bloom Wellness Studio** (ID: `00000000-0000-4000-a000-000000000001`)
  - 5 services (Wellness, Follow-up, Acupuncture, Nutrition, Stress)
  - 5 sample appointments across the next 7 days
- **Demo Clinic** (auto-UUID)
  - 3 services (General, Follow-up, Extended)

### 5. Open the chat widget

Navigate to http://localhost:5173 and use tenant ID:

```
00000000-0000-4000-a000-000000000001
```

Or use the slug-based lookup if your frontend supports it: `bloom-wellness`.

---

## Daily Commands

### Start / Stop / Restart

```bash
# Start (background)
docker compose up -d

# Stop (keep data)
docker compose down

# Restart a single service
docker compose restart backend

# Full rebuild (after Dockerfile changes)
docker compose up --build -d
```

### View Logs

```bash
# All services
docker compose logs -f

# Backend only
docker compose logs -f backend

# Last 100 lines of backend
docker compose logs --tail 100 backend

# Postgres only
docker compose logs -f postgres
```

### Run Backend Commands Inside Container

```bash
# Re-run migrations
docker compose exec backend npx tsx src/db/migrate.ts

# Re-seed data
docker compose exec backend npx tsx src/db/seed.ts

# TypeScript type-check
docker compose exec backend npx tsc --noEmit

# Open a Node REPL with project context
docker compose exec backend node
```

### Direct Database Access

```bash
# psql inside the container
docker compose exec postgres psql -U receptionist -d receptionist

# Common queries:
#   \dt                          -- list tables
#   SELECT * FROM tenants;       -- view tenants
#   SELECT * FROM appointments;  -- view appointments
#   SELECT * FROM _migrations;   -- applied migrations
```

### Full Reset (nuclear option)

```bash
# Stop everything AND delete the database volume
docker compose down -v

# Rebuild from scratch
docker compose up --build -d

# Re-seed
docker compose exec backend npx tsx src/db/seed.ts
```

---

## Running Without Docker (native Node.js)

If you prefer running outside Docker (e.g., for debugger attach):

### 1. Start Postgres only

```bash
docker compose up -d postgres
```

### 2. Install backend deps & run

```bash
cd src/backend
cp .env.example .env
# Edit .env: set DATABASE_URL=postgresql://receptionist:receptionist_dev@localhost:5432/receptionist
# Edit .env: set OPENAI_API_KEY=sk-your-key
npm ci
npm run dev          # tsx watch src/index.ts
```

### 3. In another terminal — seed data

```bash
cd src/backend
npx tsx src/db/seed.ts
```

### 4. Install frontend deps & run

```bash
cd src/frontend
npm install
npm run dev          # Vite on :5173
```

---

## Demo Mode (Zero Dependencies)

Run the standalone Bloom Wellness demo server — no database, no OpenAI key needed:

```bash
cd src/backend
npm ci               # first time only
npm run demo         # starts on :3000 with canned responses
```

Then open http://localhost:5173?demo=1 (or set `VITE_DEMO_MODE=1`).

---

## Running Tests

```bash
cd src/backend

# Race-condition tests (requires running DB)
npx tsx tests/race-condition.test.ts

# Voice simulator (requires running backend)
npx tsx tests/voice-simulator.ts

# Excel adapter tests (unit tests, no DB needed)
npx tsx tests/excel-adapter.test.ts

# Type-check only
npx tsc --noEmit
```

---

## Troubleshooting

### "Cannot connect to database"

```bash
# Check if Postgres is healthy
docker compose ps
# Should show postgres status: healthy

# If not, check logs
docker compose logs postgres
```

### "OPENAI_API_KEY is required"

You forgot to create `.env` or left the key as placeholder:

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY
docker compose restart backend
```

### Port already in use

```bash
# Find what's using port 3000
lsof -i :3000
# Kill it or change PORT in .env

# Find what's using port 5432
lsof -i :5432
# Stop local Postgres or change docker-compose port mapping
```

### Backend not picking up file changes

The volume mount maps `./src/backend/src` into the container. Make sure:
1. You're editing files in `src/backend/src/`, not `dist/`
2. The `tsx watch` process is running: `docker compose logs -f backend`

### "Migration already applied" but schema is wrong

```bash
# Nuclear reset — drops everything
docker compose down -v
docker compose up --build -d
docker compose exec backend npx tsx src/db/seed.ts
```

---

## Architecture Overview

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│   Browser    │────▶│  Frontend :5173   │     │              │
│  (Chat UI)   │     │  Vite + React    │     │  PostgreSQL  │
└─────────────┘     └──────┬───────────┘     │  :5432       │
                           │ HTTP + WS        │              │
                    ┌──────▼───────────┐     │              │
                    │  Backend :3000    │────▶│              │
                    │  Fastify + tsx    │     └──────────────┘
                    │  Socket.IO /ws    │
                    └──────────────────┘
```

---

## Key Tenant IDs

| Tenant | ID | Slug |
|--------|----|------|
| Bloom Wellness Studio | `00000000-0000-4000-a000-000000000001` | `bloom-wellness` |
| Demo Clinic | *(auto-generated UUID)* | `demo-clinic` |
