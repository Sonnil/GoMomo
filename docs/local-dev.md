# Local Development Guide

> **Last updated**: 2026-02-17

## TL;DR

```bash
bash scripts/dev-up.sh        # start everything
bash scripts/verify-local.sh   # health-check (never hangs)
bash scripts/dev-down.sh       # stop everything
```

---

## Port Map

| Service         | Port  | URL                          | Tech            |
|-----------------|-------|------------------------------|-----------------|
| Backend API     | 3000  | http://127.0.0.1:3000        | Fastify + WS    |
| Web / Admin     | 3001  | http://127.0.0.1:3001        | Next.js dev     |
| Chat Widget     | 5173  | http://127.0.0.1:5173        | Vite dev        |

---

## The Cardinal Rule

> **Never run checks in the same terminal where Vite (or Next dev) is running.**

Vite and Next.js dev servers hold the terminal's stdin/stdout. Running
`npm test`, `tsc --noEmit`, `eslint`, or `curl` in the same terminal will
cause:

- **Terminal contention**: stdout from the dev server and your command
  interleave, making output unreadable.
- **Port conflicts**: some tools (vitest) spin up their own servers that
  may clash.
- **Zombie processes**: Ctrl-C kills the foreground process but may leave
  the background one hanging.

### Correct workflow

```
Terminal 1 (dedicated)         Terminal 2 (checks)
──────────────────────         ────────────────────
bash scripts/dev-up.sh         # wait for "All dev servers running!"
                                bash scripts/verify-local.sh
                                npm test
                                npm run typecheck
                                npm run lint
```

Or more simply: `dev-up.sh` runs everything in the **background** so your
terminal is immediately free for checks.

---

## Starting the Stack

```bash
bash scripts/dev-up.sh
```

What it does:

1. Stops any previously tracked processes (reads `logs/*.pid`).
2. Guards against port collisions (fails fast if 3000/3001/5173 are taken).
3. Clears stale `.next/cache` to prevent Next.js build corruption.
4. Installs `node_modules` if missing.
5. Starts backend → web → widget, each in the background.
6. Writes PIDs to `logs/backend.pid`, `logs/web.pid`, `logs/widget.pid`.
7. Writes logs to `logs/backend.log`, `logs/web.log`, `logs/widget.log`.
8. Waits for each port to be listening before moving to the next service.

---

## Verifying the Stack

```bash
bash scripts/verify-local.sh
```

All checks use `127.0.0.1` (IPv4) with `--max-time 3` so the script
**never hangs**, even if `localhost` resolves to `::1` first.

Checks performed:

| #  | Check               | What it does                                   |
|----|---------------------|------------------------------------------------|
| 1  | Backend HTTP        | `GET http://127.0.0.1:3000/health` → HTTP 200  |
| 2  | Backend JSON        | Same endpoint, validates `"status"` in body    |
| 3  | Web (Next.js)       | `GET http://127.0.0.1:3001/` → HTTP 200        |
| 4  | Widget (Vite)       | `GET http://127.0.0.1:5173/` → HTTP 200        |
| 5  | Socket.IO handshake | Polling probe expects `sid` in response        |
| 6  | PID files           | Validates `logs/*.pid` point to live processes  |
| 7  | Port listing        | `lsof` on 3000 / 3001 / 5173                   |

Exit code: `0` = all pass, `1` = at least one failure.

---

## Stopping the Stack

```bash
bash scripts/dev-down.sh
```

1. Reads PIDs from `logs/*.pid`.
2. Sends `SIGTERM` → waits 3 s → `SIGKILL` if still alive.
3. Falls back to port-based kill if PID files are missing.
4. Removes stale `.pid` files.

---

## Next.js Build Hygiene

> **Never run `next build` while `next dev` is running.**

Both `next dev` and `next build` write to `src/web/.next/`. If they run
simultaneously:

- **File lock contention**: the build may fail with `EBUSY` or produce
  corrupt manifests.
- **Cache poisoning**: dev writes hot-reload artifacts that are invalid
  for a production build.
- **Silent bad output**: the build may succeed but serve stale or broken
  pages.

### Safe build procedure

```bash
# 1. Stop the dev stack
bash scripts/dev-down.sh

# 2. (Optional) Nuke stale cache
rm -rf src/web/.next

# 3. Build
npm --prefix src/web run build

# 4. Restart dev
bash scripts/dev-up.sh
```

`dev-up.sh` automatically clears `.next/cache` on every startup, which
covers the most common cache corruption scenario. But if you're doing a
production build, stop the dev server first.

---

## Troubleshooting

### Port already in use

```
❌ Port 3000 (Backend) already in use by PID 12345
```

Run `bash scripts/dev-down.sh` first. If that doesn't help, manually kill:

```bash
lsof -ti :3000 | xargs kill -9
```

### Verify hangs

If `verify-local.sh` hangs, something is wrong with your `curl`. Check:

```bash
curl --version   # must support -4 flag
```

The script uses `--max-time 3` on every call. If it still hangs, your
curl is not respecting timeouts (extremely rare — update curl).

### Next.js "Module not found" after switching branches

```bash
rm -rf src/web/.next src/web/node_modules
npm --prefix src/web install
bash scripts/dev-up.sh
```

### Backend won't start (DB connection)

The dev backend expects PostgreSQL on `localhost:5432`. Options:

1. Run the demo stack: `bash scripts/demo-start.sh` (includes embedded PG).
2. Use Docker: `docker compose up -d postgres`.
3. Use a local Postgres instance.

---

## Log Files

All logs are in the `logs/` directory (gitignored):

| File              | Content                          |
|-------------------|----------------------------------|
| `backend.log`     | Fastify server output            |
| `web.log`         | Next.js dev server output        |
| `widget.log`      | Vite dev server output           |
| `backend.pid`     | Backend process ID               |
| `web.pid`         | Web process ID                   |
| `widget.pid`      | Widget process ID                |

Tail a specific log:

```bash
tail -f logs/backend.log
```

---

## Relationship to Demo Scripts

The `demo-start.sh` / `demo-stop.sh` scripts are for the **full demo
stack** (includes embedded PostgreSQL, migrations, seed data). They use
`.logs/` (dot-prefixed) and manage PG separately.

The `dev-up.sh` / `dev-down.sh` scripts are for **daily development**.
They assume a database is already running and only manage the three
application servers. They use `logs/` (no dot prefix).

Both can coexist, but don't run both simultaneously — they share the
same ports.
