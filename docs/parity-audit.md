# Local vs Web — Parity Audit

> **Generated:** 2025-07-17  
> **Branch:** `main` — HEAD `d7e0997c`  
> **Auditor:** Copilot (automated)  
> **Blocker:** Corporate Zscaler proxy prevents live verification of production endpoints. All "Web (Production)" data below is **inferred from source code, env templates, Dockerfiles, and docs** — not live-verified.

---

## A. Endpoint Map

| Role | Local | Web (Production) | Source of truth |
|------|-------|-------------------|-----------------|
| **Backend API** | `http://localhost:3000` | `https://api.gomomo.ai` | `docs/release-process.md`, `.env.pilot` pattern |
| **Widget (Vite SPA)** | `http://localhost:5173` | `https://api.gomomo.ai/widget/` | Dockerfile `VITE_BASE_PATH=/widget/`, `src/backend/src/index.ts:231` |
| **Web App (Next.js)** | `http://localhost:3001` | `https://gomomo.ai` | `src/web/src/app/layout.tsx` OpenGraph URL |
| **WebSocket** | `ws://localhost:3000/ws` | `wss://api.gomomo.ai/ws` | `src/frontend/src/components/ChatWidget.tsx` (defaults to `window.location.origin`) |
| **PostgreSQL** | `localhost:5432` (Postgres.app) | Railway-managed Postgres | `docker-compose.yml`, `docs/guides/deployment.md` |
| **Pilot** | N/A | `https://pilot.gomomo-demo.com` | `src/backend/.env.pilot` |

### Architecture difference: Widget serving

| Layer | Local (dev) | Production |
|-------|-------------|------------|
| Widget server | **Vite dev server** on `:5173` with HMR, proxy `/api`→`:3000` | **Fastify static** serves built SPA at `/widget/*` from `dist/widget/` — same origin as API |
| Widget URL in Next.js iframe | `http://localhost:5173?embed=1` | `https://api.gomomo.ai/widget/?embed=1` (via `NEXT_PUBLIC_WIDGET_URL`) |
| Asset paths | `/src/...` (Vite dev) | `/widget/assets/...` (built, `VITE_BASE_PATH=/widget/`) |
| WebSocket connect | `VITE_WS_URL` or proxy through Vite | `window.location.origin` (same-origin, no proxy needed) |

---

## B. Code Parity

| Metric | Value |
|--------|-------|
| Local HEAD | `d7e0997c5468be376530cce9b6f91087aa5c045d` |
| Remote HEAD (`origin/main`) | Same — `d7e0997c` |
| Unpushed commits | **0** |
| Uncommitted changes | **26 files** (18 modified + 8 untracked) |
| Net delta | +324 insertions, −524 deletions |

### Uncommitted modified files (18)

| File | Category | Impact |
|------|----------|--------|
| `src/backend/src/agent/tool-executor.ts` | Error handling | Structured error codes, correlation IDs, `maskEmail()` |
| `src/backend/src/agent/system-prompt.ts` | Error handling | 17 error codes in rule 4 |
| `src/backend/src/agent/chat-handler.ts` | Error handling | `resolvedDatetime` fix, CalendarReadError branch |
| `src/backend/src/index.ts` | Server config | Helmet CSP, widget SPA serving, HTTPS enforcement |
| `src/backend/src/routes/chat.routes.ts` | Routing | Structured error responses |
| `src/backend/src/voice/ttsProvider.ts` | Voice | TTS provider cleanup |
| `src/frontend/src/lib/chat-persistence.ts` | Persistence | `InteractionMode` export fix, load/save |
| `src/frontend/src/hooks/useVoice.ts` | Voice | 130 lines removed (cleanup) |
| `src/frontend/src/index.css` | Styles | 6 lines removed |
| `scripts/verify-local.sh` | DevOps | Simplified verification script |
| `docs/manual-restart-instructions.md` | Docs | Updated for 3-service topology |
| `package.json` | Root | 3 lines removed |
| `.gitignore` | Config | 2 lines removed |
| `src/backend/tests/*` (5 files) | Tests | Test updates for new error handling |

### Uncommitted untracked files (8)

