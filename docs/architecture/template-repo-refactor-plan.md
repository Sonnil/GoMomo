# gomomo.ai — Template Repo Refactor Plan

> Project: prj-20260205-001 | Version: 1.0.0 | Date: 2026-02-06
> Classification: INTERNAL — Architecture
> Status: Approved for Implementation

---

## Table of Contents

1. [Goal & Principles](#1-goal--principles)
2. [Current State Assessment](#2-current-state-assessment)
3. [Target Architecture](#3-target-architecture)
4. [Adapter Patterns](#4-adapter-patterns)
5. [Config Schema](#5-config-schema)
6. [Repo Structure (Target)](#6-repo-structure-target)
7. [Migration Playbook](#7-migration-playbook)
8. [Demo Tenant: "Bloom Wellness Studio"](#8-demo-tenant-bloom-wellness-studio)
9. [What Ships Now vs Later](#9-what-ships-now-vs-later)

---

## 1. Goal & Principles

**Goal:** Convert gomomo.ai codebase into a reusable, forkable template that
EON can clone once per client engagement. Each fork = one client. The core stays
upstream so bug-fixes and features flow down to all forks.

### Design Principles

| # | Principle | Implication |
|---|---|---|
| 1 | **Fork-and-configure, not fork-and-hack** | All client-specific data lives in config/seed — zero code changes for 90% of deployments |
| 2 | **Adapter interfaces over concrete imports** | Calendar, channel, and booking-store integrations are behind interfaces. Swap by changing one factory file. |
| 3 | **Env vars for infrastructure, JSONB for business** | Secrets/endpoints → `.env`. Business rules (hours, services, persona) → `tenants` table JSONB |
| 4 | **Multi-tenant first, single-tenant trivial** | The DB schema always has `tenant_id`. For a single-client deploy, there's simply one row. |
| 5 | **Progressive disclosure** | Default config works out-of-the-box. Advanced options (Excel sync, voice, SharePoint) are opt-in feature flags. |
| 6 | **Guide-per-extension** | Every adapter type has a `docs/guides/adding-a-*.md` with the interface contract, a scaffold command, and a worked example. |

---

## 2. Current State Assessment

### 2.1 What's Already Good (Keep)

| Pattern | Where | Status |
|---|---|---|
| Multi-tenant DB schema (`tenant_id` on every table) | `repos/*`, `migrations/*` | ✅ Solid |
| BookingStore interface + factory | `domain/interfaces.ts`, `stores/*` | ✅ Clean adapter pattern |
| Per-tenant feature flags (Excel) | `env.ts` global + `tenant.excel_integration` JSONB | ✅ Good pattern |
| Deterministic AI agent (tool-calling) | `agent/*` | ✅ Core IP |
| System prompt built from tenant config | `agent/system-prompt.ts` | ✅ Already parameterized |
| Demo mode (no external deps) | `demo-server.ts` | ✅ Useful for sales |
| Zod-validated env config | `config/env.ts` | ✅ Type-safe |
| Docker Compose for local dev | `docker-compose.yml` | ✅ One-command start |

### 2.2 What Needs Refactoring

| Issue | Current | Target |
|---|---|---|
| **Calendar is hard-wired to Google** | `calendar.service.ts` directly imports `googleapis` | Extract `CalendarProvider` interface; Google becomes one adapter |
| **No channel abstraction** | Web chat lives in `index.ts` (Socket.IO inline), voice in `voice/*` | Extract `Channel` interface; each channel is a Fastify plugin |
| **Availability service imports `appointmentRepo` directly** | `availability.service.ts` line 4 | Should use `BookingStore` interface (already exists but unused here) |
| **Tenant config is implicit** | Services, hours, persona tone are columns — but no schema doc or validation | Add Zod schema for tenant config, document for admin UI |
| **No tenant seed template** | `seed.ts` has one hard-coded clinic | Make it config-driven from a YAML/JSON fixture |
| **README is project-specific** | References EON governance, specific project ID | Genericize for template repo; project-specific info in `.eon/` only |
| **No `.env.example`** | Referenced in README but doesn't exist in repo root | Create comprehensive example |

### 2.3 Coupling Map

```
Hard Coupling (import chains that must be broken):

  availability.service.ts ──imports──▶ appointmentRepo (concrete)
  calendar.service.ts ─────imports──▶ googleapis (concrete)
  booking.service.ts ──────imports──▶ calendarService (concrete)
  index.ts ─────────────────inline──▶ Socket.IO setup (no channel interface)
  voice/*.ts ───────────────inline──▶ Twilio TwiML (no channel interface)

Clean Coupling (already behind interfaces):

  booking.service.ts ──uses──▶ BookingStore (interface) via factory ✅
  excel-sync-adapter.ts ─────▶ BookingStore decorator ✅
  system-prompt.ts ───────────▶ Tenant config (parameterized) ✅
```

---

## 3. Target Architecture

### 3.1 Layer Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                     CHANNEL ADAPTERS                          │
│                                                               │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│   │ WebChatChannel│  │ VoiceChannel │  │ [Future: Email,  │  │
│   │ (Socket.IO)  │  │ (Twilio)     │  │  WhatsApp, etc.] │  │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘  │
│          │                 │                  │               │
│          ▼                 ▼                  ▼               │
│   ┌──────────────────────────────────────────────────────┐   │
│   │              CHANNEL INTERFACE                         │   │
│   │  register(app: FastifyInstance): Promise<void>         │   │
│   │  shutdown(): Promise<void>                             │   │
│   └──────────────────────┬───────────────────────────────┘   │
└──────────────────────────┼───────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────┐
│                    CORE ENGINE                                │
│                                                               │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│   │ AI Agent     │  │ Booking      │  │ Availability     │  │
│   │ (tool-call)  │  │ Service      │  │ Service          │  │
│   └──────────────┘  └──────┬───────┘  └──────┬───────────┘  │
│                            │                  │               │
│                            ▼                  ▼               │
│   ┌──────────────────────────────────────────────────────┐   │
│   │           INTEGRATION ADAPTERS                         │   │
│   │                                                        │   │
│   │ ┌────────────────┐ ┌────────────────┐ ┌────────────┐  │   │
│   │ │CalendarProvider │ │BookingStore    │ │SyncAdapter │  │   │
│   │ │  (interface)   │ │  (interface)   │ │  (interface)│  │   │
│   │ └───────┬────────┘ └───────┬────────┘ └─────┬──────┘  │   │
│   │         │                  │                 │          │   │
│   │    ┌────┴────┐       ┌────┴────┐       ┌────┴────┐    │   │
│   │    │ Google  │       │Postgres │       │ Excel   │    │   │
│   │    │ Outlook │       │BookStore│       │ GSheets │    │   │
│   │    │ Cal.com │       │         │       │ Notion  │    │   │
│   │    └─────────┘       └─────────┘       └─────────┘    │   │
│   └────────────────────────────────────────────────────────┘   │
│                                                               │
└───────────────────────────┬──────────────────────────────────┘
                            │
                    ┌───────┴───────┐
                    │  PostgreSQL   │
                    │  (source of   │
                    │   truth)      │
                    └───────────────┘
```

### 3.2 Key Interfaces

```typescript
// ── CalendarProvider ─────────────────────────────────
interface CalendarProvider {
  readonly name: string;                    // 'google' | 'outlook' | 'caldav' | 'none'
  getAuthUrl(tenantId: string): string;
  handleCallback(code: string, tenantId: string): Promise<void>;
  createEvent(tenant: Tenant, event: CalendarEvent): Promise<string>;
  deleteEvent(tenant: Tenant, eventId: string): Promise<void>;
  listEvents(tenant: Tenant, from: Date, to: Date): Promise<CalendarEvent[]>;
}

// ── Channel ─────────────────────────────────────────
interface Channel {
  readonly name: string;                    // 'web-chat' | 'voice-twilio' | 'sms'
  register(app: FastifyInstance): Promise<void>;
  shutdown(): Promise<void>;
}

// ── BookingStore (already exists) ────────────────────
// interface BookingStore { ... }  // ← domain/interfaces.ts

// ── SyncAdapter (already exists as pattern) ──────────
// ExcelSyncAdapter, future: GoogleSheetsSyncAdapter, NotionSyncAdapter
```

---

## 4. Adapter Patterns

### 4.1 CalendarProvider Pattern

**Current:** `calendar.service.ts` is a single object with Google-specific code.

**Target:** Extract interface → move Google code to `integrations/calendar/google.ts` →
factory selects provider based on tenant config.

```
src/integrations/calendar/
├── index.ts                  # CalendarProvider interface + factory
├── google-calendar.ts        # Google Calendar API v3 adapter
├── no-op-calendar.ts         # Default when no calendar connected (DB-only scheduling)
├── outlook-calendar.ts       # [future] Microsoft Graph adapter
└── caldav-calendar.ts        # [future] CalDAV generic adapter
```

**Factory logic:**
```typescript
function getCalendarProvider(tenant: Tenant): CalendarProvider {
  if (tenant.google_oauth_tokens) return googleCalendarProvider;
  if (tenant.outlook_oauth_tokens) return outlookCalendarProvider;
  return noOpCalendarProvider; // Still works — just no external sync
}
```

**Migration cost:** Low. The current `calendarService` already has the right method signatures.
Wrap it in a class, extract the interface, done.

### 4.2 Channel Pattern

**Current:** Web chat is inline in `index.ts` (Socket.IO setup + handlers). Voice is in `voice/*`.

**Target:** Each channel is a self-contained Fastify plugin that registers its own routes,
event handlers, and lifecycle hooks.

```
src/channels/
├── index.ts                  # Channel interface + registry
├── web-chat/
│   ├── plugin.ts             # Fastify plugin: registers Socket.IO
│   └── handler.ts            # Message handler (current chat logic)
├── voice-twilio/
│   ├── plugin.ts             # Fastify plugin: registers /twilio/* routes
│   ├── conversation-engine.ts
│   ├── nlu.ts
│   ├── session-manager.ts
│   ├── sms-sender.ts
│   ├── twiml-builder.ts
│   └── handoff/
│       ├── routes.ts
│       └── token.ts
└── [future-channel]/
    └── plugin.ts
```

**Registration in `index.ts`:**
```typescript
import { webChatChannel } from './channels/web-chat/plugin.js';
import { voiceTwilioChannel } from './channels/voice-twilio/plugin.js';

const channels: Channel[] = [];

// Always register web chat
channels.push(webChatChannel);

// Conditionally register voice
if (env.VOICE_ENABLED === 'true') {
  channels.push(voiceTwilioChannel);
}

for (const channel of channels) {
  await channel.register(app);
}
```

**Migration cost:** Medium. Socket.IO setup moves out of `index.ts` into a plugin.
Voice routes are already in a separate directory — mostly a re-organization.

### 4.3 BookingStore Pattern (Already Done ✅)

The `BookingStore` interface + `PostgresBookingStore` + `ExcelSyncAdapter` pattern
is already clean. No changes needed.

### 4.4 Sync Adapter Pattern (Already Done ✅)

The `ExcelSyncAdapter` decorator + `syncEmitter` + `SyncWorker` pattern is
already generalized enough. Future sync adapters (Google Sheets, Notion) follow
the same decorator pattern.

---

## 5. Config Schema

### 5.1 Tenant Configuration (JSONB in DB)

The `tenants` table is the single source of truth for all business config.
This is what an admin UI or onboarding wizard writes to.

```typescript
// ── Tenant Config Schema (Zod) ──────────────────────

const TenantConfigSchema = z.object({
  // ── Identity ──
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(2).max(100),
  timezone: z.string(),                          // IANA timezone

  // ── Scheduling ──
  slot_duration: z.number().int().min(5).max(240).default(30),
  business_hours: BusinessHoursSchema,            // Per-day open/close
  services: z.array(ServiceSchema).min(1),        // At least one service

  // ── AI Persona ──
  persona: PersonaSchema.optional().default({
    tone: 'professional-friendly',
    greeting: null,                               // null = auto-generate
    farewell: null,
    business_description: null,                   // Injected into system prompt
    special_instructions: null,                   // e.g. "Always ask about allergies"
  }),

  // ── Calendar Integration ──
  calendar_provider: z.enum(['google', 'outlook', 'caldav', 'none']).default('none'),
  google_calendar_id: z.string().nullable().default(null),
  google_oauth_tokens: GoogleOAuthTokensSchema.nullable().default(null),

  // ── Excel/Sync Integration ──
  excel_integration: ExcelIntegrationSchema.nullable().default(null),

  // ── Voice/Phone ──
  voice_enabled: z.boolean().default(false),
  voice_phone_number: z.string().nullable().default(null),  // Twilio E.164
  voice_persona: VoicePersonaSchema.optional().default({
    voice: 'Polly.Joanna',
    language: 'en-US',
    speed: 1.0,
  }),

  // ── SMS ──
  sms_enabled: z.boolean().default(false),

  // ── Branding ──
  branding: BrandingSchema.optional().default({
    primary_color: '#4F46E5',
    logo_url: null,
    widget_title: 'Book an Appointment',
    powered_by: true,
  }),
});

const ServiceSchema = z.object({
  name: z.string().min(1),
  duration: z.number().int().min(5),
  description: z.string().optional(),
  price: z.string().optional(),                   // Display only (e.g. "$150")
});

const BusinessHoursSchema = z.object({
  monday:    DayHoursSchema.nullable(),
  tuesday:   DayHoursSchema.nullable(),
  wednesday: DayHoursSchema.nullable(),
  thursday:  DayHoursSchema.nullable(),
  friday:    DayHoursSchema.nullable(),
  saturday:  DayHoursSchema.nullable(),
  sunday:    DayHoursSchema.nullable(),
});

const DayHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),       // HH:mm
  end:   z.string().regex(/^\d{2}:\d{2}$/),
});

const PersonaSchema = z.object({
  tone: z.enum([
    'professional-friendly',
    'warm-casual',
    'formal-clinical',
    'energetic-fun',
  ]).default('professional-friendly'),
  greeting: z.string().max(500).nullable(),
  farewell: z.string().max(500).nullable(),
  business_description: z.string().max(1000).nullable(),
  special_instructions: z.string().max(2000).nullable(),
});

const VoicePersonaSchema = z.object({
  voice: z.string().default('Polly.Joanna'),
  language: z.string().default('en-US'),
  speed: z.number().min(0.5).max(2.0).default(1.0),
});

const BrandingSchema = z.object({
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4F46E5'),
  logo_url: z.string().url().nullable().default(null),
  widget_title: z.string().max(100).default('Book an Appointment'),
  powered_by: z.boolean().default(true),
});
```

### 5.2 Environment Variables (Infrastructure)

These do NOT vary per tenant. They're deployment-level config.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `OPENAI_API_KEY` | ✅ | — | LLM API key |
| `OPENAI_MODEL` | — | `gpt-4o` | Model name |
| `OPENAI_BASE_URL` | — | `https://api.openai.com/v1` | Compatible endpoint |
| `PORT` | — | `3000` | HTTP listen port |
| `HOST` | — | `0.0.0.0` | Bind address |
| `NODE_ENV` | — | `development` | `development` / `production` / `test` |
| `LOG_LEVEL` | — | `info` | Pino log level |
| `CORS_ORIGIN` | — | `http://localhost:5173` | Allowed origins (comma-separated) |
| `ENCRYPTION_KEY` | — | dev placeholder | OAuth token encryption key |
| `HOLD_TTL_MINUTES` | — | `5` | Availability hold duration |
| `GOOGLE_CLIENT_ID` | — | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | — | — | Google OAuth secret |
| `GOOGLE_REDIRECT_URI` | — | `http://localhost:3000/api/oauth/google/callback` | OAuth callback |
| `TWILIO_ACCOUNT_SID` | — | — | Twilio SID (voice/SMS) |
| `TWILIO_AUTH_TOKEN` | — | — | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | — | — | Twilio phone number (E.164) |
| `VOICE_ENABLED` | — | `true` | Enable voice channel |
| `SMS_HANDOFF_ENABLED` | — | `true` | Enable SMS handoff |
| `EXCEL_ENABLED` | — | `false` | Enable Excel sync |

### 5.3 Admin UI Data Model (Future)

The admin UI is a CRUD interface over the `TenantConfigSchema`. Rough screens:

```
1. Dashboard          → List of tenants + status
2. Tenant > General   → Name, slug, timezone, branding
3. Tenant > Schedule  → Business hours editor, services CRUD
4. Tenant > AI        → Persona editor, test chat preview
5. Tenant > Calendar  → Connect Google/Outlook, calendar picker
6. Tenant > Phone     → Provision Twilio number, voice settings
7. Tenant > Excel     → Connect file, sync status, dead-letter queue
8. Tenant > Analytics → Conversations/day, booking rate, avg response time
```

---

## 6. Repo Structure (Target)

```
ai-receptionist-template/
│
├── README.md                           # Template overview + quickstart
├── LICENSE                             # MIT or proprietary
├── .env.example                        # All env vars with descriptions
├── docker-compose.yml                  # Postgres + backend + frontend
├── docker-compose.prod.yml             # Production overrides
│
├── docs/
│   ├── guides/
│   │   ├── quickstart.md               # Clone → first booking in 15 min
│   │   ├── deployment.md               # Docker, Railway, Render, Fly.io
│   │   ├── adding-a-calendar-provider.md
│   │   ├── adding-a-channel.md
│   │   └── tenant-configuration.md     # Config schema reference
│   ├── architecture/
│   │   ├── system-architecture.md
│   │   ├── extension-design-spec.md
│   │   ├── excel-adapter-plan.md
│   │   └── phone-mvp-implementation.md
│   └── go-to-market/
│       └── gtm-packaging-plan.md
│
├── tenants/                            # Tenant fixture files
│   ├── _schema.ts                      # Zod schema (exported for validation)
│   ├── demo-bloom-wellness.json        # Bloom Wellness Studio (demo)
│   ├── demo-clinic.json                # Demo Clinic (seed)
│   └── README.md                       # "How to add a new tenant"
│
├── src/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── index.ts                # Entry point (registers channels + adapters)
│   │   │   │
│   │   │   ├── config/
│   │   │   │   └── env.ts              # Zod-validated env vars
│   │   │   │
│   │   │   ├── domain/
│   │   │   │   ├── types.ts            # Core domain types
│   │   │   │   └── interfaces.ts       # BookingStore, CalendarProvider, Channel
│   │   │   │
│   │   │   ├── agent/                  # AI receptionist core
│   │   │   │   ├── system-prompt.ts    # Tenant-parameterized prompt builder
│   │   │   │   ├── tools.ts            # OpenAI tool definitions
│   │   │   │   ├── tool-executor.ts    # Tool dispatch
│   │   │   │   └── chat-handler.ts     # LLM conversation loop
│   │   │   │
│   │   │   ├── services/               # Business logic (channel-agnostic)
│   │   │   │   ├── availability.service.ts
│   │   │   │   ├── booking.service.ts
│   │   │   │   └── tenant.service.ts   # [new] Tenant CRUD + config validation
│   │   │   │
│   │   │   ├── repos/                  # Data access layer
│   │   │   │   ├── appointment.repo.ts
│   │   │   │   ├── hold.repo.ts
│   │   │   │   ├── tenant.repo.ts
│   │   │   │   ├── session.repo.ts
│   │   │   │   └── audit.repo.ts
│   │   │   │
│   │   │   ├── stores/                 # BookingStore implementations
│   │   │   │   ├── postgres-booking-store.ts
│   │   │   │   ├── excel-sync-adapter.ts
│   │   │   │   └── booking-store-factory.ts
│   │   │   │
│   │   │   ├── integrations/           # External service adapters
│   │   │   │   ├── calendar/
│   │   │   │   │   ├── index.ts        # CalendarProvider interface + factory
│   │   │   │   │   ├── google-calendar.ts
│   │   │   │   │   └── no-op-calendar.ts
│   │   │   │   ├── excel/
│   │   │   │   │   ├── excel-file-ops.ts
│   │   │   │   │   └── excel-sync-worker.ts
│   │   │   │   └── [future]/           # outlook/, caldav/, notion/
│   │   │   │
│   │   │   ├── channels/               # Channel adapters
│   │   │   │   ├── index.ts            # Channel interface + registry
│   │   │   │   ├── web-chat/
│   │   │   │   │   ├── plugin.ts       # Socket.IO Fastify plugin
│   │   │   │   │   └── handler.ts
│   │   │   │   └── voice-twilio/
│   │   │   │       ├── plugin.ts       # Twilio webhook Fastify plugin
│   │   │   │       ├── conversation-engine.ts
│   │   │   │       ├── nlu.ts
│   │   │   │       ├── session-manager.ts
│   │   │   │       ├── sms-sender.ts
│   │   │   │       ├── twiml-builder.ts
│   │   │   │       └── handoff/
│   │   │   │           ├── routes.ts
│   │   │   │           └── token.ts
│   │   │   │
│   │   │   ├── routes/                 # REST API routes
│   │   │   │   ├── tenant.routes.ts
│   │   │   │   ├── availability.routes.ts
│   │   │   │   ├── appointment.routes.ts
│   │   │   │   ├── oauth.routes.ts
│   │   │   │   └── chat.routes.ts
│   │   │   │
│   │   │   ├── jobs/                   # Background jobs
│   │   │   │   └── excel-reconciliation.ts
│   │   │   │
│   │   │   ├── db/
│   │   │   │   ├── client.ts
│   │   │   │   ├── migrate.ts
│   │   │   │   ├── seed.ts             # Reads from /tenants/*.json
│   │   │   │   └── migrations/
│   │   │   │       ├── 001_initial.sql
│   │   │   │       ├── 002_hardening.sql
│   │   │   │       └── 003_excel_sync.sql
│   │   │   │
│   │   │   ├── demo-server.ts          # Bloom Wellness demo (no DB)
│   │   │   └── voice-mock-server.ts    # Voice testing (no DB)
│   │   │
│   │   ├── scripts/
│   │   │   └── generate-excel-template.ts
│   │   ├── tests/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── frontend/
│       ├── src/
│       │   ├── App.tsx
│       │   ├── DemoApp.tsx
│       │   └── components/
│       │       ├── ChatWidget.tsx
│       │       └── DemoChatWidget.tsx
│       ├── Dockerfile
│       ├── package.json
│       └── vite.config.ts
│
└── .eon/                               # EON agency governance (kept separate)
    └── ...
```

### 6.1 Diff from Current → Target

| Change | Type | Impact |
|---|---|---|
| Create `src/backend/src/integrations/calendar/index.ts` | New file | CalendarProvider interface + factory |
| Move `calendar.service.ts` → `integrations/calendar/google-calendar.ts` | Rename + refactor | Implements CalendarProvider interface |
| Create `integrations/calendar/no-op-calendar.ts` | New file | Default when no calendar connected |
| Create `src/backend/src/channels/index.ts` | New file | Channel interface + registry |
| Move Socket.IO code from `index.ts` → `channels/web-chat/plugin.ts` | Extract | Clean separation |
| Move `voice/*` → `channels/voice-twilio/` | Rename | Consistent with channel pattern |
| Create `tenants/` directory with JSON fixtures | New directory | Config-driven seeding |
| Create `.env.example` at repo root | New file | Developer onboarding |
| Create docs/guides/* (4 guides) | New files | Developer documentation |
| Update `booking.service.ts` to use CalendarProvider | Edit | Dependency injection |
| Update `availability.service.ts` to use BookingStore | Edit | Consistency |
| Update `seed.ts` to read from JSON fixtures | Edit | Config-driven |

**Files unchanged:** All repos, migrations, domain types, agent logic, frontend.

---

## 7. Migration Playbook

### Phase 1: Interface Extraction (This Sprint — Non-Breaking)

These changes are additive. Existing code continues to work.

```
Step 1: Create CalendarProvider interface + factory
Step 2: Wrap calendar.service.ts as GoogleCalendarProvider (same code, new shape)
Step 3: Create NoOpCalendarProvider (returns empty arrays, no-ops writes)
Step 4: Update booking.service.ts to get provider from factory
Step 5: Update availability.service.ts to use BookingStore
```

### Phase 2: Channel Extraction (Next Sprint — Structural)

```
Step 6: Create Channel interface
Step 7: Extract Socket.IO from index.ts → web-chat plugin
Step 8: Move voice/* → channels/voice-twilio/
Step 9: Create channel registry in index.ts
Step 10: Verify all tests still pass
```

### Phase 3: Config & Docs (This Sprint — Parallel)

```
Step 11: Create .env.example
Step 12: Create tenants/ fixtures (Bloom Wellness + Demo Clinic)
Step 13: Create Zod tenant config schema
Step 14: Update seed.ts to read JSON fixtures
Step 15: Write all 4 guide documents
Step 16: Update README for template repo context
```

### Phase 4: Validation

```
Step 17: Fresh clone → docker compose up → seed → first booking test
Step 18: tsc --noEmit (zero errors)
Step 19: All existing tests pass (voice simulator, excel adapter)
Step 20: Demo mode still works (npx tsx src/demo-server.ts)
```

---

## 8. Demo Tenant: "Bloom Wellness Studio"

This is the showcase tenant, pre-configured for demos and sales calls.

```json
{
  "name": "Bloom Wellness Studio",
  "slug": "bloom-wellness",
  "timezone": "America/New_York",
  "slot_duration": 30,
  "business_hours": {
    "monday":    { "start": "09:00", "end": "18:00" },
    "tuesday":   { "start": "09:00", "end": "18:00" },
    "wednesday": { "start": "09:00", "end": "18:00" },
    "thursday":  { "start": "09:00", "end": "20:00" },
    "friday":    { "start": "09:00", "end": "17:00" },
    "saturday":  { "start": "10:00", "end": "14:00" },
    "sunday":    null
  },
  "services": [
    { "name": "Initial Wellness Consultation",  "duration": 60, "price": "$150", "description": "Comprehensive health assessment with a licensed practitioner" },
    { "name": "Follow-up Visit",                "duration": 30, "price": "$85",  "description": "Progress check and treatment adjustment" },
    { "name": "Acupuncture Session",            "duration": 45, "price": "$120", "description": "Traditional acupuncture with licensed specialist" },
    { "name": "Nutrition Counseling",           "duration": 30, "price": "$95",  "description": "Personalized dietary guidance" },
    { "name": "Stress & Anxiety Consultation",  "duration": 50, "price": "$130", "description": "Mindfulness-based stress management" }
  ],
  "persona": {
    "tone": "warm-casual",
    "greeting": "Welcome to Bloom Wellness Studio! 🌸 I'm here to help you book your next appointment. What can I do for you today?",
    "farewell": "Take care! We look forward to seeing you at Bloom. 🌿",
    "business_description": "Bloom Wellness Studio is a holistic health center in New York City offering acupuncture, nutrition counseling, and integrative wellness consultations.",
    "special_instructions": "If the client mentions pain or injury, recommend the Initial Wellness Consultation. If they mention diet or weight, suggest Nutrition Counseling."
  },
  "branding": {
    "primary_color": "#7C3AED",
    "logo_url": null,
    "widget_title": "Book with Bloom 🌸",
    "powered_by": false
  },
  "calendar_provider": "none",
  "voice_enabled": false,
  "sms_enabled": false,
  "excel_integration": null
}
```

---

## 9. What Ships Now vs Later

### Ships Now (This Document + Accompanying PRs)

| Deliverable | Format |
|---|---|
| Refactor plan (this document) | `docs/architecture/template-repo-refactor-plan.md` |
| Quickstart guide | `docs/guides/quickstart.md` |
| Deployment guide | `docs/guides/deployment.md` |
| Adding a Calendar Provider guide | `docs/guides/adding-a-calendar-provider.md` |
| Adding a Channel guide | `docs/guides/adding-a-channel.md` |
| Tenant configuration reference | `docs/guides/tenant-configuration.md` |
| `.env.example` | Root of repo |
| Demo tenant fixture (Bloom Wellness) | `tenants/demo-bloom-wellness.json` |
| Demo tenant fixture (Demo Clinic) | `tenants/demo-clinic.json` |

### Ships in Next Implementation Sprint

| Deliverable | Effort |
|---|---|
| CalendarProvider interface + Google adapter + NoOp adapter | 3–4 hours |
| Channel interface + web-chat plugin extraction | 4–6 hours |
| Voice channel re-organization | 2–3 hours |
| Tenant config Zod schema (`tenants/_schema.ts`) | 2 hours |
| Config-driven `seed.ts` | 1–2 hours |
| README rewrite for template context | 1 hour |
| Validation (fresh clone test) | 1–2 hours |

**Total estimated implementation effort:** 14–20 hours (2–3 days)

---

*Document version: 1.0.0 | Author: EON Agency | Next review: Implementation kickoff*
