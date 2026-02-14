# Manual Restart Instructions — gomomo.ai

> **Source of truth** for local dev environment startup, recovery, and health verification.
> This document is authoritative for both humans and agents (EON).

---

## ⚠️ EON Operational Rules

These rules are **permanent and non-negotiable** for the EON coding agent:

1. **Never run Vite using `run_in_terminal`.** The tool reuses shell sessions and will send SIGINT to Vite.
2. **Always start Vite via VS Code Task: `vite-dev-server`.** This runs in an isolated terminal that `run_in_terminal` cannot reach.
3. **All ops commands (`curl`, `chmod`, `lsof`, `npx vitest`, etc.) must run in a separate ops terminal** or via `scripts/ops-health.sh`. Never route them into the frontend task terminal.
4. **If Vite dies unexpectedly, restart via the VS Code Task only** — `⌘⇧P` → Tasks: Run Task → `vite-dev-server`.

---

## A) Purpose

These instructions exist to prevent:

- **Dev workflow hangs** caused by terminal reuse or orphaned processes
- **Accidental SIGINT (`^C`)** sent to the frontend when automation tools (EON / Copilot / VS Code `run_in_terminal`) route commands into the wrong terminal
- **Silent frontend death** where Vite exits with code 130 and no one notices until the browser says "Safari Can't Connect to the Server"

If you are reading this because something is hung, skip to **Section H — Recovery Procedure**.

---

## B) Core Rule (NON-NEGOTIABLE)

| Rule | Details |
|------|---------|
| **Frontend (Vite) MUST always run as a VS Code Task** | Task label: `vite-dev-server` |
| **Frontend MUST NEVER run in a regular terminal** | Not via `npm run dev`, not via `npx vite`, not via `run_in_terminal` |
| **Automation tools must never interact with the frontend task terminal** | No `curl`, no `chmod`, no `grep` — nothing |

**Why:** VS Code's `run_in_terminal` tool reuses terminal sessions. If Vite is running in a regular terminal, the next non-background command may be routed into that terminal, sending SIGINT and killing Vite instantly. VS Code Tasks run in **isolated terminal instances** that the `run_in_terminal` tool cannot reach.

---

## C) Standard Dev Topology

| Component | Port | How It Runs | Notes |
|-----------|------|-------------|-------|
| Frontend (Vite) | `5173` | **VS Code Task:** `vite-dev-server` | Isolated, SIGINT-safe |
| Backend (Fastify) | `3000` | Regular terminal or VS Code Task | Safe to restart manually |
| PostgreSQL | `5432` | Postgres.app (local) | Must be running before backend starts |
| Ops / Health | n/a | Dedicated ops terminal | `curl`, `chmod`, scripts only |

---

## D) Frontend (Vite) — Start / Restart

### ✅ Supported Method (ONLY)

1. Open VS Code **Command Palette** (`⌘⇧P`)
2. Type **"Run Task"** and select **Tasks: Run Task**
3. Select **`vite-dev-server`**
4. Vite starts in an isolated Task terminal on `:5173`

Or from the terminal:

```bash
# Only if you need to start it programmatically (e.g. in a script):
# This is how the task is defined internally — do not run this in a regular terminal.
cd src/frontend && npx vite --host 0.0.0.0 --port 5173
```

### ❌ Unsupported (DO NOT USE)

```bash
# NEVER run these in a regular terminal:
npm run dev              # ← will be killed by the next automation command
npx vite                 # ← same problem
npx vite --port 5173     # ← same problem
nohup npx vite ...       # ← Vite doesn't respond to HTTP when detached from TTY
```

**Why unsupported:** Regular terminals are shared by VS Code's `run_in_terminal` tool. Any subsequent command routed to that terminal sends SIGINT, killing Vite. The `nohup` approach also fails because Vite requires a TTY to serve HTTP correctly.

---

## E) Backend — Restart Procedure

### Stop

```bash
# Option 1: Kill by port
lsof -ti:3000 | xargs kill -9 2>/dev/null

# Option 2: Ctrl-C in the backend terminal (if visible)
```

### Start

```bash
cd src/backend && npx tsx src/index.ts
```

### Verify

```bash
curl -s http://localhost:3000/health | python3 -m json.tool
# Expect: { "status": "ok", ... }

curl -s http://localhost:3000/health/sms | python3 -m json.tool
# Expect: twilio_config.status = "ok" or "simulator"
```

### Startup Log Checklist

Look for these lines in the backend terminal output:

```
✅ Twilio SMS config OK (using From: +18445…)
🔓 CORS: DEV mode — localhost origins + CORS_ORIGIN allowed
Inbound SMS channel enabled — POST /twilio/sms/incoming registered
Server listening on http://0.0.0.0:3000
```