| File | Category |
|------|----------|
| `docs/release-process.md` | Release Captain workflow |
| `docs/release-report-template.md` | Release report template |
| `docs/review-structured-error-handling.md` | Error handling review |
| `scripts/pii-scan.sh` | PII scanning (Gate 5) |
| `scripts/verify-all.sh` | Full verification (Gates 1-4) |
| `src/backend/tests/e2e-error-verification.test.ts` | E2E error tests |
| `src/backend/tests/error-mapping.test.ts` | Error mapping tests |

### Verdict

⚠️ **MISMATCH** — Production (whatever was last deployed from `origin/main`) is running code **identical to HEAD**, but 26 local changes are **not committed** and therefore **not deployed**. These include critical structured error handling, Release Captain scripts, and the chat-persistence export fix.

---

## C. Config Parity

| Variable | Local (`.env`) | Production (inferred) | Parity | Risk |
|----------|-----------------|----------------------|--------|------|
| `NODE_ENV` | `development` | `production` | ✅ Expected | — |
| `CORS_ORIGIN` | `http://localhost:5173` | `https://gomomo.ai` (must be set) | ✅ Expected | — |
| `CORS_ALLOWED_ORIGINS` | Not set (dev mode = all localhost) | Must include `gomomo.ai` + admin domains | ⚠️ Must verify | **HIGH** if missing |
| `OPENAI_MODEL` | Not set → defaults to `gpt-4o` | `gpt-4o-mini` (per `.env.pilot`) | ⚠️ **Likely mismatch** | Cost / quality difference |
| `FEATURE_SMS` | `false` | Unknown — likely `true` in prod | ⚠️ Unknown | SMS won't work if false |
| `FEATURE_VOICE` | `false` | Unknown — likely `false` | ❓ Unknown | — |
| `FEATURE_VOICE_WEB` | `true` | Unknown | ❓ Unknown | — |
| `FEATURE_CALENDAR_BOOKING` | `true` | Unknown — likely `true` | ❓ Unknown | — |
| `EMAIL_DEV_MODE` | `true` | Must be `false` in prod | ⚠️ **Must verify** | **HIGH** — emails won't send |
| `EMAIL_PROVIDER` | `resend` | `resend` (likely same) | ❓ Unknown | — |
| `RESEND_API_KEY` | Empty | Must be set | ⚠️ **Must verify** | **CRITICAL** if empty |
| `CALENDAR_MODE` | `real` | `real` (likely) | ✅ Likely match | — |
| `PILOT_MODE` | `false` | `false` (prod uses strict CORS via NODE_ENV) | ✅ Expected | — |
| `REQUIRE_HTTPS` | Not set | `true` (per `.env.pilot`) | ✅ Expected | — |
| `SDK_AUTH_REQUIRED` | Not set | `true` (per `.env.pilot`) | ✅ Expected | — |
| `ENCRYPTION_KEY` | Dev placeholder | Must be set to real key | ⚠️ **Must verify** | **CRITICAL** if placeholder |
| `NEXT_PUBLIC_API_URL` | Not set → `http://localhost:3000` | Must be `https://api.gomomo.ai` | ⚠️ **Must verify** | **CRITICAL** — all API calls 404 if wrong |
| `NEXT_PUBLIC_WIDGET_URL` | Not set → `http://localhost:5173` | Must be `https://api.gomomo.ai/widget` | ⚠️ **Must verify** | **CRITICAL** — chat widget won't load |
| `NEXT_PUBLIC_SHOW_CHATBOT` | Not set → `true` | Should be `true` or unset | ❓ Unknown | Kill switch |

### CORS validation logic

```
Dev mode:  NODE_ENV !== 'production' && PILOT_MODE !== 'true'
           → allows any localhost:* origin
Strict mode: NODE_ENV === 'production' || PILOT_MODE === 'true'
           → ONLY origins in CORS_ALLOWED_ORIGINS allowlist
```

⚠️ In production, if `CORS_ALLOWED_ORIGINS` doesn't include `https://gomomo.ai`, the Next.js web app's API calls from the browser will be **blocked by CORS**.

---

## D. Runtime Parity

### Local (verified via `curl`)

| Endpoint | Status | Detail |
|----------|--------|--------|
| `localhost:3000/health` | ✅ 200 | `status: ok` |
| `localhost:5173` | ✅ 200 | Vite dev server |
| `localhost:3001` | ✅ 200 | Next.js dev server |

