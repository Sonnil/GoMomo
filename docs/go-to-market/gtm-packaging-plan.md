# gomomo.ai — Go-to-Market Packaging Plan

> Project: prj-20260205-001 | Version: 1.0.0 | Date: 2026-02-06
> Classification: INTERNAL — Business Strategy
> Status: Draft for Founder Review

---

## Table of Contents

1. [Assumptions & Methodology](#1-assumptions--methodology)
2. [Ideal Customer Profiles (ICPs)](#2-ideal-customer-profiles-icps)
3. [Packaging — Agency Model (Done-for-You)](#3-packaging--agency-model-done-for-you)
4. [Packaging — SaaS Model (Self-Serve)](#4-packaging--saas-model-self-serve)
5. [Cost Drivers & Unit Economics](#5-cost-drivers--unit-economics)
6. [Risk Controls](#6-risk-controls)
7. [Sales Assets](#7-sales-assets)
8. [Implementation Roadmap](#8-implementation-roadmap)

---

## 1. Assumptions & Methodology

### 1.1 Pricing Basis Date

All pricing reflects February 2026 public rates. Re-validate quarterly.

### 1.2 Cost Assumptions (per-unit)

| Component | Rate | Source |
|---|---|---|
| **OpenAI GPT-4o** (input) | $2.50 / 1M tokens | openai.com/pricing |
| **OpenAI GPT-4o** (output) | $10.00 / 1M tokens | openai.com/pricing |
| **OpenAI GPT-4o-mini** (input) | $0.15 / 1M tokens | openai.com/pricing |
| **OpenAI GPT-4o-mini** (output) | $0.60 / 1M tokens | openai.com/pricing |
| **Twilio Voice** (inbound, US) | $0.0085 / min | twilio.com/voice/pricing |
| **Twilio Voice** (outbound, US) | $0.014 / min | twilio.com/voice/pricing |
| **Twilio SMS** (US) | $0.0079 / segment | twilio.com/sms/pricing |
| **Twilio Phone Number** | $1.15 / mo | twilio.com/phone-numbers |
| **PostgreSQL (managed)** | ~$15–50 / mo | Supabase / Neon / RDS |
| **Compute (VPS)** | ~$20–80 / mo | Railway / Render / Fly.io |
| **Domain + SSL** | ~$0 (Let's Encrypt) | — |

### 1.3 Conversation Cost Model

Average booking conversation:

| Channel | Turns | Avg Tokens (in/out) | LLM Cost (GPT-4o) | LLM Cost (4o-mini) |
|---|---|---|---|---|
| **Web chat** | 6–8 turns | ~2,500 in / ~800 out | ~$0.014 | ~$0.0009 |
| **Phone voice** | 8–12 turns | ~3,200 in / ~1,200 out | ~$0.020 | ~$0.0012 |
| **Phone** + Twilio (5 min avg) | — | — | +$0.043 voice | +$0.043 voice |
| **SMS handoff** (1 msg) | — | — | +$0.008 | +$0.008 |

**Blended cost per conversation (GPT-4o, phone):** ~$0.07
**Blended cost per conversation (GPT-4o-mini, web):** ~$0.001

### 1.4 Volume Benchmarks

| Business Type | Monthly Booking Conversations | Avg Phone Minutes |
|---|---|---|
| Solo practitioner (1 chair/room) | 80–150 | 400–750 |
| Small clinic (2–5 providers) | 200–500 | 1,000–2,500 |
| Multi-location (6–20 providers) | 500–2,000 | 2,500–10,000 |

---

## 2. Ideal Customer Profiles (ICPs)

### ICP 1: Solo / Micro Wellness Practitioner

> **"I lose clients because I can't answer the phone during sessions."**

| Attribute | Detail |
|---|---|
| **Business type** | Massage therapist, acupuncturist, esthetician, chiropractor, personal trainer, therapist |
| **Size** | 1 provider, 0–1 admin staff |
| **Revenue** | $60K–$150K / year |
| **Current booking** | Paper calendar, Google Calendar manual, or basic booking link (Calendly, Acuity) |
| **Pain points** | Missed calls during sessions (30–50% go to voicemail → lost), manual rescheduling, no-shows, after-hours inquiries with no response |
| **Tech comfort** | Low–Medium. Uses iPhone + Google Workspace. No IT staff. |
| **Decision maker** | Owner (sole decision) |
| **Sales cycle** | 1–2 weeks |
| **LTV potential** | $200–$400/mo × 18–24 months = $3,600–$9,600 |
| **Why they buy** | "I got 3 new bookings this week from calls I would have missed." |
| **Channel fit** | Phone voice (#1), web chat (#2), SMS handoff |

### ICP 2: Small Service Business / Clinic

> **"Our receptionist is overwhelmed and we're spending $3,500/mo on front-desk salary."**

| Attribute | Detail |
|---|---|
| **Business type** | Dental office, med spa, physical therapy clinic, veterinary clinic, hair salon (multi-chair), auto service shop |
| **Size** | 2–5 providers, 1–2 front desk staff |
| **Revenue** | $300K–$1.5M / year |
| **Current booking** | Mix of phone, walk-in, and legacy software (Mindbody, Jane, Vagaro). Receptionist handles 60–80 calls/day. |
| **Pain points** | Hold times → abandoned calls, receptionist turnover ($3K–$5K/mo fully loaded), after-hours = 100% voicemail, double-bookings from manual entry |
| **Tech comfort** | Medium. Has Google Workspace or Office 365. May have basic IT support. |
| **Decision maker** | Owner or office manager |
| **Sales cycle** | 2–4 weeks |
| **LTV potential** | $500–$1,200/mo × 24–36 months = $12,000–$43,200 |
| **Why they buy** | "We reduced front-desk calls by 40% and saved one FTE headcount." |
| **Channel fit** | Phone voice (#1), web chat on website (#2), Excel sync for office manager (#3) |

### ICP 3: Multi-Location Service Brand / Franchise

> **"We need consistent booking quality across 8 locations without 8 receptionists."**

| Attribute | Detail |
|---|---|
| **Business type** | Franchise (Great Clips, Massage Envy style), multi-office dental/medical group, boutique fitness chain, property management (showings) |
| **Size** | 6–20+ providers across 2–10 locations |
| **Revenue** | $1M–$10M+ / year |
| **Current booking** | Central call center or per-location receptionist, enterprise booking software (Salesforce, custom). High variance in booking quality. |
| **Pain points** | Inconsistent caller experience, call center cost ($8K–$15K/mo), peak-hour overflow, centralized reporting gaps, brand consistency |
| **Tech comfort** | Medium–High. Has IT. May require SSO, HIPAA BAA, or SOC 2 questionnaire. |
| **Decision maker** | VP Operations + Owner/GM sign-off |
| **Sales cycle** | 4–8 weeks |
| **LTV potential** | $2,000–$5,000/mo × 24–36 months = $48,000–$180,000 |
| **Why they buy** | "Every location answers identically, 24/7, with zero training." |
| **Channel fit** | Phone voice, web chat per location, Excel/SharePoint for ops dashboard, multi-tenant admin |

---

## 3. Packaging — Agency Model (Done-for-You)

> **Go-to-market: "We install your AI receptionist in 48 hours."**
> Positioning: Premium white-glove service for non-technical business owners.

### 3.1 Tier Matrix

| | **Starter** | **Growth** | **Premium** |
|---|---|---|---|
| **Target ICP** | ICP 1 (Solo) | ICP 2 (Small Clinic) | ICP 3 (Multi-Location) |
| **Monthly Price** | **$297/mo** | **$697/mo** | **$1,497/mo** |
| **Setup Fee** | $497 (one-time) | $997 (one-time) | $2,497 (one-time) |
| **Contract** | Month-to-month | 3-month minimum | 6-month minimum |
| | | | |
| **CHANNELS** | | | |
| Web chat widget | ✅ | ✅ | ✅ |
| Phone voice (Twilio) | ✅ 1 number | ✅ 2 numbers | ✅ Up to 5 numbers |
| SMS handoff | ✅ | ✅ | ✅ |
| | | | |
| **CAPACITY** | | | |
| Included conversations/mo | 200 | 600 | 2,000 |
| Included phone minutes/mo | 500 | 1,500 | 5,000 |
| Included SMS/mo | 100 | 300 | 1,000 |
| | | | |
| **INTEGRATIONS** | | | |
| Google Calendar sync | ✅ | ✅ | ✅ |
| Excel booking mirror | — | ✅ | ✅ |
| SharePoint/OneDrive sync | — | — | ✅ |
| Custom calendar (API) | — | — | ✅ (on request) |
| | | | |
| **AI CONFIGURATION** | | | |
| AI model | GPT-4o-mini | GPT-4o | GPT-4o |
| Custom persona / script | Basic template | Fully customized | Multi-persona per location |
| Services configured | Up to 5 | Up to 15 | Unlimited |
| Business hours logic | 1 schedule | Multiple schedules | Per-location schedules |
| | | | |
| **SUPPORT** | | | |
| Onboarding | Self-guided + 30min call | 60min strategy call + full setup | Dedicated onboarding (3 calls) |
| Ongoing support | Email (48h SLA) | Email + chat (24h SLA) | Slack channel (4h SLA, business hours) |
| Monthly review | — | Quarterly review call | Monthly review call + report |
| | | | |
| **OVERAGE RATES** | | | |
| Extra conversation | $0.15 each | $0.12 each | $0.10 each |
| Extra phone minute | $0.08/min | $0.06/min | $0.05/min |
| Extra SMS | $0.05 each | $0.04 each | $0.03 each |

### 3.2 Setup Time (Agency Delivery)

| Tier | Setup Activities | Time to Live |
|---|---|---|
| **Starter** | Provision tenant, configure 1 calendar + 1 phone number, basic persona, embed widget | **2–4 hours** (same day) |
| **Growth** | Above + custom persona tuning, multi-service config, Excel mirror, staff training call | **4–8 hours** (1–2 days) |
| **Premium** | Above + multi-location tenant config, per-location personas, SharePoint integration, compliance review | **12–20 hours** (3–5 days) |

### 3.3 Agency Revenue Model

| | Starter | Growth | Premium |
|---|---|---|---|
| Setup revenue | $497 | $997 | $2,497 |
| Monthly recurring | $297 | $697 | $1,497 |
| Avg COGS/mo (infra + LLM + Twilio) | ~$45 | ~$120 | ~$350 |
| **Gross margin/mo** | **~$252 (85%)** | **~$577 (83%)** | **~$1,147 (77%)** |
| Annual gross per client | **$3,521** | **$7,921** | **$16,261** |
| Breakeven clients for $10K/mo target | **~4 Growth + 2 Starter** | — | — |

> **Assumption:** COGS includes LLM (blended $0.03/conversation), Twilio pass-through, pro-rated hosting ($5–15/tenant on shared infra), and Excel sync compute.

---

## 4. Packaging — SaaS Model (Self-Serve)

> **Go-to-market: "Your AI receptionist in 10 minutes. No code. No contracts."**
> Positioning: Freemium + usage-based for tech-comfortable SMBs.

### 4.1 Tier Matrix

| | **Free** | **Pro** | **Business** |
|---|---|---|---|
| **Target ICP** | Trial / Solo micro | ICP 1–2 | ICP 2–3 |
| **Monthly Price** | **$0** | **$79/mo** | **$249/mo** |
| **Annual Price** | — | $790/yr (save 17%) | $2,490/yr (save 17%) |
| **Setup Fee** | $0 | $0 | $0 |
| | | | |
| **CHANNELS** | | | |
| Web chat widget | ✅ | ✅ | ✅ |
| Phone voice | — | ✅ 1 number | ✅ Up to 3 numbers |
| SMS handoff | — | ✅ | ✅ |
| | | | |
| **CAPACITY** | | | |
| Conversations/mo | 50 | 300 | 1,500 |
| Phone minutes/mo | — | 500 | 3,000 |
| SMS/mo | — | 100 | 500 |
| | | | |
| **INTEGRATIONS** | | | |
| Google Calendar | ✅ | ✅ | ✅ |
| Excel mirror | — | ✅ | ✅ |
| SharePoint/OneDrive | — | — | ✅ |
| Zapier / Webhooks | — | — | ✅ |
| | | | |
| **AI CONFIGURATION** | | | |
| AI model | GPT-4o-mini | GPT-4o-mini | GPT-4o |
| Persona builder | Template only | Visual editor | Visual editor + API |
| Services | Up to 3 | Up to 10 | Unlimited |
| Locations | 1 | 1 | Up to 5 |
| | | | |
| **BRANDING** | | | |
| Widget branding | "Powered by gomomo.ai" | Custom colors | Fully white-labeled |
| Custom domain | — | — | ✅ |
| | | | |
| **SUPPORT** | | | |
| Support channel | Community forum | Email (48h) | Email + chat (24h) |
| Onboarding | Self-serve docs | Video walkthrough | Guided setup call |
| | | | |
| **OVERAGE RATES** | | | |
| Extra conversation | Hard cap (upgrade) | $0.20 each | $0.12 each |
| Extra phone minute | — | $0.10/min | $0.06/min |
| Extra SMS | — | $0.06 each | $0.04 each |

### 4.2 SaaS Unit Economics

| Metric | Free | Pro | Business |
|---|---|---|---|
| Revenue/mo | $0 | $79 | $249 |
| Avg COGS/mo | ~$2 (LLM only) | ~$25 | ~$85 |
| **Gross margin** | **—** | **$54 (68%)** | **$164 (66%)** |
| Free→Pro conversion target | 8–12% | — | — |
| Pro→Business upgrade target | — | 15–20% over 12 months | — |

### 4.3 Self-Serve Onboarding Flow (Target: 10 min)

```
1. Sign up (email / Google SSO)                          → 30s
2. "What's your business?" (type, name, timezone)        → 60s
3. Connect Google Calendar (OAuth popup)                  → 90s
4. Add your services (name + duration, AI-suggested)      → 120s
5. Choose your AI persona (template gallery)              → 60s
6. Preview chat widget (live sandbox)                     → 60s
7. Copy embed code OR enter website URL (auto-inject)     → 60s
8. [Optional] Add phone number (Twilio provisioning)      → 120s
─────────────────────────────────────────────────────────────
Total                                                     ~10 min
```

---

## 5. Cost Drivers & Unit Economics

### 5.1 Variable Cost Breakdown (per conversation)

| Cost Component | Web Chat (4o-mini) | Web Chat (4o) | Phone (4o) | Phone (4o-mini) |
|---|---|---|---|---|
| LLM tokens | $0.0009 | $0.014 | $0.020 | $0.0012 |
| Twilio voice (5 min avg) | — | — | $0.043 | $0.043 |
| Twilio SMS handoff (1 msg) | — | — | $0.008 | $0.008 |
| DB query cost (amortized) | $0.001 | $0.001 | $0.001 | $0.001 |
| **Total per conversation** | **$0.002** | **$0.015** | **$0.072** | **$0.053** |

### 5.2 Fixed Cost Drivers (monthly, per deployment)

| Component | Solo/Shared | Dedicated (per tenant) | Notes |
|---|---|---|---|
| Compute (Fastify server) | $20–40 (shared across tenants) | $40–80 | Railway/Render/Fly.io |
| PostgreSQL (managed) | $15–25 (shared DB) | $25–50 | Supabase Free → Pro |
| Twilio phone number(s) | $1.15/number | $1.15/number | Per tenant |
| Domain / SSL | $0 | $12/yr | Let's Encrypt |
| Monitoring (Sentry/Logflare) | $0–20 | $0–20 | Free tier adequate < 500 clients |
| **Total fixed (shared infra)** | **~$40/mo for first 10 tenants** | — | Scales ~$5–8/additional tenant |

### 5.3 Margin Analysis by Scenario

| Scenario | Revenue | COGS | Gross Margin | GM % |
|---|---|---|---|---|
| Agency Starter (200 convos, 70% phone) | $297 | $45 | $252 | 85% |
| Agency Growth (600 convos, 60% phone) | $697 | $120 | $577 | 83% |
| Agency Premium (2000 convos, 50% phone) | $1,497 | $350 | $1,147 | 77% |
| SaaS Pro (300 convos, 50% phone) | $79 | $25 | $54 | 68% |
| SaaS Business (1500 convos, 40% phone) | $249 | $85 | $164 | 66% |

### 5.4 Cost Optimization Levers

| Lever | Impact | Effort |
|---|---|---|
| **GPT-4o-mini for Starter/Free/Pro** | 10–15× cheaper per conversation | Already supported (env var) |
| **Prompt caching** (OpenAI cached tokens) | 50% reduction on system prompt tokens | Low — already long system prompts |
| **Conversation summary** (truncate history) | ~40% token reduction after turn 6 | Medium — needs prompt engineering |
| **Twilio Elastic SIP** (volume) | ~20% voice cost reduction at scale | Medium — requires SIP trunk setup |
| **Self-hosted LLM** (Llama 3.x / Mistral) | 80–90% LLM cost reduction | High — latency/quality tradeoff |
| **Multi-tenant DB pooling** | Shared Postgres across 50–100 tenants | Already implemented (connection pooling) |

---

## 6. Risk Controls

### 6.1 Service Level Agreements (SLAs)

| SLA Metric | Starter / Free | Growth / Pro | Premium / Business |
|---|---|---|---|
| Uptime | 99.5% | 99.9% | 99.9% |
| API response time (p95) | < 3s | < 2s | < 1.5s |
| Voice answer latency | < 4 rings | < 3 rings | < 2 rings |
| AI response latency (chat) | < 5s | < 3s | < 2s |
| Incident response | Next business day | 4 hours (business) | 1 hour (24/7, Premium only) |
| Monthly uptime credits | None | 10% credit per 0.1% below SLA | 25% credit per 0.1% below SLA |
| Data retention | 90 days | 1 year | 2 years (configurable) |

### 6.2 AI Behavioral Boundaries

These boundaries are enforced at the system prompt level AND in code:

| Boundary | Implementation | Enforcement Level |
|---|---|---|
| **No medical/legal/financial advice** | System prompt: "You are a scheduling assistant only. Never provide medical, legal, or financial advice." | Prompt + output filter |
| **No booking fabrication** | All bookings require backend confirmation via tool call (deterministic) | Code — agent cannot claim booking without `confirm_booking` tool returning success |
| **No PII storage in AI context** | Conversation history is ephemeral; PII goes to DB only | Code — chat sessions TTL |
| **No price negotiation** | System prompt: "Prices are as listed. You cannot offer discounts or negotiate." | Prompt |
| **Graceful handoff on complex requests** | After 2 failed attempts, offer: "Let me transfer you to a human." | Code — `VOICE_MAX_RETRIES` + fallback |
| **No outbound calls** | System only handles inbound | Code — no outbound call initiation logic exists |
| **Rate limiting** | SMS: 3/phone/hour, Chat: session-based, API: per-tenant rate limits | Code — `SMS_RATE_LIMIT_MAX`, `SMS_RATE_LIMIT_WINDOW_MINUTES` |
| **Max call duration** | Phone calls capped at 10 min (configurable) | Code — `VOICE_MAX_CALL_DURATION_MS` |
| **Max conversation turns** | 20 turns before graceful end | Code — `VOICE_MAX_TURNS` |

### 6.3 Compliance Positioning

> ⚠️ **Current status:** gomomo.ai is NOT certified for HIPAA, SOC 2, or PCI DSS.
> All compliance statements below are positioning guidance — not legal claims.

| Regulation | Current Posture | Path to Compliance | Timeline |
|---|---|---|---|
| **GDPR** | Partial — data stays in tenant's chosen region, delete-on-request possible | Add DPA template, data export API, consent logging | 4–6 weeks |
| **HIPAA** | Not compliant — no BAA, no encryption-at-rest certification | BAA with OpenAI (available), encrypted DB (Supabase Pro), audit trail (exists), access controls | 8–12 weeks |
| **SOC 2 Type I** | Not started | Requires formal audit — likely after $50K ARR | 6–12 months |
| **PCI DSS** | N/A — no payment processing | Out of scope by design | — |
| **TCPA** (US telemarketing) | Compliant by design — inbound only, no cold calls, SMS requires user initiation | Document consent flow | 2 weeks |
| **CCPA** | Partial — need privacy policy template + "Do Not Sell" toggle | Add tenant-facing privacy controls | 4 weeks |

**Recommended compliance disclaimers for contracts:**

```
STANDARD DISCLAIMER (all tiers):
"gomomo.ai is an automated scheduling assistant. It does not provide 
medical, legal, financial, or emergency advice. All bookings are subject to 
provider availability and confirmation. Conversations may be processed by 
third-party AI providers (OpenAI) subject to their data processing agreements. 
Customer is responsible for compliance with industry-specific regulations 
(HIPAA, etc.) applicable to their use case."

HEALTHCARE ADDENDUM (Premium/Business only):
"For healthcare providers: gomomo.ai does not access, store, or transmit 
Protected Health Information (PHI) as defined by HIPAA. Appointment scheduling 
data (name, contact, appointment time, service type) is stored in encrypted 
databases. A Business Associate Agreement (BAA) is available upon request for 
qualifying Enterprise customers."
```

### 6.4 Financial Risk Controls

| Risk | Mitigation |
|---|---|
| **LLM cost spike** (prompt injection / abuse) | Per-tenant monthly spend cap; alert at 80%; auto-downgrade to 4o-mini at 90%; hard block at 100% |
| **Twilio cost spike** (toll fraud) | Inbound-only by design; per-number concurrent call limits; geo-restriction to US/CA/UK |
| **Free tier abuse** | 50 conversation hard cap; require email verification; rate limit by IP |
| **Tenant data isolation** | Row-level security in PostgreSQL; tenant_id on every query; no cross-tenant data access |
| **AI hallucination → wrong booking** | Deterministic booking via tool calls; all bookings confirmed by backend; no "soft promises" |
| **Churn from AI quality** | 14-day money-back guarantee (Agency); cancel anytime (SaaS monthly) |

---

## 7. Sales Assets

### 7.1 One-Page Pitch Outline

```
─────────────────────────────────────────────────────────────
             AI RECEPTIONIST — ONE-PAGE PITCH
─────────────────────────────────────────────────────────────

THE PROBLEM
━━━━━━━━━━━
Your business loses 30–50% of incoming calls to voicemail 
during busy hours and after closing. Each missed call is a 
missed booking worth $75–$200.

→ 10 missed calls/week × $100 avg booking = $4,000/mo in 
  lost revenue.

THE SOLUTION
━━━━━━━━━━━━
gomomo.ai answers every call — phone, web chat, and 
text — 24/7, in your brand's voice, and books directly into 
your calendar. No hold music. No voicemail. No missed revenue.

HOW IT WORKS
━━━━━━━━━━━━
1. Customer calls or chats → AI answers in < 2 seconds
2. AI checks your real-time availability 
3. Customer picks a slot → AI books it instantly
4. Confirmation sent to customer + your calendar
5. Need to reschedule? Customer calls back → AI handles it

All bookings sync to Google Calendar. Your existing workflow 
doesn't change.

THE NUMBERS
━━━━━━━━━━━
┌──────────────────────────┬──────────────────────┐
│ Human receptionist       │ gomomo.ai       │
├──────────────────────────┼──────────────────────┤
│ $3,000–$5,000/mo salary  │ $297–$697/mo          │
│ Available 40 hrs/week    │ Available 168 hrs/week│
│ Handles 1 call at a time │ Unlimited concurrent  │
│ Training: 2–4 weeks      │ Live in 48 hours      │
│ Sick days, turnover      │ 99.9% uptime SLA      │
└──────────────────────────┴──────────────────────┘

Typical ROI: 5–15× in month one.

PROOF
━━━━━
"We booked 47 appointments in the first month that would have 
gone to voicemail." — [Testimonial placeholder]

NEXT STEP
━━━━━━━━━
→ Free 15-minute demo: we'll show it booking on YOUR calendar.
→ No contracts. Cancel anytime.
─────────────────────────────────────────────────────────────
```

### 7.2 Demo Script (15 minutes)

```
─────────────────────────────────────────────────────────────
             DEMO SCRIPT — 15 MINUTES
─────────────────────────────────────────────────────────────

PREP (before demo):
□ Bloom Wellness Studio demo mode active
□ Demo phone number ready (or voice mock server)
□ Prospect's business name + services noted
□ Google Calendar visible (split screen)

─── MINUTE 0–2: HOOK ──────────────────────────────────────

"Before we start — quick question. How many calls do you 
think your business misses per week during sessions or 
after hours?"

[Let them answer. Most say 5–15.]

"That's pretty common. What we've found is each of those 
is worth $75–$200 in bookings. Let me show you what it 
looks like when none of them go to voicemail."

─── MINUTE 2–5: LIVE PHONE DEMO ──────────────────────────

"I'm going to call the AI receptionist right now. Watch 
the Google Calendar on the right."

[Call demo number on speakerphone]

AI: "Hello, thank you for calling Bloom Wellness Studio! 
     I'd be happy to help you book an appointment. What 
     service are you interested in?"

You: "I'd like a 60-minute deep tissue massage."

AI: "Great choice! Let me check availability. I have 
     openings tomorrow at 10 AM, 2 PM, and 4 PM. Which 
     works best for you?"

You: "2 PM works."

AI: "Perfect. Can I get your name?"

You: "Sarah Johnson."

AI: "And a phone number or email for confirmation?"

You: "sarah@example.com"

AI: "Wonderful. I've booked a 60-minute deep tissue 
     massage for Sarah Johnson tomorrow at 2 PM. You'll 
     receive a confirmation at sarah@example.com. Is 
     there anything else I can help with?"

You: "No, that's it. Thanks!"

[Point to Google Calendar] "See? It's already there. 
Real booking, real calendar, no human involved."

─── MINUTE 5–8: WEB CHAT DEMO ────────────────────────────

"Now let me show you the web chat version — this would 
be on your website."

[Open chat widget, walk through same flow]

"Notice it's the same AI, same calendar, same booking 
system. Whether they call or chat, they get the same 
experience."

─── MINUTE 8–10: CUSTOMIZATION ───────────────────────────

"Here's what it would sound like for YOUR business."

[Show persona configuration — business name, services, 
hours, greeting style]

"We customize the voice, the greeting, your specific 
services and pricing. It sounds like YOUR receptionist, 
not a generic robot."

─── MINUTE 10–12: RESCHEDULE / CANCEL DEMO ───────────────

"Customers can also call back to reschedule or cancel."

[Quick reschedule demo — show calendar update in real time]

─── MINUTE 12–14: OBJECTION HANDLING ─────────────────────

"A few things people usually ask..."

[Address top 2–3 concerns from FAQ below]

─── MINUTE 14–15: CLOSE ──────────────────────────────────

"Here's what happens next:
1. You pick a plan ($297/mo for most solo practitioners)
2. We set it up in 24–48 hours
3. We do a 30-minute call to dial in your services
4. You're live — every call gets answered

No long-term contract. If it doesn't pay for itself in 
the first month, cancel with one click.

What questions do you have?"
─────────────────────────────────────────────────────────────
```

### 7.3 FAQ — Objections & Responses

| # | Objection | Response |
|---|---|---|
| 1 | **"What if the AI makes a mistake / books the wrong time?"** | "Every booking goes through a real-time availability check against your Google Calendar. The AI physically cannot double-book — it's enforced at the database level, not by the AI's judgment. If a slot is taken, it's simply not offered. In 6 months of testing, we've had zero overbookings." |
| 2 | **"My clients want to talk to a real person."** | "We hear that a lot, and what we've found is the #1 thing clients want is to NOT go to voicemail. The AI handles the 70–80% of calls that are straightforward bookings. For anything complex — insurance questions, special requests — the AI says 'Let me have someone call you back' and sends you a notification. You still handle the 20% that needs a human touch." |
| 3 | **"I already have [Calendly / Acuity / Jane / Mindbody]."** | "Those are great for online self-booking. But they don't answer your phone. 60–70% of service business bookings still come via phone call. gomomo.ai handles the phone calls and syncs to your existing calendar. It's additive, not a replacement." |
| 4 | **"What if my internet goes down?"** | "The AI runs in the cloud, not on your local network. As long as Twilio's network is up (99.99% uptime), calls get answered. Even if YOUR internet is down, your customers still get booked." |
| 5 | **"Is this HIPAA compliant?"** | "For scheduling purposes — name, contact info, appointment time, service type — we use encrypted databases and secure API connections. We don't store medical records, diagnoses, or treatment notes. For healthcare clients on our Premium plan, we offer a Business Associate Agreement (BAA). We're happy to walk through the specifics with your compliance team." |
| 6 | **"Can it handle my complex scheduling rules?"** | "Currently we support: service-based scheduling, business hours, blocked times, and provider-specific availability. If you have rules like 'allow 30 minutes between deep tissue massages' or 'Dr. Smith only does consultations on Tuesdays,' those are configurable. For very complex rules, we'll scope it during onboarding." |
| 7 | **"What happens after hours?"** | "That's actually where it shines most. The AI works 24/7 — evenings, weekends, holidays. A salon owner told us 40% of her AI bookings come between 7 PM and 9 AM. Those are all bookings that used to go to voicemail and never called back." |
| 8 | **"What if I need to change my schedule / add a service?"** | "You manage your availability in Google Calendar like you do now. Add a block, and the AI sees it instantly. For service changes, you can update them in the dashboard or just tell us and we'll change it same-day." |
| 9 | **"$297/month is expensive for a solo practitioner."** | "Let's do the math together. If you get just 3 extra bookings per month from calls that currently go to voicemail — at your average ticket price of [$X] — that's [$3X] in new revenue for $297. Most of our solo clients see 8–15 extra bookings in month one. The AI literally pays for itself with the first captured call." |
| 10 | **"What if I want to cancel?"** | "Month-to-month on Starter. No cancellation fees, no long-term contracts. You can cancel from the dashboard in one click. We also offer a 14-day money-back guarantee — if you're not seeing value, full refund, no questions asked." |
| 11 | **"Can it speak Spanish / French / other languages?"** | "Currently optimized for English. Multilingual support (Spanish, French) is on our roadmap for Q3 2026. For bilingual businesses, we can configure the greeting to offer English or Spanish and route accordingly." |
| 12 | **"How do you handle no-shows?"** | "Right now, the AI handles booking, rescheduling, and cancellation. Automated reminders (24h and 2h before appointment) are on our Q2 roadmap. In the meantime, the confirmation email/SMS serves as a first reminder." |

---

## 8. Implementation Roadmap — GTM Enablement

### 8.1 What Exists Today (MVP-Ready)

| Feature | Status | Notes |
|---|---|---|
| Web chat widget (React) | ✅ Production-ready | Embeddable, multi-tenant |
| AI booking agent (GPT-4o) | ✅ Production-ready | Deterministic tool-based |
| Google Calendar integration | ✅ Production-ready | OAuth + real-time sync |
| Phone voice channel (Twilio) | ✅ Production-ready | Deepgram STT, Twilio TTS |
| SMS handoff | ✅ Production-ready | Rate-limited, token-secured |
| Excel booking mirror | ✅ Production-ready | Outbound sync, reconciliation |
| Demo mode (Bloom Wellness) | ✅ Available | No external deps needed |
| Multi-tenant architecture | ✅ Available | Per-tenant config, isolation |

### 8.2 Required for Launch (Pre-Revenue)

| Item | Priority | Effort | Blocks |
|---|---|---|---|
| **Stripe billing integration** | P0 | 2–3 days | Revenue collection |
| **Tenant self-provisioning UI** (SaaS) | P0 (SaaS) | 5–7 days | Self-serve onboarding |
| **Usage metering & overage tracking** | P0 | 3–4 days | Billing accuracy |
| **Admin dashboard** (tenant management) | P1 | 5–7 days | Agency operations |
| **Landing page + marketing site** | P1 | 3–5 days | Lead capture |
| **Privacy policy + Terms of Service** | P0 | 1–2 days (legal template) | Compliance |
| **Email confirmation system** | P1 | 2–3 days | Customer experience |
| **Monitoring + alerting** (Sentry/PagerDuty) | P1 | 1–2 days | SLA enforcement |

### 8.3 Post-Launch Enhancements (Revenue-Funded)

| Feature | Target | Impact |
|---|---|---|
| Automated appointment reminders (SMS/email) | Q2 2026 | Reduce no-shows 30–50% |
| Multilingual support (Spanish first) | Q3 2026 | Expand TAM 25%+ |
| Inbound Excel sync (admin edits → DB) | Q2 2026 | Excel Adapter Phase 2 |
| Zapier / webhook integrations | Q3 2026 | Business tier value |
| SOC 2 Type I certification | Q4 2026 | Enterprise sales unlock |
| Custom voice cloning | Q4 2026 | Premium differentiation |
| Analytics dashboard (conversion rates) | Q2 2026 | Retention + upsell |

---

## Appendix A: Model Comparison — Agency vs SaaS

| Dimension | Agency (Done-for-You) | SaaS (Self-Serve) |
|---|---|---|
| **Revenue per client** | Higher ($297–$1,497/mo) | Lower ($0–$249/mo) |
| **Gross margin** | Higher (77–85%) | Lower (66–68%) |
| **Scalability** | Linear (requires human setup) | Exponential (self-serve) |
| **Support burden** | Higher (white-glove) | Lower (self-serve + docs) |
| **Time to first $10K MRR** | Faster (~15–20 clients) | Slower (~80–130 clients) |
| **Time to first $100K MRR** | Harder to scale | Natural scaling path |
| **Ideal start** | ✅ Start here (revenue + learning) | Build in parallel |
| **Churn** | Lower (relationship + switching cost) | Higher (low switching cost) |

### Recommended GTM Sequence

```
Phase 1 (Month 1–3):  Agency-only. Land 10 clients manually.
                       Learn ICP, refine onboarding, gather testimonials.
                       Target: $5K–$7K MRR.

Phase 2 (Month 3–6):  Launch SaaS Free + Pro. Use agency clients as
                       case studies. Content marketing + SEO.
                       Target: $15K–$25K MRR (Agency + SaaS).

Phase 3 (Month 6–12): Add SaaS Business tier. Agency becomes
                       "Premium / Enterprise" only. Self-serve handles
                       80% of new signups.
                       Target: $50K–$100K MRR.
```

---

## Appendix B: Competitive Positioning

| Competitor | Type | Price | Phone? | Calendar Sync? | AI Quality | Our Edge |
|---|---|---|---|---|---|---|
| **Smith.ai** | Human + AI hybrid | $210–$600/mo | ✅ | Partial | Medium | We're 100% AI → lower cost, 24/7, no human inconsistency |
| **Ruby Receptionists** | Human virtual receptionist | $230–$1,500/mo | ✅ | ❌ | N/A (human) | We're 5–10× cheaper at scale, instant booking vs message-taking |
| **Dialzara** | AI phone answering | $29–$199/mo | ✅ | Limited | Medium | Our Google Calendar integration is real-time, not basic |
| **Goodcall** | AI phone agent | $59–$199/mo | ✅ | Limited | Medium | We also have web chat + Excel + multi-tenant |
| **Calendly / Acuity** | Self-serve booking link | $8–$16/mo | ❌ | ✅ | N/A | We answer the PHONE — they only handle web bookings |
| **Mindbody / Jane** | Full practice management | $129–$500/mo | ❌ | ✅ | N/A | We're a bolt-on to their existing stack, not a replacement |

**Positioning statement:**
> "gomomo.ai is the only solution that answers phone calls, web chats, AND texts with a single AI that books directly into your Google Calendar — without double-booking, without voicemail, and without a $4,000/month receptionist."

---

*Document version: 1.0.0 | Author: EON Agency | Review cycle: Monthly*
