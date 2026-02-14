# Storefront Knowledge System

> Phase 1 — local, repo-backed. No external vector DB or embedding API.
> Phase 2 — sales & partnership conversion with booking CTA.
> Phase 3 — canonical agent identity enforcement ("Gomomo").

## Overview

The Storefront Knowledge System makes the Gomomo AI agent a reliable storefront representative that:
1. Serves hard facts from a **canonical editable source** (no hallucination)
2. Uses **retrieval (RAG)** over approved docs for explanations
3. Logs **unanswered FAQs** and generates draft answers for human approval (no auto-publish)
4. Acts as a **sales representative** for partnership/investor/advertising inquiries
5. Drives **conversion** by offering booking CTAs for sales calls

## Architecture

```
User Question
     │
     ▼
┌─────────────────┐
│  Intent Detect   │── booking intent ──► Normal Agent (tools + LLM)
└────────┬────────┘
         │ storefront intent
         ▼
┌─────────────────┐
│  1. Facts Match  │── match ──► Deterministic answer (no LLM)
└────────┬────────┘
         │ no match
         ▼
┌─────────────────┐
│  2. Approved FAQ │── match ──► Human-approved answer (no LLM)
└────────┬────────┘
         │ no match
         ▼
┌─────────────────┐
│  3. RAG Corpus   │── confident ──► LLM composes from passages
└────────┬────────┘
         │ weak/no match
         ▼
┌─────────────────┐
│  4. Log FAQ      │── logged ──► Normal agent fallback
└─────────────────┘
```

## How to Update Facts (Pricing, Contact, Features)

Edit the canonical facts file:

```
src/backend/src/storefront/gomomo-facts.ts
```

This file contains:
- `brand_name`, `tagline`, `short_description`
- `contact` (all email addresses, including sales)
- `pricing_plans` (name, price, limits, channels, notes)
- `supported_channels` (web_chat, sms, voice)
- `key_features` and `supported_industries`
- `key_links` (website, privacy, terms, etc.)
- `mission`, `vision`, `positioning` — company identity statements
- `primary_outcomes` — measurable business outcomes / ROI claims
- `partnership_channels` — advertising, B2B, integrations, resellers, investors
- `sales_cta` — booking link, sales email, calendar service name, duration
- `short_identity` — one-sentence identity statement for the platform
- `agent_identity_statement` — first-person canonical identity line ("I am Gomomo — …")
- `last_updated` (ISO timestamp — update this when you change anything)

After editing, restart the backend. The agent picks up changes immediately.

### Example: Updating Pricing

```typescript
// In gomomo-facts.ts, edit the pricing_plans array:
{
  name: 'Pro',
  price: '$59/month',  // was $49/month
  billing_cycle: 'monthly',
  limits: 'Up to 300 bookings/month',  // was 200
  channels: ['web_chat', 'sms'],
  notes: 'Best for growing businesses.',
},
```

## How to Add/Update Corpus Docs

The approved docs corpus lives in:

```
src/backend/src/storefront/corpus/
```

Current files:
- `homepage.md` — product overview, features, how it works
- `privacy.md` — privacy policy
- `terms.md` — terms of service
- `data-deletion.md` — data deletion process
- `faq.md` — frequently asked questions
- `mission.md` — mission, vision, positioning, problem statement
- `partnerships.md` — partnership types, contact info, pitch guidance
- `pricing.md` — detailed pricing plans comparison
- `outcomes.md` — business outcomes, ROI stats, industry applicability

### Adding a New Doc

1. Create a markdown file in `corpus/` (e.g., `integrations.md`)
2. Write the content using clear headings and short paragraphs
3. Restart the backend — the retrieval engine auto-loads all `.md` files

### Best Practices for Corpus Docs

- Use markdown headings (`##`, `###`) to separate topics — the retrieval engine splits on headings
- Keep paragraphs focused on one topic (50-500 characters ideal)
- Include keywords that users might search for
- Only include factual, approved content — the agent trusts the corpus

## How the Propose/Approve Loop Works

### The Problem

When the agent gets a question it can't confidently answer, it logs it as an "unanswered FAQ" in the database.

### The Workflow

1. **Automatic logging**: When the storefront router can't match a question to facts, approved FAQs, or corpus, it saves the question to `unanswered_faqs` table.

2. **Review unanswered FAQs**:
   ```bash
   curl -H "X-Admin-Key: YOUR_KEY" http://localhost:3000/api/admin/storefront/unanswered-faqs
   ```

3. **Generate a draft answer** (uses facts + corpus retrieval):
   ```bash
   curl -X POST -H "X-Admin-Key: YOUR_KEY" \
     http://localhost:3000/api/admin/storefront/unanswered-faqs/{id}/propose
   ```