### Capabilities (from `/health`)

| Capability | Local | Production (inferred) |
|------------|-------|----------------------|
| `chat` | ✅ `true` | ✅ `true` (core feature) |
| `booking` | ✅ `true` | ✅ `true` (core feature) |
| `calendar` | ✅ `true` | ✅ `true` |
| `sms` | ❌ `false` | ❓ Unknown — likely `true` |
| `voice` | ❌ `false` | ❓ Unknown |
| `voiceWeb` | ✅ `true` | ❓ Unknown |
| `emailGate` | ❌ `false` | ❓ Unknown |
| `excel` | ❌ `false` | ❓ Unknown |
| `autonomy` | ✅ `true` | ❓ Unknown |

### Production (NOT verified — Zscaler blocked)

| Endpoint | Status | Detail |
|----------|--------|--------|
| `https://api.gomomo.ai/health` | ❌ BLOCKED | Zscaler 307 → `gateway.zsccloud.net` |
| `https://gomomo.ai` | ❌ BLOCKED | Zscaler interstitial |
| DNS `dig gomomo.ai` | ❌ BLOCKED | Timed out (corporate DNS) |

---

## E. UX / Network Parity

| Dimension | Local | Production | Parity |
|-----------|-------|------------|--------|
| **HTTPS** | ❌ HTTP only | ✅ HTTPS enforced (`REQUIRE_HTTPS=true`) | ✅ Expected |
| **Widget loading** | Vite dev server, HMR, ~instant | Static bundle from `/widget/`, CDN-cacheable | ✅ Functionally same UX |
| **Widget in iframe** | `http://localhost:5173?embed=1` | `https://api.gomomo.ai/widget/?embed=1` | ⚠️ Requires `NEXT_PUBLIC_WIDGET_URL` set |
| **CSP frame-ancestors** | `'self' http://localhost:5173` | `'self' https://gomomo.ai` (from `CORS_ORIGIN`) | ✅ If CORS_ORIGIN correct |
| **WebSocket upgrade** | Vite proxy → `:3000/ws` | Same-origin `/ws` or nginx `proxy_pass` | ✅ If reverse proxy configured |
| **API latency** | ~1ms (loopback) | ~50-200ms (network) | ✅ Expected |
| **OpenAI model** | `gpt-4o` (default) | `gpt-4o-mini` (per pilot template) | ⚠️ **Response quality differs** |
| **Error messages** | New structured errors (uncommitted) | Old error handling | ⚠️ **UX mismatch** until deployed |
| **Email verification** | Dev mode (skipped) | Real Resend emails | ✅ Expected but verify |

---

## F. Top 5 Differences (ranked by risk)

### 1. 🔴 CRITICAL — 26 uncommitted changes not deployed
**What:** Structured error handling (17 error codes, correlation IDs, `maskEmail()`), chat-persistence export fix, Release Captain scripts — all exist only locally.  
**Impact:** Production users see raw error messages instead of structured, user-friendly ones. Chat persistence may have import issues.  
**Fix:** Commit, push, and deploy.

### 2. 🔴 CRITICAL — `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WIDGET_URL` must be set on Vercel
**What:** Both default to `http://localhost:*` if not set. The Next.js web app at `gomomo.ai` will try to call `http://localhost:3000` for API requests and load the widget from `http://localhost:5173`.  
**Impact:** Website is completely broken — no API calls succeed, no chat widget loads.  
**Fix:** Set in Vercel dashboard:
```
NEXT_PUBLIC_API_URL=https://api.gomomo.ai
NEXT_PUBLIC_WIDGET_URL=https://api.gomomo.ai/widget
```

### 3. 🟡 HIGH — `EMAIL_DEV_MODE` may be `true` in production
**What:** Locally set to `true`, which skips real email sending. If production uses the same value, email verification and notifications are silently skipped.  
**Impact:** Users never receive verification emails.  
**Fix:** Ensure `EMAIL_DEV_MODE=false` and `RESEND_API_KEY` is set on Railway.

### 4. 🟡 HIGH — OpenAI model divergence
**What:** Local uses `gpt-4o` (default). Pilot/production template uses `gpt-4o-mini`.  
**Impact:** Response quality and cost differ. Users may get noticeably different conversational quality.  
**Fix:** Align intentionally — document which model is for which environment.