---

## F) Ops Commands & Health Checks

### Rule: All ops commands run in a **dedicated ops terminal**

```bash
# Use the canonical health dashboard:
bash scripts/ops-health.sh
```

This script checks:
- Port 3000 (backend) and 5173 (frontend) are listening
- `/health` returns OK
- `/health/sms` returns full Twilio config status
- Frontend responds to HTTP

### ⚠️ Warning

> **Never run `curl`, `chmod`, test scripts, or any shell command in the frontend task terminal or the backend terminal.** Use a separate terminal for all ops work.

### Manual Health Checks (if not using the script)

```bash
# Backend health
curl -s http://localhost:3000/health | python3 -m json.tool

# SMS pipeline health
curl -s http://localhost:3000/health/sms | python3 -m json.tool

# Port check
lsof -ti:3000 && echo "backend:UP" || echo "backend:DOWN"
lsof -ti:5173 && echo "frontend:UP" || echo "frontend:DOWN"
```

---

## G) Known Failure Mode (Documented Incident)

**Date:** 2026-02-09

| Field | Detail |
|-------|--------|
| **Symptom** | Vite repeatedly exits with code 130 (SIGINT). Safari shows "Can't Connect to the Server" on `localhost:5173` |
| **Root Cause** | VS Code's `run_in_terminal` tool reused the Vite terminal for `curl` and `chmod` commands. Each command sent `^C` to the foreground Vite process, killing it. |
| **Frequency** | Every single non-background command routed to the Vite terminal killed it. Vite was restarted and killed 5+ times in a row. |
| **Failed Mitigations** | `nohup npx vite ... &` — Vite runs but does not respond to HTTP (no TTY). `disown` — same problem. |
| **Permanent Fix** | Vite runs as a **VS Code Task** (`vite-dev-server`). Tasks run in isolated terminal instances that `run_in_terminal` cannot reach. |
| **Verification** | After switching to tasks: ran `ops-health.sh`, multiple `curl` commands, `chmod`, and `lsof` checks — Vite survived all of them. |

---

## H) Recovery Procedure (When Things Look Hung)

**Do NOT wait. Do NOT retry in the same terminal.**

### Step 1 — Assess

```bash
# In a NEW terminal (⌃` in VS Code):
lsof -ti:3000 && echo "backend:UP" || echo "backend:DOWN"
lsof -ti:5173 && echo "frontend:UP" || echo "frontend:DOWN"
```

### Step 2 — Kill Stale Processes

```bash
# Kill everything on both ports
lsof -ti:3000 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null
pkill -f "vite" 2>/dev/null
```

### Step 3 — Restart Backend

```bash
cd src/backend && npx tsx src/index.ts
```

Wait for `Server listening on http://0.0.0.0:3000`.

### Step 4 — Restart Frontend (via Task)

1. `⌘⇧P` → **Tasks: Run Task** → **`vite-dev-server`**
2. Wait for `VITE v5.x.x ready` in the task terminal

### Step 5 — Verify

```bash
bash scripts/ops-health.sh
```

Expect: **✅ All systems operational**

---

## I) Verification Checklist

Run after every restart or when in doubt:

| Check | Command | Expected |
|-------|---------|----------|
| Frontend listening | `lsof -ti:5173` | PID printed |
| Backend listening | `lsof -ti:3000` | PID printed |
| `/health` OK | `curl -s http://localhost:3000/health \| python3 -m json.tool` | `"status": "ok"` |
| `/health/sms` OK | `curl -s http://localhost:3000/health/sms \| python3 -m json.tool` | `twilio_config.status: "ok"` |
| Outbox poller running | (in `/health/sms` response) | `outbox_poller.running: true` |
| Twilio config valid | (in `/health/sms` response) | `has_account_sid: true`, `has_auth_token: true` |
| Frontend HTTP 200 | `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` | `200` |

Or simply:

```bash
bash scripts/ops-health.sh
```

---

## J) Enforcement Statement

> **Any workflow that starts the frontend outside the `vite-dev-server` VS Code Task is invalid and unsupported.**

This applies to:
- Human developers
- EON agents
- CI/CD scripts running locally
- Any tool that calls `run_in_terminal`, `nohup`, or spawns shell processes

---

## File References

| File | Purpose |
|------|---------|
| `.vscode/tasks.json` (workspace root) | Defines the `vite-dev-server` task |
| `scripts/ops-health.sh` | Canonical health dashboard — safe to run from any ops terminal |
| `src/backend/src/index.ts` | Backend entry point — startup log shows config status |
| `src/backend/.env` | Environment config (Twilio, DB, OpenAI) |

---

*Last updated: 2026-02-09 · Created after incident where Vite was killed 5+ times by terminal reuse.*