4. **Review the draft** — edit if needed, then approve:
   ```bash
   curl -X POST -H "X-Admin-Key: YOUR_KEY" \
     http://localhost:3000/api/admin/storefront/unanswered-faqs/{id}/approve
   ```

5. **Live immediately**: The approved answer is now stored in `approved_faqs` and served deterministically — no LLM needed.

6. **Dismiss irrelevant FAQs**:
   ```bash
   curl -X POST -H "X-Admin-Key: YOUR_KEY" \
     http://localhost:3000/api/admin/storefront/unanswered-faqs/{id}/dismiss
   ```

### Admin Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/public/storefront/facts` | Public | Returns canonical facts |
| GET | `/api/admin/storefront/unanswered-faqs` | Admin | List unanswered FAQs |
| POST | `/api/admin/storefront/unanswered-faqs/:id/propose` | Admin | Generate draft answer |
| POST | `/api/admin/storefront/unanswered-faqs/:id/approve` | Admin | Approve and publish |
| POST | `/api/admin/storefront/unanswered-faqs/:id/dismiss` | Admin | Dismiss FAQ |
| GET | `/api/admin/storefront/approved-faqs` | Admin | List approved FAQs |

## How to Verify the Agent Is Up to Date

### 1. Check facts endpoint

```bash
curl http://localhost:3000/api/public/storefront/facts | jq .last_updated
```

### 2. Test key questions

Ask the agent:
- "What is Gomomo?" → Should mention "AI receptionist platform"
- "What's the price?" → Should list Free/Pro/Business/Enterprise from facts
- "How do I buy?" → Should point to gomomo.ai
- "What about privacy?" → Should cite the privacy policy URL
- "What is your mission?" → Should return mission statement from facts
- "I want to partner with you" → Should describe partnership types + offer booking CTA
- "I'm interested in investing" → Should return investor contact info + offer a call
- "Can I get a demo?" → Should offer to book a "Gomomo Partnership Call"

### 3. Run tests

```bash
cd src/backend && npx vitest run tests/storefront-knowledge.test.ts
```

### 4. Check for unanswered FAQs

```bash
curl -H "X-Admin-Key: YOUR_KEY" http://localhost:3000/api/admin/storefront/unanswered-faqs
```

If the `count` field is high for a question, it's worth adding a corpus doc or approving an FAQ.

## Example Q/A

| User Question | Answer Source | Response |
|---------------|--------------|----------|
| "What is Gomomo?" | Facts (brand) | "Gomomo is an AI receptionist platform that automates appointment booking, customer messaging, and follow-ups — across web chat, SMS, and voice. Learn more at gomomo.ai." |
| "What's the price?" | Facts (pricing) | Lists Free ($0), Pro ($49), Business ($149), Enterprise (Custom) with limits |
| "How do I buy?" | Facts (purchase) | "You can get started at gomomo.ai — sign up for a free account, no credit card required." |
| "How do I delete my data?" | RAG (data-deletion.md) | Composes answer from corpus passages about the deletion process |
| "What is your mission?" | Facts (mission) | Returns the mission statement: "Replace every hold queue and no-show gap with an AI receptionist..." |
| "I want to advertise" | Facts (partnership_advertising) | Describes advertising partnership + conversion CTA to book a call |
| "I'm interested in investing" | Facts (partnership_investors) | Returns investor contact info + offers to book a "Gomomo Partnership Call" |
| "Can I book a call?" | Facts (sales_cta) | Offers to book a 30-min "Gomomo Partnership Call" via chat or email |
| "Can you book me for Tuesday?" | Bypass | Normal booking agent handles this |

## Sales & Partnership Conversion (Phase 2)

### How It Works

When the agent detects a partnership, sales, investor, or mission-related intent, it:

1. **Answers from canonical facts** — mission, vision, partnership details, etc.
2. **Appends a conversion CTA** — the context prompt builder adds a suffix instructing the agent to offer booking a "Gomomo Partnership Call" (30 min)
3. **System prompt includes sales rep guidance** — the agent knows it's also a sales representative and follows a 5-step booking flow for partnership calls

### Supported Partnership Types

| Type | Contact | Suggested Subject |
|------|---------|-------------------|
| Advertising | hello@gomomo.ai | "Advertising Partnership" |
| B2B | hello@gomomo.ai | "B2B Partnership" |
| Integrations | hello@gomomo.ai | "Integration Partnership" |
| Resellers | hello@gomomo.ai | "Reseller / Affiliate" |
| Investors | hello@gomomo.ai | "Investor Inquiry" |

### Sales CTA Configuration

Edit `GOMOMO_FACTS.sales_cta` in `gomomo-facts.ts`:

```typescript
sales_cta: {
  booking_link: 'Use this chat to schedule a call with us.',
  sales_email: 'hello@gomomo.ai',
  calendar_demo_service_name: 'Gomomo Partnership Call',
  default_duration_minutes: 30,
},
```

