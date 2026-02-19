# Release Process — gomomo.ai

> **Source of truth** for the Release Captain workflow.
> No code reaches production without passing every gate in this document.

---

## 1. Roles

| Role | Who | Responsibility |
|------|-----|----------------|
| **Developer** | EON (agent) | Implements features/fixes on a branch |
| **Release Captain** | EON sub-agent | Validates readiness, generates Release Report, enforces gates |
| **Approver** | Sunny (human) | Reviews Release Report, gives explicit deploy authorization |

---

## 2. Workflow Overview

```
Feature Branch
    │
    ▼
┌──────────────────────┐
│  1. EON implements    │
│     feature / fix     │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  2. Local Platform    │
│     Mode (3 services) │
│     3000 / 5173 / 3001│
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  3. Release Captain   │
│     runs validation   │
│     pack (Gate 1-5)   │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  4. Release Report    │
│     generated &       │
│     presented to      │
│     Sunny             │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  5. Sunny reviews     │
│     "Approved to ship"│
│     or "Hold — fix X" │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  6. Release Captain   │
│     pushes to prod    │
│     GitHub → Vercel   │
│     → Railway → Resend│
└──────────────────────┘
```

---

## 3. Validation Gates

Release Captain MUST pass **all five gates** before generating the Release Report.

### Gate 1 — Service Health

All three services must be running via VS Code Tasks and returning HTTP 200:

| Service | Port | VS Code Task | Health Check |
|---------|------|--------------|--------------|
| Backend (Fastify) | `3000` | `backend-server` | `curl -s http://localhost:3000/health` |
| Widget (Vite) | `5173` | `vite-dev-server` | `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` |
| Web App (Next.js) | `3001` | `nextjs-dev-server` | `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/` |

**How to start:** VS Code Tasks only — `⌘⇧P` → Tasks: Run Task → select task.
**Never** start services via `run_in_terminal`.

### Gate 2 — Full Test Suite

```bash
cd src/backend && npx vitest run
cd src/frontend && npx vitest run
```

Both must exit with **0 failures**. The Release Report must include exact pass/fail/skip counts.

### Gate 3 — Deterministic E2E Tests

```bash
cd src/backend && npx vitest run tests/e2e-error-verification.test.ts
cd src/backend && npx vitest run tests/error-mapping.test.ts
```

These are the structured-error-handling smoke tests. All must pass.

### Gate 4 — Next.js Production Build

```bash
cd src/web && npm run build
```

Must complete with exit code 0. This catches TypeScript errors, missing imports, and build-time failures that `next dev` silently ignores.

### Gate 5 — PII Scan

```bash
bash scripts/pii-scan.sh
```

Scans logs and output for raw email addresses, API keys, or tokens. Only `email_hash` values are acceptable. Any raw PII = **hard block**.

---

## 4. Release Report

After all gates pass, Release Captain generates a report using the template in `docs/release-report-template.md`. The report includes:

- Branch name and HEAD commit hash
- Diff summary (files changed, insertions, deletions)
- Test results (backend + frontend counts)
- Service health status (all three ports + HTTP codes)
- E2E test results
- Next.js build status
- PII scan result
- Risks and rollback plan

The report is presented to Sunny **in chat** for review.

---

## 5. Deploy Authorization

### Approval

Sunny must explicitly say one of:
- **"Approved to ship"**
- **"Ship it"**
- **"Deploy"**

Any other response (silence, questions, "looks good but...") is **NOT approval**.

### Rejection

If Sunny says:
- **"Hold"**, **"Fix X first"**, **"Not yet"** — Release Captain stops. EON fixes the issue, then the entire validation cycle restarts from Gate 1.

---

## 6. Deploy Sequence

Only after explicit approval:

```
1. git push origin <branch>           # Push to GitHub
2. Vercel auto-deploys src/web        # Verify preview URL
3. Railway auto-deploys src/backend   # Verify /health endpoint
4. Resend webhook verification        # Confirm email delivery
5. Post-deploy smoke test             # Hit production endpoints
```

### Post-Deploy Checks

| Check | Command/Action | Expected |
|-------|---------------|----------|
| Backend health | `curl https://api.gomomo.ai/health` | `200 + JSON` |
| Web app | Visit `https://gomomo.ai` | Page loads |
| Widget embed | Visit test page with embed snippet | Chat widget renders |
| Email delivery | Trigger test booking | Confirmation email received |

---

## 7. Rollback Plan

If any post-deploy check fails:

1. **Railway:** Roll back to previous deploy via Railway dashboard
2. **Vercel:** Promote previous deployment via Vercel dashboard
3. **Notify Sunny** with failure details and rollback confirmation

---

## 8. Guardrails — Preventing Unauthorized Deploy

| Guardrail | Enforcement |
|-----------|-------------|
| No deploy without "Approved to ship" from Sunny | Release Captain checks for explicit approval text |
| No deploy with failing gates | Release Report cannot be generated if any gate fails |
| No deploy with PII leaks | Gate 5 is a hard block |
| No deploy without all 3 services verified | Gate 1 must pass first |
| No direct production pushes | All deploys go through the branch → PR → merge flow |
| Release Captain cannot self-approve | Only Sunny (human) can authorize |
| Audit trail | Every release attempt logged in `.eon/gate-log.yaml` |

---

## 9. Triggering Release Captain

Sunny can invoke the Release Captain with a single prompt:

> **"Release Captain: validate and prepare for deploy"**

Or shorter variants:
- **"RC: run validation"**
- **"Prepare release"**
- **"Run release gates"**

Release Captain will then:
1. Verify all 3 services are running (or start them via VS Code Tasks)
2. Run Gates 1–5 sequentially
3. Generate the Release Report
4. Present it to Sunny and wait for approval

---

## 10. File References

| File | Purpose |
|------|---------|
| `docs/release-process.md` | This document — authoritative workflow |
| `docs/release-report-template.md` | Template for Release Reports |
| `scripts/verify-all.sh` | Automated validation script (Gates 1–4) |
| `scripts/pii-scan.sh` | PII scan script (Gate 5) |
| `.vscode/tasks.json` | VS Code Task definitions for all services |
| `.eon/agents/release-captain.yaml` | Release Captain agent configuration |
| `.eon/gate-log.yaml` | Audit trail for gate results |
| `docs/manual-restart-instructions.md` | Service management reference |

---

*Last updated: 2026-02-18 — Release Captain sub-agent introduced.*
