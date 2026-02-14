# Tenant Configuration Reference

> Complete schema reference for configuring a tenant in gomomo.ai system.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Schema at a Glance](#2-schema-at-a-glance)
3. [Identity](#3-identity)
4. [Scheduling](#4-scheduling)
5. [Services](#5-services)
6. [AI Persona](#6-ai-persona)
7. [Branding](#7-branding)
8. [Calendar Integration](#8-calendar-integration)
9. [Voice / Phone](#9-voice--phone)
10. [SMS Handoff](#10-sms-handoff)
11. [Excel Integration](#11-excel-integration)
12. [Full Zod Schema](#12-full-zod-schema)
13. [Defaults & Inheritance](#13-defaults--inheritance)
14. [Admin UI Data Model](#14-admin-ui-data-model)
15. [Config Storage](#15-config-storage)
16. [FAQ](#16-faq)

---

## 1. Overview

Every deployment of gomomo.ai serves one or more **tenants** — each tenant
represents a single business (clinic, salon, studio, etc.) with its own schedule,
services, AI personality, and integrations.

Tenant configuration lives in two places:

| Layer | What It Contains | Where |
|---|---|---|
| **Infrastructure** | Database URL, API keys, ports | `.env` file / hosting env vars |
| **Business Rules** | Hours, services, persona, branding | JSON fixture → `tenants/` config table (JSONB) |

The infrastructure layer is shared across all tenants on a host. Business rules are
per-tenant and stored as JSONB in PostgreSQL.

---

## 2. Schema at a Glance

```
tenant
├── name                  string     "Bloom Wellness Studio"
├── slug                  string     "bloom-wellness"
├── timezone              string     "America/New_York"
├── slot_duration         number     30 (minutes)
├── business_hours        object     { monday: { start, end } | null, ... }
├── services[]            array
│   ├── name              string
│   ├── duration          number
│   ├── price             string?
│   └── description       string?
├── persona               object
│   ├── tone              string
│   ├── greeting          string?
│   ├── farewell          string?
│   ├── business_description  string?
│   └── special_instructions  string?
├── branding              object
│   ├── primary_color     string
│   ├── logo_url          string?
│   ├── widget_title      string
│   └── powered_by        boolean
├── calendar_provider     "google" | "outlook" | "none"
├── voice_enabled         boolean
├── sms_enabled           boolean
└── excel_integration     object?
    ├── file_path         string
    └── sync_interval     number
```

---

## 3. Identity

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | ✅ | — | Display name shown in the widget header and admin UI |
| `slug` | `string` | ✅ | — | URL-safe identifier (lowercase, hyphens). Must be unique across tenants. Used in routes: `/api/tenants/:slug` |
| `timezone` | `string` | ✅ | — | IANA timezone (e.g. `"America/New_York"`). All business hours and slot calculations use this timezone |

**Validation rules:**
- `name`: 1–100 characters
- `slug`: 1–50 characters, must match `/^[a-z0-9-]+$/`
- `timezone`: Must be a valid IANA timezone string

---

## 4. Scheduling

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `slot_duration` | `number` | ❌ | `30` | Default appointment length in minutes. Individual services can override with their own `duration` |
| `business_hours` | `object` | ✅ | — | Object with keys `monday` through `sunday`. Each value is `{ start, end }` or `null` (closed) |

### Business Hours Format

```json
{
  "monday":    { "start": "09:00", "end": "17:00" },
  "tuesday":   { "start": "09:00", "end": "17:00" },
  "wednesday": { "start": "09:00", "end": "17:00" },
  "thursday":  { "start": "09:00", "end": "20:00" },
  "friday":    { "start": "09:00", "end": "16:00" },
  "saturday":  { "start": "10:00", "end": "14:00" },
  "sunday":    null
}
```

- `start` / `end`: 24-hour format `HH:MM`
- `null` means the business is closed that day
- All 7 days must be present (no implicit defaults)

**Validation rules:**
- `start` must be before `end`
- Both must match `/^\d{2}:\d{2}$/`
- `slot_duration` must be 5–480 (8 hours max)

---

## 5. Services

Each tenant must have at least one service. Services are presented to the user by
the AI agent when they want to book.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | ✅ | — | Service name shown to clients (e.g. "Initial Consultation") |
| `duration` | `number` | ✅ | — | Duration in minutes. Overrides `slot_duration` for this service |
| `price` | `string` | ❌ | `null` | Display price (e.g. "$150"). Not used for billing — informational only |
| `description` | `string` | ❌ | `null` | Short description the AI agent can cite to help clients pick a service |

**Example:**

```json
{
  "name": "Acupuncture Session",
  "duration": 45,
  "price": "$120",
  "description": "Traditional acupuncture with licensed specialist"
}
```

**Validation rules:**
- At least 1 service required
- `name`: 1–200 characters
- `duration`: 5–480 minutes
- `price`: free-form string (display only)

---

## 6. AI Persona

The persona block controls how the AI receptionist talks, greets, and behaves.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `tone` | `string` | ❌ | `"professional-friendly"` | Personality flavor injected into the system prompt. Supported: `"professional-friendly"`, `"warm-casual"`, `"formal"`, `"concise"` |
| `greeting` | `string` | ❌ | Auto-generated | Custom greeting shown when a chat session starts. If `null`, the system generates one from the business name |
| `farewell` | `string` | ❌ | Auto-generated | Custom farewell after booking confirmation |
| `business_description` | `string` | ❌ | `null` | Paragraph describing the business. Injected into the system prompt so the AI can answer "What do you do?" questions |
| `special_instructions` | `string` | ❌ | `null` | Free-form instructions for the AI (e.g. "Always recommend the consultation first for new clients") |

**How it works:** The system prompt template interpolates these values:

```
You are the AI receptionist for {{name}}.
{{business_description}}

Tone: {{tone}}
Special instructions: {{special_instructions}}

Available services:
{{#each services}}
- {{name}} ({{duration}} min) — {{description}}
{{/each}}
```

**Validation rules:**
- `tone`: must be one of the supported values
- `greeting` / `farewell`: max 500 characters
- `business_description`: max 2000 characters
- `special_instructions`: max 2000 characters

---

## 7. Branding

Controls the visual appearance of the web chat widget.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `primary_color` | `string` | ❌ | `"#4F46E5"` | Hex color for the widget header and buttons |
| `logo_url` | `string` | ❌ | `null` | URL to a logo image (displayed in the widget header). Recommended: 200×200px PNG/SVG |
| `widget_title` | `string` | ❌ | `"Book an Appointment"` | Title text shown in the chat widget header |
| `powered_by` | `boolean` | ❌ | `true` | Whether to show "Powered by EON" in the widget footer. Agency tier clients can set to `false` |

**Validation rules:**
- `primary_color`: must match `/^#[0-9a-fA-F]{6}$/`
- `logo_url`: must be a valid URL (https preferred)
- `widget_title`: 1–100 characters

---

## 8. Calendar Integration

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `calendar_provider` | `string` | ❌ | `"none"` | Which calendar provider to sync with. Options: `"google"`, `"outlook"`, `"none"` |

When set to `"none"`, the system still creates bookings in PostgreSQL — it just
doesn't push them to an external calendar. This is the recommended starting point.

### Provider-Specific Env Vars

**Google Calendar:**
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback
GOOGLE_REFRESH_TOKEN=...
```

**Outlook (future):**
```
OUTLOOK_CLIENT_ID=...
OUTLOOK_CLIENT_SECRET=...
OUTLOOK_TENANT_ID=...
OUTLOOK_REDIRECT_URI=...
```

See [Adding a Calendar Provider](./adding-a-calendar-provider.md) for implementation details.

---

## 9. Voice / Phone

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `voice_enabled` | `boolean` | ❌ | `false` | Enable Twilio voice call handling for this tenant |

When `true`, the following env vars must be set:

```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
TWILIO_WEBHOOK_BASE_URL=https://your-domain.com
```

The voice channel implements a state machine:
`GREETING → COLLECT_SERVICE → COLLECT_DATE → COLLECT_TIME → COLLECT_NAME → CONFIRM → BOOKED`

See [Adding a Channel](./adding-a-channel.md) for the full voice architecture.

---

## 10. SMS Handoff

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `sms_enabled` | `boolean` | ❌ | `false` | Enable SMS escalation to a human operator |

When `true`, the AI can hand off a conversation to a human via SMS. Additional env vars:

```
SMS_ENABLED=true
SMS_OWNER_PHONE=+1...           # Business owner's mobile number
SMS_HANDOFF_KEYWORDS=help,human  # Trigger words for handoff
```

Uses the same Twilio credentials as voice (if configured).

---

## 11. Excel Integration

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `excel_integration` | `object \| null` | ❌ | `null` | Configuration for Excel file sync |

### Excel Integration Object

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `file_path` | `string` | ✅ | — | Absolute or relative path to the `.xlsx` file |
| `sync_interval` | `number` | ❌ | `0` | Sync frequency in seconds. `0` = sync on every booking (real-time) |

**Example:**

```json
{
  "excel_integration": {
    "file_path": "/data/bookings.xlsx",
    "sync_interval": 0
  }
}
```

Set to `null` to disable. The system writes bookings to the Excel file as a secondary
ledger — PostgreSQL remains the source of truth.

---

## 12. Full Zod Schema

This is the canonical TypeScript schema used for validation. All tenant fixtures and
admin UI inputs are validated against it.

```typescript
import { z } from 'zod';

const TimeSlotSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end:   z.string().regex(/^\d{2}:\d{2}$/),
}).nullable();

const ServiceSchema = z.object({
  name:        z.string().min(1).max(200),
  duration:    z.number().int().min(5).max(480),
  price:       z.string().max(50).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

const PersonaSchema = z.object({
  tone: z.enum([
    'professional-friendly',
    'warm-casual',
    'formal',
    'concise',
  ]).default('professional-friendly'),
  greeting:              z.string().max(500).nullable().optional(),
  farewell:              z.string().max(500).nullable().optional(),
  business_description:  z.string().max(2000).nullable().optional(),
  special_instructions:  z.string().max(2000).nullable().optional(),
});

const BrandingSchema = z.object({
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4F46E5'),
  logo_url:      z.string().url().nullable().optional(),
  widget_title:  z.string().min(1).max(100).default('Book an Appointment'),
  powered_by:    z.boolean().default(true),
});

const ExcelIntegrationSchema = z.object({
  file_path:     z.string().min(1),
  sync_interval: z.number().int().min(0).default(0),
}).nullable().optional();

export const TenantConfigSchema = z.object({
  // Identity
  name:     z.string().min(1).max(100),
  slug:     z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  timezone: z.string().min(1),  // validated at runtime against Intl

  // Scheduling
  slot_duration:  z.number().int().min(5).max(480).default(30),
  business_hours: z.object({
    monday:    TimeSlotSchema,
    tuesday:   TimeSlotSchema,
    wednesday: TimeSlotSchema,
    thursday:  TimeSlotSchema,
    friday:    TimeSlotSchema,
    saturday:  TimeSlotSchema,
    sunday:    TimeSlotSchema,
  }),

  // Services
  services: z.array(ServiceSchema).min(1),

  // AI Persona
  persona: PersonaSchema.default({}),

  // Branding
  branding: BrandingSchema.default({}),

  // Integrations
  calendar_provider: z.enum(['google', 'outlook', 'none']).default('none'),
  voice_enabled:     z.boolean().default(false),
  sms_enabled:       z.boolean().default(false),
  excel_integration: ExcelIntegrationSchema,
});

export type TenantConfig = z.infer<typeof TenantConfigSchema>;
```

---

## 13. Defaults & Inheritance

The schema uses Zod `.default()` to provide sensible fallbacks. Here's the full
default chain:

| Field | Default | Rationale |
|---|---|---|
| `slot_duration` | `30` | Most common appointment length |
| `persona.tone` | `"professional-friendly"` | Safe default for any business type |
| `persona.greeting` | `null` → auto-generated | System builds from business name |
| `persona.farewell` | `null` → auto-generated | System builds from business name |
| `branding.primary_color` | `"#4F46E5"` | Indigo — neutral, professional |
| `branding.widget_title` | `"Book an Appointment"` | Generic, works for any business |
| `branding.powered_by` | `true` | Agency branding; set `false` for white-label |
| `calendar_provider` | `"none"` | DB-only scheduling works out of the box |
| `voice_enabled` | `false` | Requires Twilio setup |
| `sms_enabled` | `false` | Requires Twilio setup |
| `excel_integration` | `null` | No secondary ledger |

**Minimum viable config** (everything else defaults):

```json
{
  "name": "My Business",
  "slug": "my-business",
  "timezone": "America/New_York",
  "business_hours": {
    "monday":    { "start": "09:00", "end": "17:00" },
    "tuesday":   { "start": "09:00", "end": "17:00" },
    "wednesday": { "start": "09:00", "end": "17:00" },
    "thursday":  { "start": "09:00", "end": "17:00" },
    "friday":    { "start": "09:00", "end": "17:00" },
    "saturday":  null,
    "sunday":    null
  },
  "services": [
    { "name": "Consultation", "duration": 30 }
  ]
}
```

---

## 14. Admin UI Data Model

The future Admin UI maps directly to sections of the tenant config:

| Screen | Config Sections | Fields |
|---|---|---|
| **Dashboard** | — | Booking count, upcoming appointments, usage metrics |
| **Business Info** | identity | name, slug, timezone |
| **Schedule** | scheduling | slot_duration, business_hours (visual weekly editor) |
| **Services** | services | CRUD list with name, duration, price, description |
| **AI Persona** | persona | tone dropdown, greeting/farewell textareas, description, instructions |
| **Branding** | branding | Color picker, logo upload, widget title, powered_by toggle |
| **Integrations** | calendar, voice, sms, excel | Provider toggles, credential fields, test buttons |
| **Widget Preview** | all | Live preview of the chat widget with current config |

Each screen reads from and writes to the same JSONB column in the `tenants` table.
The Admin API validates all writes against `TenantConfigSchema` before persisting.

---

## 15. Config Storage

### Database Schema

```sql
CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT UNIQUE NOT NULL,
  config      JSONB NOT NULL,          -- TenantConfigSchema
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_tenants_slug ON tenants(slug);
```

### Loading Flow

```
Tenant JSON fixture
    ↓ seed.ts
PostgreSQL tenants.config (JSONB)
    ↓ app startup / per-request
Zod parse → TenantConfig (typed, validated)
    ↓ injected into
System prompt, availability engine, calendar adapter, channel handlers
```

### Updating at Runtime

```typescript
// PATCH /api/tenants/:slug
const body = TenantConfigSchema.partial().parse(req.body);
await db.query(
  `UPDATE tenants SET config = config || $1, updated_at = now() WHERE slug = $2`,
  [JSON.stringify(body), slug]
);
```

The `||` JSONB operator merges the patch into the existing config, so partial
updates are safe.

---

## 16. FAQ

### Can I change the config without restarting the server?

**Yes.** Config is loaded per-request from PostgreSQL. Update the JSONB and the next
request uses the new values. No restart needed.

### How do I add a new field to the schema?

1. Add the field to `TenantConfigSchema` in the Zod definition (with a default so
   existing tenants aren't broken).
2. Use the new field in the relevant service/adapter.
3. Update the Admin UI to expose the new field.
4. Update this doc.

### Can different tenants use different calendar providers?

**Yes.** `calendar_provider` is per-tenant. One tenant can use Google, another can
use Outlook, and a third can use `"none"` (DB-only). The CalendarProvider factory
resolves the correct implementation based on each tenant's config.

### What happens if validation fails on seed?

The seeder runs `TenantConfigSchema.parse()` on the fixture. If validation fails,
it throws a `ZodError` with a detailed path to the invalid field:

```
ZodError: [
  {
    "path": ["business_hours", "monday", "start"],
    "message": "Invalid input"
  }
]
```

Fix the fixture and re-run the seed command.

### Is there a size limit on the JSONB column?

PostgreSQL JSONB has a theoretical limit of 1 GB. In practice, tenant configs are
1–5 KB. You'll never hit the limit.

### Can I export a tenant config back to a JSON file?

```bash
psql $DATABASE_URL -c "SELECT config FROM tenants WHERE slug='bloom-wellness'" \
  | jq '.' > tenants/bloom-wellness-export.json
```

Or via the API:

```bash
curl http://localhost:3000/api/tenants/bloom-wellness | jq '.config' > export.json
```
