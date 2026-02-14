# Quickstart Guide

> **Goal:** Clone the repo → run a live booking demo → embed on a test site.
> **Time:** ~15 minutes.

---

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| **Docker** + Docker Compose | 20+ | `docker --version` |
| **Node.js** | 20+ | `node --version` |
| **Git** | any | `git --version` |
| **OpenAI API key** | — | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

> **Don't have an OpenAI key?** You can still run the **Demo Mode** (Step 4b) which
> uses a built-in NLU engine — no LLM needed.

---

## Step 1: Clone & Install

```bash
git clone <your-repo-url> ai-receptionist
cd ai-receptionist
```

## Step 2: Configure Environment

```bash
# Copy the example environment file
cp .env.example src/backend/.env

# Edit — at minimum set your OpenAI key:
#   OPENAI_API_KEY=sk-...
```

**Minimal `.env` for a working system:**

```env
DATABASE_URL=postgresql://receptionist:receptionist_dev@localhost:5432/receptionist
OPENAI_API_KEY=sk-your-key-here
```

Everything else has sensible defaults. See [Tenant Configuration](./tenant-configuration.md)
for the full reference.

## Step 3: Start the Stack

### Option A: Docker Compose (Recommended)

```bash
docker compose up --build
```

This starts:
- **PostgreSQL 16** on port 5432
- **Backend API** on port 3000
- **React frontend** on port 5173

Wait for: `Server listening on http://0.0.0.0:3000`

### Option B: Local Node.js

```bash
# Terminal 1: Start PostgreSQL (if not using Docker)
# Ensure PostgreSQL 16 is running with the btree_gist extension

# Terminal 2: Backend
cd src/backend
npm install
npx tsx src/db/migrate.ts   # Run database migrations
npx tsx src/db/seed.ts      # Create demo tenant
npx tsx src/index.ts         # Start server

# Terminal 3: Frontend
cd src/frontend
npm install
npm run dev                  # Vite dev server on :5173
```

## Step 4: Seed a Demo Tenant

If using Docker Compose:

```bash
docker compose exec backend npx tsx src/db/seed.ts
```

This creates a **"Demo Clinic"** tenant:
- Mon–Thu 9 AM–5 PM, Fri 9 AM–4 PM (Eastern)
- Services: General Consultation (30m), Follow-up (15m), Extended (60m)

## Step 5: Book Your First Appointment

Open **http://localhost:5173** in your browser.

The chat widget auto-connects via WebSocket. Try this conversation:

```
You:  "Hi, I'd like to book an appointment"
AI:   "Welcome! What service are you interested in?"
You:  "General consultation"
AI:   "Great! When would you like to come in?"
You:  "Tomorrow at 10am"
AI:   [Checks availability → offers slots]
You:  "10am works"
AI:   [Holds slot] "Can I get your name?"
You:  "Jane Smith"
AI:   "And your email?"
You:  "jane@example.com"
AI:   "You're all set! Booking confirmed: [reference code]"
```

**Verify in the API:**

```bash
curl http://localhost:3000/api/tenants/demo-clinic/appointments/lookup?email=jane@example.com
```

## Step 4b: Demo Mode (No Database / No LLM)

If you want to run a standalone demo without PostgreSQL or an OpenAI key:

```bash
cd src/backend
npx tsx src/demo-server.ts
```

Open **http://localhost:3000** — this runs the **Bloom Wellness Studio** demo
with a built-in NLU engine, dynamic slot generation, and a polished chat UI.

> Perfect for investor demos, stakeholder presentations, or sales calls.

---

## Step 6: Connect Google Calendar (Optional)

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Google Calendar API**
3. Create OAuth 2.0 credentials (Web application)
4. Set redirect URI to `http://localhost:3000/api/oauth/google/callback`
5. Add to `.env`:
   ```env
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```
6. Restart the backend, then:
   ```bash
   # Get the tenant ID
   curl http://localhost:3000/api/tenants/demo-clinic | jq '.id'

   # Get the OAuth URL
   curl http://localhost:3000/api/tenants/<TENANT_ID>/oauth/google | jq '.url'

   # Visit the URL in your browser → authorize → tokens auto-save
   ```

Now every booking also creates a Google Calendar event in real-time.

---

## Step 7: Embed the Widget on Your Site

Add this to any HTML page:

```html
<!-- gomomo.ai Widget -->
<script>
  window.AI_RECEPTIONIST_CONFIG = {
    apiUrl: 'http://localhost:3000',   // Your backend URL
    wsUrl: 'http://localhost:3000',    // WebSocket URL  
    tenantId: 'YOUR_TENANT_ID',       // From tenant creation
  };
</script>
<script src="http://localhost:5173/src/main.tsx" type="module"></script>
```

> In production, the frontend is built as a static bundle and served via CDN.
> See the [Deployment Guide](./deployment.md) for production embedding.

---

## What's Next?

| Guide | What You'll Learn |
|---|---|
| [Deployment](./deployment.md) | Deploy to Railway, Render, Fly.io, or bare Docker |
| [Tenant Configuration](./tenant-configuration.md) | Full config schema — services, hours, persona, branding |
| [Adding a Calendar Provider](./adding-a-calendar-provider.md) | Integrate Outlook, Cal.com, or any CalDAV server |
| [Adding a Channel](./adding-a-channel.md) | Add WhatsApp, email, or a custom intake channel |

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `❌ Invalid environment variables` | Check that `DATABASE_URL` and `OPENAI_API_KEY` are set in `.env` |
| `ECONNREFUSED :5432` | PostgreSQL isn't running. Start Docker Compose or your local instance. |
| Chat widget shows "error" | Check backend logs: `docker compose logs backend -f` |
| `btree_gist` error on migration | Run `CREATE EXTENSION IF NOT EXISTS btree_gist;` in your PostgreSQL |
| Port 3000 already in use | `lsof -ti:3000 \| xargs kill -9` or change `PORT` in `.env` |
