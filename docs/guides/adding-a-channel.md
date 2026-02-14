# Adding a Channel

> **Goal:** Add a new customer-facing intake channel (WhatsApp, email, Telegram, etc.)
> that connects to the AI booking engine.
>
> **Time:** 3–6 hours for a basic channel.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [The Channel Interface](#2-the-channel-interface)
3. [How Existing Channels Work](#3-how-existing-channels-work)
4. [Step-by-Step: Add a New Channel](#4-step-by-step-add-a-new-channel)
5. [Register Your Channel](#5-register-your-channel)
6. [Testing](#6-testing)
7. [Channel Feature Matrix](#7-channel-feature-matrix)
8. [FAQ](#8-faq)

---

## 1. Architecture Overview

```
Customer ──▶ Channel Adapter ──▶ AI Agent ──▶ Services ──▶ DB + Calendar
                                 (shared)     (shared)     (shared)

Channels are the "front door". Everything behind the agent is channel-agnostic.
```

Each channel is a self-contained **Fastify plugin** that:
1. Registers its own routes (webhooks, WebSocket handlers, etc.)
2. Receives messages from the customer
3. Sends messages to the AI agent via `handleChatMessage()`
4. Formats the AI response back to the channel's native format
5. Manages its own sessions and lifecycle

**The AI agent, services, and database are completely shared.** Adding a
channel never touches booking logic, availability logic, or database code.

---

## 2. The Channel Interface

```typescript
// src/channels/index.ts

import type { FastifyInstance } from 'fastify';

/**
 * A Channel is a customer-facing communication adapter.
 * Each channel is a Fastify plugin that registers its own routes
 * and handles its own session management.
 */
export interface Channel {
  /** Unique name for this channel */
  readonly name: string;    // 'web-chat' | 'voice-twilio' | 'whatsapp' | 'email'

  /**
   * Register this channel with the Fastify app.
   * This is where you add routes, Socket.IO handlers, webhook endpoints, etc.
   */
  register(app: FastifyInstance): Promise<void>;

  /**
   * Graceful shutdown. Clean up connections, timers, etc.
   */
  shutdown(): Promise<void>;
}
```

### The Core Integration Point

Every channel eventually calls the same function to get an AI response:

```typescript
import { handleChatMessage } from '../agent/chat-handler.js';

// Inside your channel handler:
const response = await handleChatMessage(
  sessionId,     // Unique per conversation
  tenantId,      // Which business this is for
  userMessage,   // The text the customer sent
  tenant,        // Full tenant config object
);
// response is a string — the AI's reply
```

That's it. The AI agent handles tool calling, availability checks, booking
confirmation, etc. Your channel just needs to:
1. **Get the text in** (from whatever format your channel uses)
2. **Send the text out** (in whatever format your channel needs)

---

## 3. How Existing Channels Work

### Web Chat (Socket.IO)

```
Browser ──WebSocket──▶ Socket.IO handler ──▶ handleChatMessage() ──▶ AI response
                                                                         │
Browser ◀──WebSocket── emit('response', ...)  ◀────────────────────────┘
```

**Location:** Currently inline in `src/index.ts` (target: `src/channels/web-chat/plugin.ts`)

**Key code:**
```typescript
socket.on('message', async (data: { message: string }) => {
  const response = await handleChatMessage(sessionId, tenantId, data.message, tenant);
  socket.emit('response', { session_id: sessionId, response });
});
```

### Voice (Twilio)

```
Phone call ──▶ Twilio ──webhook──▶ /twilio/voice/incoming
                                        │
                                   NLU + state machine
                                        │
                                   Tool executor (services)
                                        │
                                   TwiML response ──▶ Twilio ──▶ Caller hears speech
```

**Location:** `src/voice/*` (target: `src/channels/voice-twilio/`)

The voice channel is more complex because it uses a **state machine** instead
of free-form chat. The NLU extracts intents/entities from speech, and the
conversation engine calls the same services (availability, booking) but through
a structured flow rather than through the LLM.

---

## 4. Step-by-Step: Add a New Channel

Let's walk through adding a **WhatsApp** channel via the Twilio WhatsApp API.

### Step 1: Create the Channel Directory

```bash
mkdir -p src/backend/src/channels/whatsapp-twilio
touch src/backend/src/channels/whatsapp-twilio/plugin.ts
```

### Step 2: Implement the Channel Plugin

```typescript
// src/channels/whatsapp-twilio/plugin.ts

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Channel } from '../index.js';
import { handleChatMessage } from '../../agent/chat-handler.js';
import { tenantRepo } from '../../repos/tenant.repo.js';
import { env } from '../../config/env.js';

/**
 * WhatsApp channel via Twilio WhatsApp API.
 *
 * Twilio sends incoming WhatsApp messages as POST webhooks.
 * We process them through the same AI agent and reply via
 * the Twilio REST API.
 */
class WhatsAppTwilioChannel implements Channel {
  readonly name = 'whatsapp-twilio';

  async register(app: FastifyInstance): Promise<void> {
    // Twilio sends POST with form-encoded body
    app.post('/whatsapp/incoming', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Record<string, string>;

      const from = body.From;           // 'whatsapp:+1234567890'
      const messageBody = body.Body;    // The user's message text
      const to = body.To;               // 'whatsapp:+0987654321' (your Twilio number)

      // Resolve tenant from the Twilio phone number
      // (In production, map phone numbers to tenants in a lookup table)
      const tenantId = env.VOICE_DEFAULT_TENANT_ID;
      const tenant = await tenantRepo.findById(tenantId);

      if (!tenant) {
        return reply.type('text/xml').send(
          '<Response><Message>Sorry, this service is not configured.</Message></Response>'
        );
      }

      // Use the WhatsApp phone number as the session ID
      // This maintains conversation continuity across messages
      const sessionId = `wa-${from.replace('whatsapp:', '')}`;

      try {
        // Call the same AI agent used by web chat
        const response = await handleChatMessage(
          sessionId,
          tenantId,
          messageBody,
          tenant,
        );

        // Reply via TwiML (Twilio will send the WhatsApp response)
        return reply.type('text/xml').send(
          `<Response><Message>${escapeXml(response)}</Message></Response>`
        );
      } catch (error) {
        console.error('WhatsApp handler error:', error);
        return reply.type('text/xml').send(
          '<Response><Message>Sorry, something went wrong. Please try again.</Message></Response>'
        );
      }
    });

    console.log('WhatsApp channel registered — webhook at /whatsapp/incoming');
  }

  async shutdown(): Promise<void> {
    // No persistent connections to clean up for webhook-based channels
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const whatsappTwilioChannel = new WhatsAppTwilioChannel();
```

### Step 3: Add an Environment Variable / Feature Flag

In `src/config/env.ts`:

```typescript
WHATSAPP_ENABLED: z.enum(['true', 'false']).default('false'),
```

### Step 4: Register in index.ts

```typescript
import { whatsappTwilioChannel } from './channels/whatsapp-twilio/plugin.js';

// In the startup function:
if (env.WHATSAPP_ENABLED === 'true') {
  await whatsappTwilioChannel.register(app);
  channels.push(whatsappTwilioChannel);
}
```

### Step 5: Configure Twilio

In the Twilio console:
1. Go to **Messaging > WhatsApp Senders**
2. Set the webhook URL to `https://api.your-domain.com/whatsapp/incoming`
3. Method: `POST`

---

## 5. Register Your Channel

The channel registry in `index.ts` follows a consistent pattern:

```typescript
// src/index.ts — channel registration section

import type { Channel } from './channels/index.js';

const activeChannels: Channel[] = [];

// ── Web Chat (always enabled) ─────────────────────
import { webChatChannel } from './channels/web-chat/plugin.js';
activeChannels.push(webChatChannel);
await webChatChannel.register(app);

// ── Voice (Twilio) ────────────────────────────────
if (env.VOICE_ENABLED === 'true') {
  const { voiceTwilioChannel } = await import('./channels/voice-twilio/plugin.js');
  activeChannels.push(voiceTwilioChannel);
  await voiceTwilioChannel.register(app);
}

// ── WhatsApp (Twilio) ─────────────────────────────
if (env.WHATSAPP_ENABLED === 'true') {
  const { whatsappTwilioChannel } = await import('./channels/whatsapp-twilio/plugin.js');
  activeChannels.push(whatsappTwilioChannel);
  await whatsappTwilioChannel.register(app);
}

// ── Graceful shutdown ─────────────────────────────
for (const channel of activeChannels) {
  await channel.shutdown();
}
```

---

## 6. Testing

### Manual Testing

```bash
# Simulate a Twilio WhatsApp webhook:
curl -X POST http://localhost:3000/whatsapp/incoming \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=whatsapp%3A%2B15551234567&Body=I%20want%20to%20book%20an%20appointment&To=whatsapp%3A%2B15559876543"
```

Expected: TwiML response with the AI's reply.

### Automated Test Pattern

```typescript
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { whatsappTwilioChannel } from './plugin.js';

describe('WhatsApp Channel', () => {
  it('responds with TwiML to incoming message', async () => {
    const app = Fastify();
    await app.register(formbody);
    await whatsappTwilioChannel.register(app);

    const response = await app.inject({
      method: 'POST',
      url: '/whatsapp/incoming',
      payload: 'From=whatsapp%3A%2B15551234567&Body=Hello&To=whatsapp%3A%2B15559876543',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');
    expect(response.body).toContain('<Message>');
  });
});
```

---

## 7. Channel Feature Matrix

| Feature | Web Chat | Voice (Twilio) | WhatsApp | Email | SMS |
|---|---|---|---|---|---|
| **Transport** | WebSocket | Webhook + TwiML | Webhook + TwiML | SMTP/IMAP | Webhook + REST |
| **AI Mode** | Full LLM chat | State machine + NLU | Full LLM chat | Full LLM chat | Full LLM chat |
| **Session persistence** | Socket connection | Call SID | Phone number | Email thread | Phone number |
| **Rich formatting** | Markdown | Speech only | Limited Markdown | HTML | Plain text |
| **Attachments** | No | No | Images (future) | Files (future) | No |
| **Latency target** | < 2s | < 3s | < 5s | < 30s (async) | < 5s |
| **Feature flag** | Always on | `VOICE_ENABLED` | `WHATSAPP_ENABLED` | `EMAIL_ENABLED` | `SMS_ENABLED` |

### Channel Complexity Guide

| Channel | Complexity | Dependencies | Notes |
|---|---|---|---|
| **Web Chat** | Low | Socket.IO | Already built. Just extract to plugin. |
| **WhatsApp (Twilio)** | Low | Twilio account | Webhook-based, very similar to SMS |
| **SMS** | Low | Twilio account | Already built (handoff). Extend to full conversations. |
| **Email** | Medium | SMTP server, IMAP | Async conversation model. Need thread tracking. |
| **Telegram** | Low | Telegram Bot API | Webhook-based, Markdown support |
| **Facebook Messenger** | Medium | Meta Business Platform | Webhook + verification challenge |
| **Slack** | Medium | Slack API | OAuth + event subscriptions |
| **Custom API** | Low | None | REST/webhook for integration with existing systems |

---

## 8. FAQ

**Q: Does the AI agent need changes for a new channel?**
A: No. The agent receives plain text and returns plain text. It's completely
channel-agnostic. The channel adapter handles format conversion.

**Q: How do I handle rich messages (images, buttons)?**
A: The AI returns plain text. Your channel adapter can post-process the text
to add channel-specific rich elements:

```typescript
function formatForWhatsApp(aiResponse: string): string {
  // Convert markdown bold **text** to WhatsApp bold *text*
  return aiResponse.replace(/\*\*(.+?)\*\*/g, '*$1*');
}
```

**Q: How do I handle multi-tenant routing?**
A: Each channel needs a way to resolve which tenant a message belongs to:

| Channel | Tenant Resolution |
|---|---|
| Web Chat | Client sends `tenant_id` on WebSocket `join` |
| Voice | Twilio phone number → tenant mapping table |
| WhatsApp | Twilio WhatsApp number → tenant mapping table |
| Email | Recipient address → tenant mapping table |

**Q: Can I have the voice channel use the LLM instead of the state machine?**
A: Yes. Replace the NLU + state machine with `handleChatMessage()`. The
state machine exists because voice conversations need more structured flow
control (barge-in, timeouts, retries). But for simpler use cases, direct
LLM chat over voice works fine.

**Q: How do I rate-limit a channel?**
A: Use Fastify's rate-limiting plugin per route prefix:

```typescript
import rateLimit from '@fastify/rate-limit';

async register(app: FastifyInstance) {
  await app.register(rateLimit, {
    max: 30,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.body as any)?.From ?? req.ip,
  });
  // ... register routes
}
```

**Q: Where should I store channel-specific session data?**
A: Use the existing `chat_sessions` table. The `metadata` JSONB column
can store any channel-specific data:

```typescript
await sessionRepo.updateMetadata(sessionId, {
  channel: 'whatsapp',
  phone: '+15551234567',
  last_message_at: new Date().toISOString(),
});
```
