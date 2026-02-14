# @eon/receptionist-sdk

A lightweight JavaScript/TypeScript SDK for embedding the AI Receptionist into **websites**, **mobile apps**, and **desktop applications**.

Supports **real-time WebSocket** connections for web and **REST API** transport for mobile / serverless environments.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Website Embed Guide](#website-embed-guide)
- [Mobile / REST API Guide](#mobile--rest-api-guide)
- [API Reference](#api-reference)
- [Events](#events)
- [Auth Flow](#auth-flow)
- [Configuration](#configuration)
- [Error Handling](#error-handling)
- [Examples](#examples)

---

## Quick Start

```bash
npm install @eon/receptionist-sdk
```

```typescript
import { ReceptionistClient } from '@eon/receptionist-sdk';

const client = new ReceptionistClient({
  serverUrl: 'https://your-server.com',
  tenantId: 'YOUR_TENANT_ID',
});

client.on('message', (msg) => {
  console.log('Assistant:', msg.response);
});

const session = await client.startSession();
console.log('Session ID:', session.session_id);

await client.sendMessage('I want to book an appointment');
```

---

## Installation

### NPM / Yarn (recommended for bundled apps)

```bash
npm install @eon/receptionist-sdk
# or
yarn add @eon/receptionist-sdk
```

### CDN / Script Tag (for website embeds)

```html
<script src="https://your-server.com/sdk/receptionist-sdk.min.js"></script>
<script>
  const client = new ReceptionistSDK.ReceptionistClient({ ... });
</script>
```

The UMD bundle exposes a global `ReceptionistSDK` object containing:
- `ReceptionistSDK.ReceptionistClient`
- `ReceptionistSDK.SDK_VERSION`

### Module Formats

| Format | Path                    | Use Case                       |
| ------ | ----------------------- | ------------------------------ |
| ESM    | `dist/esm/index.js`    | Modern bundlers (Vite, Webpack 5) |
| CJS    | `dist/cjs/index.js`    | Node.js / older bundlers       |
| UMD    | `dist/umd/receptionist-sdk.min.js` | `<script>` tag embedding |
| Types  | `dist/types/index.d.ts` | TypeScript definitions         |

---

## Website Embed Guide

### Step 1: Add the Script

Place this snippet before your closing `</body>` tag:

```html
<script src="https://your-server.com/sdk/receptionist-sdk.min.js"></script>
```

### Step 2: Initialize the Client

```html
<script>
  const client = new ReceptionistSDK.ReceptionistClient({
    serverUrl: 'https://your-server.com',
    tenantId: 'YOUR_TENANT_ID',
    // Optional: identify returning customers
    customerEmail: 'visitor@example.com',
  });
</script>
```

### Step 3: Start a Session and Handle Messages

```html
<script>
  // Listen for responses
  client.on('message', (msg) => {
    appendToChat('assistant', msg.response);
  });

  // Listen for typing indicator
  client.on('typing', (isTyping) => {
    showTyping(isTyping);
  });

  // Start the session
  client.startSession().then((session) => {
    console.log('Connected! Session:', session.session_id);
    enableChatInput();
  });

  // Send user messages
  function onSend(text) {
    appendToChat('user', text);
    client.sendMessage(text);
  }
</script>
```

### Step 4: Handle Push Events

Push events are delivered automatically over the WebSocket connection:

```javascript
client.on('push', (event) => {
  // event.type — e.g. 'booking_confirmed', 'reminder'
  // event.payload — event-specific data
  console.log('Push:', event.type, event.payload);
});
```

### Complete Embed Example

See [`examples/embed.html`](./examples/embed.html) for a full working example with a floating chat widget.

---

## Mobile / REST API Guide

Mobile apps (iOS, Android) should use the **REST transport** — no WebSocket dependency required.

### Auth Flow

```
┌─────────┐                    ┌──────────┐
│  Mobile  │                    │  Server  │
│   App    │                    │          │
└────┬─────┘                    └────┬─────┘
     │  POST /api/auth/session       │
     │  { tenant_id, customer_email }│
     │ ─────────────────────────────►│
     │                               │
     │  { token, session_id,         │
     │    expires_at }               │
     │ ◄─────────────────────────────│
     │                               │
     │  POST /api/tenants/:id/chat   │
     │  Authorization: Bearer <token>│
     │  { session_id, message }      │
     │ ─────────────────────────────►│
     │                               │
     │  { response, meta }           │
     │ ◄─────────────────────────────│
     │                               │
     │  POST /api/auth/refresh       │
     │  { token } (before expiry)    │
     │ ─────────────────────────────►│
     │  { token (new), ... }         │
     │ ◄─────────────────────────────│
```

### Using the SDK (REST mode)

```typescript
import { ReceptionistClient } from '@eon/receptionist-sdk';

const client = new ReceptionistClient({
  serverUrl: 'https://your-server.com',
  tenantId: 'YOUR_TENANT_ID',
  transport: 'rest',
  customerEmail: 'user@example.com',
});

const session = await client.startSession();
// session.token — store securely
// session.expires_at — schedule refresh before expiry

const response = await client.sendMessage('I need to reschedule');
console.log(response.response);
```

### Direct API Calls (without SDK)

If you prefer to call the API directly without the SDK:

#### 1. Start a Session

```bash
curl -X POST https://your-server.com/api/auth/session \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "YOUR_TENANT_ID",
    "customer_email": "user@example.com"
  }'
```

Response:
```json
{
  "token": "eyJhbGci...",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "tenant_id": "YOUR_TENANT_ID",
  "expires_at": "2025-01-15T18:30:00.000Z",
  "returning_customer": {
    "display_name": "Jane Smith",
    "customer_id": "cust_123"
  }
}
```

#### 2. Send a Message

```bash
curl -X POST https://your-server.com/api/tenants/YOUR_TENANT_ID/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "message": "I want to book a haircut for tomorrow at 2pm"
  }'
```

Response:
```json
{
  "response": "I'd be happy to help! Let me check availability for tomorrow at 2:00 PM...",
  "meta": {
    "intent": "booking",
    "confidence": 0.95,
    "guardrail_status": "passed"
  }
}
```

#### 3. Refresh Token

```bash
curl -X POST https://your-server.com/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{ "token": "YOUR_CURRENT_TOKEN" }'
```

### Swift (iOS) Example

```swift
import Foundation

struct SessionResponse: Codable {
    let token: String
    let session_id: String
    let tenant_id: String
    let expires_at: String
}

struct ChatResponse: Codable {
    let response: String
}

class ReceptionistAPI {
    let serverUrl: String
    let tenantId: String
    var token: String?
    var sessionId: String?

    init(serverUrl: String, tenantId: String) {
        self.serverUrl = serverUrl
        self.tenantId = tenantId
    }

    func startSession() async throws -> SessionResponse {
        let url = URL(string: "\(serverUrl)/api/auth/session")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["tenant_id": tenantId])

        let (data, _) = try await URLSession.shared.data(for: request)
        let session = try JSONDecoder().decode(SessionResponse.self, from: data)
        self.token = session.token
        self.sessionId = session.session_id
        return session
    }

    func sendMessage(_ text: String) async throws -> String {
        guard let token, let sessionId else {
            throw NSError(domain: "ReceptionistAPI", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No active session"])
        }

        let url = URL(string: "\(serverUrl)/api/tenants/\(tenantId)/chat")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "session_id": sessionId,
            "message": text
        ])

        let (data, _) = try await URLSession.shared.data(for: request)
        let chat = try JSONDecoder().decode(ChatResponse.self, from: data)
        return chat.response
    }
}
```

### Kotlin (Android) Example

```kotlin
import kotlinx.serialization.*
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*

@Serializable
data class SessionResponse(
    val token: String,
    val session_id: String,
    val tenant_id: String,
    val expires_at: String
)

class ReceptionistAPI(
    private val serverUrl: String,
    private val tenantId: String
) {
    private val client = HttpClient()
    private var token: String? = null
    private var sessionId: String? = null

    suspend fun startSession(): SessionResponse {
        val response = client.post("$serverUrl/api/auth/session") {
            contentType(ContentType.Application.Json)
            setBody("""{"tenant_id":"$tenantId"}""")
        }
        val session = Json.decodeFromString<SessionResponse>(
            response.bodyAsText()
        )
        token = session.token
        sessionId = session.session_id
        return session
    }

    suspend fun sendMessage(text: String): String {
        val response = client.post("$serverUrl/api/tenants/$tenantId/chat") {
            contentType(ContentType.Application.Json)
            header("Authorization", "Bearer $token")
            setBody("""{"session_id":"$sessionId","message":"$text"}""")
        }
        return response.bodyAsText()
    }
}
```

---

## API Reference

### `ReceptionistClient`

#### Constructor

```typescript
new ReceptionistClient(config: ReceptionistConfig)
```

| Option           | Type                          | Default        | Description |
| ---------------- | ----------------------------- | -------------- | ----------- |
| `serverUrl`      | `string`                      | *required*     | Backend URL (e.g. `https://app.example.com`) |
| `tenantId`       | `string`                      | *required*     | Tenant UUID |
| `customerEmail`  | `string`                      | `undefined`    | Identify returning customers |
| `customerPhone`  | `string`                      | `undefined`    | Alternate customer identifier |
| `transport`      | `'websocket' \| 'rest'`       | `'websocket'`  | Connection mode |
| `wsPath`         | `string`                      | `'/ws'`        | Socket.IO server path |
| `authEndpoint`   | `string`                      | `'/api/auth/session'` | Token endpoint |
| `chatEndpoint`   | `string`                      | `'/api/tenants/{tenantId}/chat'` | Chat endpoint |
| `autoReconnect`  | `boolean`                     | `true`         | Auto-reconnect WebSocket |

#### Methods

| Method | Returns | Description |
| ------ | ------- | ----------- |
| `startSession()` | `Promise<SessionResponse>` | Authenticate and open a session |
| `sendMessage(text)` | `Promise<void>` (ws) / `Promise<ChatResponse>` (rest) | Send a chat message |
| `subscribeToPush()` | `void` | Enable push events (auto-enabled on WebSocket) |
| `on(event, callback)` | `void` | Register an event listener |
| `off(event, callback)` | `void` | Remove an event listener |
| `disconnect()` | `void` | Close the connection |
| `getToken()` | `string \| null` | Current session token |
| `getSessionId()` | `string \| null` | Current session ID |
| `getSession()` | `SessionResponse \| null` | Full session response |

---

## Events

| Event          | Payload                          | Description |
| -------------- | -------------------------------- | ----------- |
| `connected`    | `SessionResponse`                | Session established |
| `message`      | `ChatResponse`                   | Assistant response received |
| `typing`       | `boolean`                        | Typing indicator toggled |
| `status`       | `StatusEvent`                    | Processing status update |
| `push`         | `PushEvent`                      | Push notification (booking, reminder, etc.) |
| `error`        | `{ error: string, code?: string }` | Error occurred |
| `disconnected` | `{ reason: string }`             | Connection lost |

### Event Examples

```typescript
client.on('message', (msg) => {
  // msg.response — assistant text
  // msg.meta?.intent — detected intent
  // msg.meta?.guardrail_status — safety status
});

client.on('push', (event) => {
  // event.type — 'booking_confirmed' | 'reminder' | ...
  // event.payload.slots — available time slots
  // event.payload.reference_code — booking reference
});

client.on('status', (status) => {
  // status.phase — 'thinking' | 'searching' | 'booking'
  // status.detail — human-readable description
});
```

---

## Auth Flow

Tokens are **short-lived HMAC-SHA256 signed** payloads (4-hour TTL by default). No user accounts are required — sessions are anonymous or optionally linked to a customer via email/phone.

### Token Lifecycle

1. **Issue** — `POST /api/auth/session` → returns signed token
2. **Use** — Include as `Authorization: Bearer <token>` or in WebSocket join
3. **Refresh** — `POST /api/auth/refresh` before expiry → new token, same session
4. **Expire** — After TTL, token is rejected; client must start a new session

### Backwards Compatibility

When `SDK_AUTH_REQUIRED=false` (the default), the server accepts requests **with or without** tokens. This lets existing integrations continue working while new clients adopt the SDK.

Set `SDK_AUTH_REQUIRED=true` in production to enforce token auth on all requests.

### Token Security

- Tokens are **not JWTs** — they are compact HMAC-SHA256 signed payloads
- Signature verification uses **timing-safe comparison** to prevent timing attacks
- Tokens are scoped to a specific **tenant** and **session**
- Tokens cannot be used to access other tenants' data
- Tokens do not contain sensitive data (no passwords, no PII beyond customer ID)

---

## Configuration

### Environment Variables (Server-side)

| Variable               | Default            | Description |
| ---------------------- | ------------------ | ----------- |
| `SESSION_TOKEN_SECRET` | Falls back to `ENCRYPTION_KEY` | HMAC signing secret |
| `SDK_AUTH_REQUIRED`    | `false`            | Enforce token auth on all requests |

### Production Checklist

- [ ] Set `SESSION_TOKEN_SECRET` to a strong random secret (min 32 chars)
- [ ] Set `SDK_AUTH_REQUIRED=true` to enforce authentication
- [ ] Serve the SDK bundle via HTTPS
- [ ] Configure CORS to allow only your website domains
- [ ] Consider rate-limiting `/api/auth/session` to prevent abuse

---

## Error Handling

```typescript
client.on('error', (err) => {
  switch (err.code) {
    case 'TOKEN_EXPIRED':
      // Token has expired — start a new session
      client.startSession();
      break;
    case 'TENANT_MISMATCH':
      // Token doesn't match the tenant — configuration error
      console.error('Tenant ID mismatch');
      break;
    case 'SESSION_FAILED':
      // Could not create session — server may be down
      showRetryUI();
      break;
    default:
      console.error('Chat error:', err.error);
  }
});
```

### Common Errors

| Code               | Cause                               | Fix |
| ------------------ | ----------------------------------- | --- |
| `TOKEN_EXPIRED`    | Token TTL exceeded                  | Call `startSession()` again |
| `TOKEN_INVALID`    | Malformed or tampered token         | Call `startSession()` again |
| `TENANT_MISMATCH`  | Token was issued for a different tenant | Check `tenantId` config |
| `TENANT_NOT_FOUND` | Tenant ID doesn't exist             | Verify tenant ID |
| `SESSION_FAILED`   | Network/server error during auth    | Retry with backoff |

---

## Examples

- **[Website Embed](./examples/embed.html)** — Full floating chat widget with HTML/CSS/JS
- More examples coming: React component, Vue plugin, React Native

---

## Build from Source

```bash
cd src/sdk
npm install
npm run build
```

Output:
```
dist/
├── esm/          # ES Module build
├── cjs/          # CommonJS build
├── types/        # TypeScript declarations
└── umd/          # Browser bundle
    ├── receptionist-sdk.js
    └── receptionist-sdk.min.js
```

---

## License

Private — Internal use only.
