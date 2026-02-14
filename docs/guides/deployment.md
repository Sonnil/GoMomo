# Deployment Guide

> **Goal:** Take gomomo.ai from local dev to a production URL.
> Covers Docker, Railway, Render, Fly.io, and bare VPS.

---

## Table of Contents

1. [Pre-Deployment Checklist](#1-pre-deployment-checklist)
2. [Environment Variables Reference](#2-environment-variables-reference)
3. [Option A: Railway](#3-option-a-railway)
4. [Option B: Render](#4-option-b-render)
5. [Option C: Fly.io](#5-option-c-flyio)
6. [Option D: Docker on VPS](#6-option-d-docker-on-vps)
7. [Frontend Deployment](#7-frontend-deployment)
8. [Database Setup](#8-database-setup)
9. [Post-Deploy Verification](#9-post-deploy-verification)
10. [SSL & Custom Domain](#10-ssl--custom-domain)
11. [Monitoring & Alerts](#11-monitoring--alerts)

---

## 1. Pre-Deployment Checklist

Before deploying, confirm:

- [ ] PostgreSQL 16 instance is provisioned (see [Database Setup](#8-database-setup))
- [ ] `OPENAI_API_KEY` is a production key (not a test key with rate limits)
- [ ] `ENCRYPTION_KEY` is a real 32+ character secret (not the dev placeholder)
- [ ] `CORS_ORIGIN` is set to your frontend domain
- [ ] `NODE_ENV=production`
- [ ] If using Google Calendar: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` point to production URLs
- [ ] If using Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` are set
- [ ] `TWILIO_WEBHOOK_BASE_URL` points to your production backend URL

---

## 2. Environment Variables Reference

### Required

| Variable | Example | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://user:pass@host:5432/dbname?sslmode=require` | PostgreSQL connection string |
| `OPENAI_API_KEY` | `sk-...` | OpenAI API key |
| `NODE_ENV` | `production` | Must be `production` for production deploys |
| `ENCRYPTION_KEY` | `a1b2c3d4e5...` (32+ chars) | Encrypts OAuth tokens at rest |
| `CORS_ORIGIN` | `https://your-app.com` | Allowed frontend origins |

### Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | `fatal` / `error` / `warn` / `info` / `debug` |
| `OPENAI_MODEL` | `gpt-4o` | LLM model name |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | LLM API endpoint |
| `HOLD_TTL_MINUTES` | `5` | How long a time-slot hold lasts |

### Google Calendar (Optional)

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | `https://api.your-app.com/api/oauth/google/callback` |

### Twilio Voice/SMS (Optional)

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | E.164 format (e.g., `+15551234567`) |
| `TWILIO_WEBHOOK_BASE_URL` | `https://api.your-app.com` |
| `VOICE_ENABLED` | `true` / `false` |
| `SMS_HANDOFF_ENABLED` | `true` / `false` |
| `SMS_HANDOFF_WEB_URL` | Frontend URL for handoff links |

### Excel Integration (Optional)

| Variable | Description |
|---|---|
| `EXCEL_ENABLED` | `true` / `false` (global kill switch) |
| `EXCEL_DEFAULT_FILE_PATH` | Local file path override |
| `EXCEL_RECONCILIATION_INTERVAL_MS` | Default `300000` (5 min) |

---

## 3. Option A: Railway

[Railway](https://railway.app) is the fastest path to production.

### 3.1 Backend

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project
railway init

# Provision PostgreSQL
railway add --plugin postgresql

# Set environment variables
railway variables set NODE_ENV=production
railway variables set OPENAI_API_KEY=sk-...
railway variables set ENCRYPTION_KEY=your-secret-key-here
railway variables set CORS_ORIGIN=https://your-frontend.railway.app

# Deploy (from src/backend/)
cd src/backend
railway up
```

Railway auto-detects the Dockerfile, builds, and deploys. The `DATABASE_URL`
is injected automatically from the PostgreSQL plugin.

### 3.2 Run Migrations

```bash
railway run npx tsx src/db/migrate.ts
railway run npx tsx src/db/seed.ts
```

### 3.3 Frontend

```bash
cd src/frontend
railway init   # Separate service
railway variables set VITE_API_URL=https://your-backend.railway.app
railway variables set VITE_WS_URL=https://your-backend.railway.app
railway up
```

**Estimated cost:** ~$5–20/mo depending on usage.

---

## 4. Option B: Render

[Render](https://render.com) offers free PostgreSQL (90-day) and simple deploys.

### 4.1 Backend Web Service

1. Connect your GitHub repo
2. **Root Directory:** `src/backend`
3. **Build Command:** `npm install && npm run build`
4. **Start Command:** `node dist/index.js`
5. Add environment variables in the dashboard

### 4.2 Database

1. Create a PostgreSQL instance in Render
2. Copy the **Internal Database URL** → paste as `DATABASE_URL`

### 4.3 Run Migrations (One-Time)

Use Render's **Shell** tab:

```bash
npx tsx src/db/migrate.ts
npx tsx src/db/seed.ts
```

### 4.4 Frontend Static Site

1. Create a Static Site
2. **Root Directory:** `src/frontend`
3. **Build Command:** `npm install && npm run build`
4. **Publish Directory:** `dist`
5. Set env: `VITE_API_URL=https://your-backend.onrender.com`

**Estimated cost:** Free tier → $7/mo (paid) for backend + $0 for static site.

---

## 5. Option C: Fly.io

[Fly.io](https://fly.io) runs Docker containers globally.

### 5.1 Setup

```bash
# Install flyctl
brew install flyctl

# Login
fly auth login

# From src/backend/
cd src/backend
fly launch
```

### 5.2 Provision PostgreSQL

```bash
fly postgres create --name ai-receptionist-db
fly postgres attach ai-receptionist-db
```

### 5.3 Set Secrets

```bash
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set ENCRYPTION_KEY=your-secret-key
fly secrets set NODE_ENV=production
fly secrets set CORS_ORIGIN=https://your-frontend.fly.dev
```

### 5.4 Deploy

```bash
fly deploy
```

### 5.5 Run Migrations

```bash
fly ssh console
npx tsx src/db/migrate.ts
npx tsx src/db/seed.ts
```

**Estimated cost:** ~$5–15/mo.

---

## 6. Option D: Docker on VPS

For full control (DigitalOcean, Hetzner, AWS EC2, etc.).

### 6.1 Server Requirements

| Spec | Minimum | Recommended |
|---|---|---|
| CPU | 1 vCPU | 2 vCPUs |
| RAM | 1 GB | 2 GB |
| Disk | 10 GB | 20 GB |
| OS | Ubuntu 22.04+ | Ubuntu 24.04 |

### 6.2 Deploy

```bash
# On the server:
git clone <your-repo-url> /opt/ai-receptionist
cd /opt/ai-receptionist

# Create production .env
cp .env.example .env
nano .env   # Set all production values

# Build and start
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# Run migrations
docker compose exec backend npx tsx src/db/migrate.ts
docker compose exec backend npx tsx src/db/seed.ts
```

### 6.3 Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name api.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/api.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **WebSocket note:** The `Upgrade` and `Connection` headers are required
> for Socket.IO to work through nginx.

---

## 7. Frontend Deployment

The React frontend is a static Vite build. Deploy to **any** static host.

### Build

```bash
cd src/frontend
VITE_API_URL=https://api.your-domain.com \
VITE_WS_URL=https://api.your-domain.com \
npm run build
```

Output: `dist/` folder with static HTML/JS/CSS.

### Deploy Options

| Host | Command | Cost |
|---|---|---|
| **Vercel** | `npx vercel --prod` | Free |
| **Netlify** | Drag `dist/` to netlify.com | Free |
| **Cloudflare Pages** | `npx wrangler pages deploy dist` | Free |
| **S3 + CloudFront** | `aws s3 sync dist/ s3://bucket` | ~$1/mo |
| **Same Docker** | Already included in docker-compose | $0 extra |

---

## 8. Database Setup

### Managed PostgreSQL Providers

| Provider | Free Tier | Paid | Notes |
|---|---|---|---|
| **Supabase** | 500 MB | $25/mo | Built-in dashboard |
| **Neon** | 512 MB | $19/mo | Serverless, auto-scaling |
| **Railway** | — | ~$5/mo | Auto-provisioned |
| **Render** | 90-day free | $7/mo | Simple setup |
| **AWS RDS** | 12-month free tier | ~$15/mo | Production-grade |
| **DigitalOcean** | — | $15/mo | Managed, daily backups |

### Required Extension

The `btree_gist` extension must be available (it's used by the
`EXCLUDE` constraint for overbooking prevention).

Most managed providers include it. To verify:

```sql
SELECT * FROM pg_available_extensions WHERE name = 'btree_gist';
```

If not enabled:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

> **Note:** The migration script (`001_initial.sql`) runs this automatically,
> but some managed providers require you to enable it via their dashboard first.

### Backup Strategy

| Environment | Strategy |
|---|---|
| Development | Docker volume (local) — no backup needed |
| Staging | Daily automated backup (managed provider) |
| Production | Daily backup + point-in-time recovery + off-site copy |

---

## 9. Post-Deploy Verification

After deploying, run through this checklist:

```bash
# 1. Health check
curl https://api.your-domain.com/health
# Expected: { "status": "ok", "timestamp": "..." }

# 2. Tenant exists
curl https://api.your-domain.com/api/tenants/demo-clinic
# Expected: tenant JSON with services and hours

# 3. Availability works
curl "https://api.your-domain.com/api/tenants/TENANT_ID/availability?start=2026-02-07T00:00:00Z&end=2026-02-07T23:59:59Z"
# Expected: array of time slots

# 4. Chat widget connects
# Open https://your-frontend.com — widget should show and connect via WebSocket

# 5. (If voice enabled) Twilio webhooks
# Configure Twilio phone number webhook to:
#   https://api.your-domain.com/twilio/voice/incoming
# Make a test call to your Twilio number
```

---

## 10. SSL & Custom Domain

### Let's Encrypt (Free SSL)

```bash
# On VPS:
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.your-domain.com
sudo certbot --nginx -d your-domain.com
```

Auto-renews every 90 days.

### Twilio Webhook SSL Requirement

Twilio **requires** HTTPS for webhook URLs. Ensure your backend is behind
SSL before configuring Twilio phone numbers.

---

## 11. Monitoring & Alerts

### Recommended Stack

| Tool | Purpose | Cost |
|---|---|---|
| **Sentry** | Error tracking | Free (5K events/mo) |
| **Better Uptime** / **UptimeRobot** | Uptime monitoring | Free |
| **Logflare** / **Axiom** | Log aggregation | Free tier |
| **PagerDuty** / **OpsGenie** | Alert routing | Free tier |

### Health Check Endpoint

The `/health` endpoint returns `200 OK` with:

```json
{ "status": "ok", "timestamp": "2026-02-06T12:00:00.000Z" }
```

Point your uptime monitor at this URL with a 30-second check interval.

### Key Metrics to Monitor

| Metric | Source | Alert Threshold |
|---|---|---|
| Uptime | Health check endpoint | < 99.9% |
| API response time (p95) | Application logs | > 2 seconds |
| Error rate | Sentry / logs | > 1% of requests |
| Database connections | PostgreSQL metrics | > 80% of pool |
| LLM API latency | Application logs | > 5 seconds |
| Twilio webhook failures | Twilio console | Any 5xx |
