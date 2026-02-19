# Manual Restart Instructions — gomomo.ai

> **Source of truth** for local dev environment startup, recovery, and health verification.
> This document is authoritative for both humans and agents (EON).

---

## ⚠️ EON Operational Rules

These rules are **permanent and non-negotiable** for the EON coding agent:

1. **Never start any long-running process (Vite, Fastify, etc.) using `run_in_terminal`.** The tool reuses shell sessions and will send SIGINT to the process.
2. **Always start Vite via VS Code Task: `vite-dev-server`.** This runs in an isolated terminal that `run_in_terminal` cannot reach.
3. **Always start the backend via VS Code Task: `backend-server`.** Same isolation protection as the frontend.
4. **All ops commands (`curl`, `chmod`, `lsof`, `npx vitest`, etc.) must run in a separate ops terminal** or via `scripts/ops-health.sh`. Never route them into any task terminal.
5. **If any service dies unexpectedly, restart via VS Code Task only** — `⌘⇧P` → Tasks: Run Task → select the appropriate task.

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
| **Backend (Fastify) MUST always run as a VS Code Task** | Task label: `backend-server` |
| **Neither frontend NOR backend may be started via `run_in_terminal`** | Not via `npm run dev`, not via `npx vite`, not via `npx tsx src/index.ts` in a regular terminal |
| **ALL long-running processes MUST run as VS Code Tasks** | This includes frontend, backend, workers, pollers — anything that stays running |
| **Automation tools must never interact with any task terminal** | No `curl`, no `chmod`, no `grep` — nothing. Use a dedicated ops terminal. |

**Why:** VS Code's `run_in_terminal` tool reuses terminal sessions. If **any** long-running process (Vite, Fastify, etc.) is running in a regular terminal, the next non-background command may be routed into that terminal, sending SIGINT and killing the process instantly. This was observed for both Vite (2026-02-09) and the Fastify backend (2026-02-18). VS Code Tasks run in **isolated terminal instances** that the `run_in_terminal` tool cannot reach.

---

## C) Standard Dev Topology

| Component | Port | How It Runs | Notes | Required For |
|-----------|------|-------------|-------|--------------|
| Backend (Fastify) | `3000` | **VS Code Task:** `backend-server` | Isolated, SIGINT-safe | Always |
| Widget (Vite) | `5173` | **VS Code Task:** `vite-dev-server` | `--strictPort` — fails if port occupied | Widget dev, smoke tests |
| Web App (Next.js) | `3001` | **VS Code Task:** `nextjs-dev-server` | Source: `src/web` | Full platform mode |
| PostgreSQL | `5432` | Postgres.app (local) | Must be running before backend starts | Always |
| Ops / Health | n/a | Dedicated ops terminal | `curl`, `chmod`, scripts only | Always |

---

## C.1) Full Local Platform Mode (Default for Testing)

When running the full platform locally, **all three services** must be running simultaneously via VS Code Tasks.

### Startup Order

1. **Backend** — `⌘⇧P` → Tasks: Run Task → `backend-server`
   Wait for: `Server listening on http://0.0.0.0:3000`
2. **Widget** — `⌘⇧P` → Tasks: Run Task → `vite-dev-server`
   Wait for: `VITE v5.x.x ready`
3. **Web App** — `⌘⇧P` → Tasks: Run Task → `nextjs-dev-server`
   Wait for: `✓ Ready in X.Xs` on port 3001

### Verification (OPS terminal)

```bash
# Port listeners
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:3001 -sTCP:LISTEN

# HTTP status
curl -s -o /dev/null -w "3000=%{http_code}\n" http://localhost:3000/health
curl -s -o /dev/null -w "5173=%{http_code}\n" http://localhost:5173/
curl -s -o /dev/null -w "3001=%{http_code}\n" http://localhost:3001/
```

All three must return `200`. If any returns `000`, the service is not running — restart it via its VS Code Task.

> **Reminder:** All three tasks are SIGINT-isolated. Never start these services via `run_in_terminal`.

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

# Option 2: Ctrl-C in the backend task terminal (if visible)
```

### Start

> ⚠️ **Do NOT start the backend via `run_in_terminal` or a shared terminal.** The SIGINT terminal-reuse issue affects the backend the same way it affects Vite (see Section G).

1. Open VS Code **Command Palette** (`⌘⇧P`)
2. Type **"Run Task"** and select **Tasks: Run Task**
3. Select **`backend-server`**
4. Wait for `Server listening on http://0.0.0.0:3000` in the task terminal

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