### Intent Keywords

The router detects these keywords as storefront (partnership/sales) intents:
- `partner`, `partnership`, `advertise`, `advertising`, `sponsorship`
- `integration`, `integrate`, `reseller`, `affiliate`, `white label`
- `investor`, `investing`, `funding`, `pitch`
- `demo`, `talk to sales`, `book a call`, `schedule a call`, `sales call`
- `mission`, `vision`, `why gomomo`, `outcomes`, `benefits`, `roi`

## Database Tables

### `unanswered_faqs`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| question | TEXT | The user's question |
| first_seen_at | TIMESTAMPTZ | When first asked |
| last_seen_at | TIMESTAMPTZ | Most recent occurrence |
| count | INTEGER | How many times asked |
| status | TEXT | new / proposed / approved / dismissed |
| proposed_answer | TEXT | LLM-drafted answer (nullable) |
| approved_at | TIMESTAMPTZ | When approved (nullable) |

### `approved_faqs`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| question | TEXT | The question |
| answer | TEXT | Human-approved answer |
| source_faq_id | UUID | Link to original unanswered FAQ |
| approved_at | TIMESTAMPTZ | When approved |

## Agent Identity Enforcement (Phase 3)

### Canonical Identity

The agent identifies itself **as Gomomo** — the company's own AI agent. It never calls itself a
generic "assistant", "virtual assistant", "AI service agent", or "chatbot".

**System prompt opens with:** `You are Gomomo — the official AI agent and storefront representative of the Gomomo company.`

**Identity Lock** — hard guard clause in the system prompt:
- "Who are you?" → "I'm Gomomo — an AI-powered booking and business engagement platform."
- "Are you an AI?" → Responds in brand voice as Gomomo, not as a generic bot.
- "Who built you?" → "I'm built by the Gomomo team at gomomo.ai."

### Banned Terms (in runtime identity context)

| Banned Term | Replacement |
|-------------|-------------|
| "assistant" / "AI assistant" | "Gomomo" or "AI agent" |
| "virtual assistant" | "Gomomo" |
| "AI service agent" | "AI receptionist" |
| "powered by" | "built on the Gomomo platform" |
| "Bloom" / "bloom.ai" | "Gomomo" / "gomomo.ai" |
| "chatbot" | "Gomomo" |

**Note:** `role: 'assistant'` in OpenAI API calls is structural and must NOT be changed. The ban
applies only to user-facing strings.

### Identity Reinforcement

For the Gomomo tenant (`slug: 'gomomo'`), the chat handler injects an identity reinforcement
system message on every turn:

```
IDENTITY REMINDER: You are Gomomo. I am Gomomo — your AI-powered booking and business
engagement platform. Built by the Gomomo team at gomomo.ai. Never refer to yourself as an
"assistant", "virtual assistant", or "chatbot". Never say you are "powered by" anything.
```

### Non-Gomomo Tenants

Non-gomomo tenants get: `You are the AI receptionist for "{tenant.name}", built on the Gomomo platform.`

This avoids "service agent" and "powered by" while still attributing to Gomomo.

### Tests

```bash
cd src/backend && npx vitest run tests/agent-identity.test.ts
```

Covers: canonical identity line, identity lock, no Bloom references, no "assistant" in prompt,
no "AI assistant" in corpus docs, `short_identity` and `agent_identity_statement` fields, and
answerFromFacts identity responses.

## File Map

```
src/backend/src/storefront/
├── gomomo-facts.ts      # Canonical facts (pricing, contact, features, mission, partnerships, sales CTA)
├── retrieval.ts         # BM25 retrieval engine
├── router.ts            # Hybrid router (facts → FAQ → RAG → fallback) + CTA builder
├── faq-repo.ts          # DB access for FAQ tables
└── corpus/              # Approved docs for RAG
    ├── homepage.md
    ├── privacy.md
    ├── terms.md
    ├── data-deletion.md
    ├── faq.md
    ├── mission.md       # Mission, vision, positioning
    ├── partnerships.md  # Partnership types & contact info
    ├── pricing.md       # Detailed pricing comparison
    └── outcomes.md      # Business outcomes & ROI

src/backend/src/agent/
└── system-prompt.ts     # Sales rep guidance + booking flow (uses GOMOMO_FACTS)

src/backend/src/routes/
└── storefront.routes.ts # HTTP endpoints (public + admin)

src/backend/src/db/migrations/
└── 023_storefront_knowledge.sql  # DB tables

src/backend/tests/
├── storefront-knowledge.test.ts  # 51 tests (facts, intent, retrieval, router, CTA, anti-hallucination)
└── agent-identity.test.ts        # Identity enforcement tests (canonical name, no legacy branding)
```