### 5. 🟡 MEDIUM — CORS_ALLOWED_ORIGINS must include web domain
**What:** In production (`NODE_ENV=production`), CORS switches to strict mode and **only** allows origins listed in `CORS_ALLOWED_ORIGINS`.  
**Impact:** If `https://gomomo.ai` is not in the allowlist, all browser API calls from the web app are blocked.  
**Fix:** Set on Railway:
```
CORS_ORIGIN=https://gomomo.ai
CORS_ALLOWED_ORIGINS=https://gomomo.ai,https://admin.gomomo.ai
```

---

## G. Recommended Fix Plan

| # | Action | Owner | Priority | Effort |
|---|--------|-------|----------|--------|
| 1 | **Commit & push** all 26 local changes | Dev | 🔴 P0 | 5 min |
| 2 | **Run `scripts/verify-all.sh`** (Release Captain Gates 1-4) before deploy | Dev | 🔴 P0 | 3 min |
| 3 | **Verify Vercel env vars**: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WIDGET_URL` | Ops | 🔴 P0 | 5 min |
| 4 | **Verify Railway env vars**: `EMAIL_DEV_MODE=false`, `RESEND_API_KEY`, `ENCRYPTION_KEY`, `CORS_ALLOWED_ORIGINS` | Ops | 🔴 P0 | 10 min |
| 5 | **Document model choice**: Decide `gpt-4o` vs `gpt-4o-mini` per environment | Lead | 🟡 P1 | 15 min |
| 6 | **Re-run this audit from non-Zscaler network** to live-verify production endpoints | Dev | 🟡 P1 | 20 min |
| 7 | **Add `.env.production.example`** to repo with all required production vars documented | Dev | 🟡 P2 | 30 min |
| 8 | **Add deploy healthcheck** to CI/CD — `curl $API_URL/health` post-deploy | DevOps | 🟡 P2 | 1 hr |

---

## H. Deployment Architecture Reference

```
┌─────────────────────────────────────────────────────────────┐
│                    LOCAL (dev mode)                          │
│                                                             │
│  :3001 Next.js ──iframe──▶ :5173 Vite ──proxy──▶ :3000 API  │
│                                                ▲            │
│                                         WebSocket /ws       │
│                                                             │
│  :5432 PostgreSQL (Postgres.app)                            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   PRODUCTION (inferred)                      │
│                                                             │
│  gomomo.ai (Vercel)                                         │
│    └─ Next.js SSR                                           │
│    └─ iframe src=api.gomomo.ai/widget/?embed=1              │
│                                                             │
│  api.gomomo.ai (Railway)                                    │
│    └─ Fastify :3000                                         │
│         ├─ /api/*         REST API                          │
│         ├─ /ws            Socket.IO (WebSocket)             │
│         ├─ /widget/*      Static SPA (Vite build)           │
│         └─ /health        Health check                      │
│                                                             │
│  Railway PostgreSQL (managed)                               │
└─────────────────────────────────────────────────────────────┘
```

---

## I. Files Examined

| File | Purpose |
|------|---------|
| `src/backend/.env` | Local env vars |
| `src/backend/.env.pilot` | Production env template |
| `src/backend/src/index.ts` | Server setup, widget serving, CSP |
| `src/backend/src/config/cors.ts` | CORS validation logic |
| `src/frontend/vite.config.ts` | Vite proxy, base path |
| `src/frontend/src/components/ChatWidget.tsx` | WS/API URL resolution |
| `src/web/src/components/ChatPopup.tsx` | Widget iframe embedding |
| `src/web/src/components/FloatingActions.tsx` | Chat bubble, kill switch |
| `src/web/src/lib/admin.ts` | API base URL |
| `src/web/src/app/verify-email/page.tsx` | Email verification API URL |
| `src/web/next.config.ts` | Next.js configuration |
| `Dockerfile` | Production multi-stage build |
| `docker-compose.yml` | Dev multi-service orchestration |
| `src/backend/Dockerfile` | Backend + widget build |
| `src/frontend/Dockerfile` | Frontend dev server |
| `deploy/pilot/nginx.conf` | Reverse proxy template |
| `docs/guides/deployment.md` | Deployment reference |
