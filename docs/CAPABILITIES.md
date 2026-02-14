# Capability-Based Configuration Model

> Phase 1D — introduced alongside the existing feature-flag environment
> variables.  **Non-breaking**: no new env vars, no behaviour changes.

## Overview

The capability model provides a **single, canonical source of truth** for which
features are active in a running instance.  It replaces scattered
`if (env.FEATURE_XYZ === 'true')` checks with a clean boolean object that
can be consumed by:

| Consumer              | How                                    |
|-----------------------|----------------------------------------|
| Backend code          | `import { capabilities } from './config/capabilities.js'` |
| Health endpoint       | `GET /health` → `capabilities` field   |
| Frontend / SDK        | `GET /api/capabilities`                |
| Frontend React hook   | `useCapabilities()` hook               |

---

## Capability Shape

```ts
interface AppCapabilities {
  chat:      boolean;  // always true — core feature
  booking:   boolean;  // FEATURE_CALENDAR_BOOKING
  calendar:  boolean;  // FEATURE_CALENDAR_BOOKING (alias)
  sms:       boolean;  // FEATURE_SMS
  voice:     boolean;  // FEATURE_VOICE && VOICE_ENABLED
  emailGate: boolean;  // REQUIRE_EMAIL_AFTER_FIRST_MESSAGE
  excel:     boolean;  // EXCEL_ENABLED
  autonomy:  boolean;  // AUTONOMY_ENABLED
}
```

### Environment-Flag → Capability Mapping

| Capability   | Env var(s)                                   | Default |
|-------------|----------------------------------------------|---------|
| `chat`      | *(always true)*                              | `true`  |
| `booking`   | `FEATURE_CALENDAR_BOOKING`                   | `true`  |
| `calendar`  | `FEATURE_CALENDAR_BOOKING`                   | `true`  |
| `sms`       | `FEATURE_SMS`                                | `true`  |
| `voice`     | `FEATURE_VOICE` **and** `VOICE_ENABLED`      | `true`  |
| `emailGate` | `REQUIRE_EMAIL_AFTER_FIRST_MESSAGE`          | `true`  |
| `excel`     | `EXCEL_ENABLED`                              | `false` |
| `autonomy`  | `AUTONOMY_ENABLED`                           | `false` |

> Both `booking` and `calendar` derive from the same flag on purpose —
> they represent the same module today but allow the roadmap to split
> them later without changing the interface.

---

## Backend Usage

### Singleton (hot path)

```ts
import { capabilities } from './config/capabilities.js';

if (capabilities.sms) {
  // register SMS routes
}
```

The singleton is `Object.freeze()`-ed at import time and cannot be
mutated at runtime.

### Snapshot (serialization)

```ts
import { capabilitiesSnapshot } from './config/capabilities.js';

reply.send(capabilitiesSnapshot());   // safe plain copy
```

### Pure derivation (tests)

```ts
import { deriveCapabilities } from './config/capabilities.js';

const caps = deriveCapabilities({
  FEATURE_SMS: 'false',
  FEATURE_VOICE: 'true',
  VOICE_ENABLED: 'false',
  // …remaining fields
});
expect(caps.sms).toBe(false);
expect(caps.voice).toBe(false);
```

---

## API Endpoints

### `GET /health`

Returns the existing `{ status, timestamp }` payload **plus** a new
`capabilities` field:

```json
{
  "status": "ok",
  "timestamp": "2025-06-01T12:00:00.000Z",
  "capabilities": {
    "chat": true,
    "booking": true,
    "calendar": true,
    "sms": false,
    "voice": false,
    "emailGate": true,
    "excel": false,
    "autonomy": false
  }
}
```

### `GET /api/capabilities`

Dedicated endpoint returning only the capabilities object — intended
for frontend / SDK consumption:

```json
{
  "chat": true,
  "booking": true,
  "calendar": true,
  "sms": false,
  "voice": false,
  "emailGate": true,
  "excel": false,
  "autonomy": false
}
```

---

## Frontend Hook

```tsx
import { useCapabilities } from './hooks/useCapabilities';

function App() {
  const { capabilities, loading, error } = useCapabilities();

  if (loading) return <Spinner />;

  return (
    <>
      {capabilities?.booking && <BookingPanel />}
      {capabilities?.sms && <SmsPanel />}
    </>
  );
}
```

The hook fetches once and caches at module scope — subsequent mounts
return the cached value without a network request.

---

## How It Maps to Future Modules

The capability model is intentionally **additive**.  As new modules land
(e.g. `payments`, `analytics`, `multiTenant`), the process is:

1. Add the boolean to `AppCapabilities`.
2. Add a new env var (or reuse an existing one) in `env.ts`.
3. Map it in `deriveCapabilities()`.
4. Frontend automatically receives it via `GET /api/capabilities`.

No changes to the API shape, health endpoint, or hook are required —
the object simply gains a new key.

---

## Design Decisions

| Decision                         | Rationale                                                          |
|----------------------------------|--------------------------------------------------------------------|
| Derive from env, don't duplicate | Single source of truth; no config drift                            |
| `Object.freeze()` singleton      | Prevents accidental mutation in hot paths                          |
| Separate `capabilitiesSnapshot()`| Avoids serializing a frozen object (safe for `JSON.stringify`)     |
| `booking` + `calendar` alias     | Future-proof split without breaking consumers                      |
| Non-breaking introduction        | Existing `if (env.FEATURE_*)` code continues to work unchanged     |
| Module-level cache in hook       | One fetch per page load; no context provider boilerplate required  |

---

## Email Delivery (OTP Verification Codes)

The email gate sends a 6-digit OTP code to the user's email address
before allowing further chat messages.  Email delivery is handled by a
pluggable transport abstraction in `src/backend/src/email/transport.ts`.

### Environment Variables

| Variable             | Required                | Default             | Description                                              |
|----------------------|-------------------------|---------------------|----------------------------------------------------------|
| `EMAIL_PROVIDER`     | No                      | `console`           | `resend`, `postmark`, or `console`                       |
| `EMAIL_FROM`         | No                      | `Gomomo.ai <aireceptionistt@gmail.com>` | Sender address (must be verified with your provider)     |
| `EMAIL_REPLY_TO`     | No                      | *(empty)*           | Reply-to address (falls back to `EMAIL_FROM`)            |
| `RESEND_API_KEY`     | When provider=resend    | *(empty)*           | Resend API key                                           |
| `POSTMARK_API_TOKEN` | When provider=postmark  | *(empty)*           | Postmark server API token                                |
| `EMAIL_DEV_MODE`     | No                      | `true`              | When `true`: forces console provider (no real delivery)  |

### Provider Behaviour

| Provider   | SDK / Method                 | Notes                                      |
|------------|------------------------------|--------------------------------------------|
| `resend`   | `resend` npm package         | Recommended for production                 |
| `postmark` | REST API (`fetch`)           | No extra dependency — uses native `fetch`  |
| `console`  | `console.log`                | Dev / CI — logs subject + body to stdout   |

### Production Checklist

1. Set `EMAIL_DEV_MODE=false`
2. Set `EMAIL_PROVIDER=resend` (or `postmark`)
3. Set the corresponding API key (`RESEND_API_KEY` or `POSTMARK_API_TOKEN`)
4. Verify `EMAIL_FROM` domain with the provider (SPF/DKIM)
5. The endpoint returns `502` if email delivery fails — the frontend
   shows a "try again" message