## G) Known Failure Mode (Documented Incidents)

### Incident 1 — Frontend (Vite) killed by terminal reuse

**Date:** 2026-02-09

| Field | Detail |
|-------|--------|
| **Symptom** | Vite repeatedly exits with code 130 (SIGINT). Safari shows "Can't Connect to the Server" on `localhost:5173` |
| **Root Cause** | VS Code's `run_in_terminal` tool reused the Vite terminal for `curl` and `chmod` commands. Each command sent `^C` to the foreground Vite process, killing it. |
| **Frequency** | Every single non-background command routed to the Vite terminal killed it. Vite was restarted and killed 5+ times in a row. |
| **Failed Mitigations** | `nohup npx vite ... &` — Vite runs but does not respond to HTTP (no TTY). `disown` — same problem. |
| **Permanent Fix** | Vite runs as a **VS Code Task** (`vite-dev-server`). Tasks run in isolated terminal instances that `run_in_terminal` cannot reach. |
| **Verification** | After switching to tasks: ran `ops-health.sh`, multiple `curl` commands, `chmod`, and `lsof` checks — Vite survived all of them. |

### Incident 2 — Backend (Fastify) killed by terminal reuse

**Date:** 2026-02-18

| Field | Detail |
|-------|--------|
| **Symptom** | Backend repeatedly exits after receiving `^C` (SIGINT). Health check `curl` commands fail with exit code 7 (connection refused). Backend killed 3+ times in a row. |
| **Root Cause** | `run_in_terminal` routed `curl -s http://localhost:3000/health` into the backend terminal. The `^C` sent to clear the prompt killed the Fastify process. |
| **Frequency** | Every non-background `run_in_terminal` command routed to the backend terminal killed it. |
| **Failed Mitigations** | Starting backend with `isBackground: true` — `run_in_terminal` still routed subsequent commands into the same terminal. Explicit `cd && exec npx tsx` — worked until the next ops command was routed there. |
| **Permanent Fix** | Backend runs as a **VS Code Task** (`backend-server`). Tasks run in isolated terminal instances that `run_in_terminal` cannot reach. |
| **Verification** | After switching to tasks: ran `curl`, `lsof`, and port checks 5+ times — backend survived all of them. |

> **Principle:** All long-running services must run as isolated VS Code Tasks. This is the only reliable protection against `run_in_terminal` SIGINT.

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

### Step 3 — Restart Backend (via Task)

1. `⌘⇧P` → **Tasks: Run Task** → **`backend-server`**
2. Wait for `Server listening on http://0.0.0.0:3000` in the task terminal

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

## K) Operational Principle — Long-Running Process Isolation

> This principle was established after two separate incidents (2026-02-09 and 2026-02-18) where `run_in_terminal` killed long-running services via SIGINT.

**Rule:** Any process that stays running (frontend, backend, workers, pollers) **must** run in an isolated VS Code Task.

- **Vite** → Task: `vite-dev-server`
- **Fastify backend** → Task: `backend-server`
- **Any future worker or poller** → Must have its own VS Code Task defined in `.vscode/tasks.json`

**Ops isolation:** No ops commands (`curl`, `chmod`, `lsof`, `vitest`, `grep`, etc.) may be routed into any task terminal. All ops work runs in a separate dedicated terminal via `run_in_terminal` or `scripts/ops-health.sh`.

**Diagnosis:** If a service is killed unexpectedly, verify it was not started via `run_in_terminal`. If it was, restart it via the appropriate VS Code Task.

---

## J) Enforcement Statement

> **Any workflow that starts the frontend outside the `vite-dev-server` VS Code Task, or the backend outside the `backend-server` VS Code Task, is invalid and unsupported.**

This applies to:

- Human developers
- EON agents
- CI/CD scripts running locally
- Any tool that calls `run_in_terminal`, `nohup`, or spawns shell processes

---

## File References

| File | Purpose |
|------|---------|
| `.vscode/tasks.json` (workspace root) | Defines `backend-server`, `vite-dev-server`, and `nextjs-dev-server` tasks |
| `scripts/ops-health.sh` | Canonical health dashboard — safe to run from any ops terminal |
| `src/backend/src/index.ts` | Backend entry point — startup log shows config status |
| `src/backend/.env` | Environment config (Twilio, DB, OpenAI) |
| `src/web/` | Next.js web app — runs on port 3001 via `nextjs-dev-server` task |

---

*Last updated: 2026-02-18 · Added full local platform mode (3-service topology) with Next.js web app on port 3001. Original: 2026-02-09.*
