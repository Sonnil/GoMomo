# GoMomo AI Receptionist — Structured Error Handling: Peer Review Package

**Project:** GoMomo AI Receptionist (`Sonnil/GoMomo`)  
**Branch:** `main` (HEAD: `d7e0997`)  
**Uncommitted changeset:** 3 modified files + 1 new test file  
**Date:** 2025-02-18  
**Test suite:** 54 files, 1,156 tests — **all passing**

---

## 1. Problem Statement

When the `confirm_booking` tool call failed at runtime (expired hold, slot conflict, DB outage), the catch block in `tool-executor.ts` returned a single generic string:

```
"An internal error occurred. Please try again."
```

This caused **four downstream failures:**

| # | Root Cause | Impact |
|---|-----------|--------|
| 1 | Generic catch block swallowed all error types | LLM couldn't distinguish recoverable vs. fatal errors, always said "technical issue" |
| 2 | No structured error codes | LLM had no instruction set for how to react to specific failure types |
| 3 | No observability | Production errors logged as `console.error(error)` — no correlation ID, no tenant, no redacted PII |
| 4 | `resolvedDatetime` silently dropped | DateTime resolved by FSM router was passed to `ChatHandlerOptions` but the interface had no field for it — TypeScript accepted it via `any` spread but it was never injected into the conversation |

---

## 2. Files Changed

| File | Status | Lines Changed | Purpose |
|------|--------|--------------|---------|
| `src/agent/tool-executor.ts` | Modified | +52 / −4 | Rewrote catch block; added `classifyToolError()` |
| `src/agent/system-prompt.ts` | Modified | +10 / −25 | Replaced generic rule 4 with error-code-specific LLM instructions |
| `src/agent/chat-handler.ts` | Modified | +12 / −25 | Added `resolvedDatetime` to `ChatHandlerOptions`; rewrote injection logic |
| `tests/error-mapping.test.ts` | **New** | +395 | 9 tests covering all error paths, logging, prompt, and types |

---

## 3. Change Details

### 3.1 `tool-executor.ts` — Catch Block Rewrite

**Before (lines 62–66):**
```typescript
} catch (error: any) {
    if (error instanceof SlotConflictError || error instanceof BookingError) {
        return { success: false, error: error.message };
    }
    console.error(`Tool execution error (${toolName}):`, error);
    return { success: false, error: 'An internal error occurred. Please try again.' };
}
```

**After (lines 62–95):**
```typescript
} catch (error: any) {
    // ── Structured error logging (safe for prod) ────────────
    const correlationId = randomUUID().slice(0, 8);
    const emailRaw: string = args?.client_email ?? '';
    const emailHash = emailRaw
      ? createHash('sha256').update(emailRaw.toLowerCase()).digest('hex').slice(0, 12)
      : 'n/a';
    const errorCode = classifyToolError(error);
    const errorMsg = error instanceof Error ? error.message : String(error);

    console.error(
      `[tool-error] ref=${correlationId} tool=${toolName} tenant=${tenantId} ` +
      `session=${sessionId} email_hash=${emailHash} code=${errorCode} msg=${errorMsg}`,
    );

    // ── Known domain errors → actionable user-facing messages ──
    if (error instanceof BookingError) {
      return { success: false, error: `BOOKING_ERROR: ${error.message}` };
    }
    if (error instanceof SlotConflictError) {
      return {
        success: false,
        error: 'SLOT_CONFLICT: That time slot is no longer available — ...',
      };
    }

    // ── Unknown/system errors → generic message WITH reference id ──
    return {
      success: false,
      error: `INTERNAL_ERROR: Something went wrong while processing this request. ` +
        `Please ask the customer to try again. If the issue persists, reference ID: ${correlationId}`,
    };
}
```

**New helper — `classifyToolError()` (lines 100–115):**
```typescript
function classifyToolError(error: unknown): string {
  if (error instanceof BookingError) return 'BOOKING_ERROR';
  if (error instanceof SlotConflictError) return 'SLOT_CONFLICT';
  if (error instanceof CalendarReadError) return 'CALENDAR_READ_ERROR';
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('calendar') || msg.includes('Calendar')) return 'CALENDAR_WRITE_ERROR';
    if (msg.includes('23P01')) return 'DB_EXCLUSION_CONFLICT';
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'TIMEOUT';
    if (msg.includes('connect') || msg.includes('ECONNREFUSED')) return 'CONNECTION_ERROR';
  }
  return 'UNKNOWN';
}
```

**Design notes:**
- `classifyToolError()` is for **structured logs only** — it does NOT appear in user-facing messages
- The user-facing catch block has exactly 3 branches: `BookingError`, `SlotConflictError`, and fallback `INTERNAL_ERROR`
- The `correlationId` appears in **both** the log line and the user-facing message, enabling support lookup
- Email is hashed (SHA-256, first 12 hex chars) — raw email never appears in logs

### 3.2 `system-prompt.ts` — Error-Aware LLM Instructions

**Before (rule 4):**
```
4. If a tool call fails, inform the user honestly and suggest alternatives
```

**After (rule 4, lines 178–189):**
```
4. When a tool call fails, use the ERROR CODE prefix to decide your response:
   - BOOKING_ERROR: Relay the specific message to the customer
   - SLOT_CONFLICT: Apologise and call check_availability for alternatives
   - PHONE_REQUIRED / INVALID_PHONE: Ask for a valid phone number
   - EMAIL_VERIFICATION_REQUIRED / EMAIL_MISMATCH: Guide through email verification
   - RISK_REVERIFY: Prompt re-verification
   - RISK_COOLDOWN: Inform politely when they can try again
   - INTERNAL_ERROR: Apologise, share reference ID, never expose raw details
   - SERVICE_REQUIRED / DATE_RANGE_TOO_WIDE: Relay guidance from error message
   NEVER say "a technical issue occurred" for errors that have a specific,
   actionable code. Only use that phrasing for INTERNAL_ERROR
```

This gives the LLM an explicit decision tree: parse the prefix → take the corresponding action. No more guesswork.

### 3.3 `chat-handler.ts` — `resolvedDatetime` Fix

**Problem:** The FSM router in `chat-router.ts` resolved datetime expressions (e.g. "today at 3pm" → `2025-02-18T15:00:00-05:00`) and passed the result as `resolvedDatetime` in the options object. But `ChatHandlerOptions` had no such field — the value was silently dropped.

**Fix:**
1. Added `resolvedDatetime?: DatetimeResolverResult | null` to the `ChatHandlerOptions` interface (line 59)
2. Added injection logic at step 3a (lines 126–135) that pushes a system message:
   ```
   RESOLVED DATE/TIME: The user mentioned a date/time.
   Resolved to: start=2025-02-18T15:00:00-05:00 (confidence: high).
   Use these exact ISO timestamps when calling check_availability or hold_slot.
   Do NOT re-ask the customer for the date/time.
   ```
3. Removed the now-redundant `clientMeta` field (datetime resolution moved to the FSM router layer)

### 3.4 `tests/error-mapping.test.ts` — New Test File (9 tests)

| # | Test | Validates |
|---|------|-----------|
| 1 | BookingError → `BOOKING_ERROR:` prefix | Error message is forwarded with actionable prefix |
| 2 | SlotConflictError → `SLOT_CONFLICT:` prefix | Includes rebooking guidance; mentions `check_availability` |
| 3 | Unknown error → `INTERNAL_ERROR:` + ref ID | Reference ID is 8-char hex; raw error (ECONNREFUSED) is NOT exposed |
| 4 | Structured log format | `[tool-error]` line contains: ref, tool, tenant, session, email_hash, code |
| 5 | Email hash logged, raw email NOT | Confirms `jane@example.com` absent from log line |
| 6 | Structured log for unknown error | Same format for non-domain errors |
| 7 | System prompt contains all 11 error codes | Iterates expected codes, asserts each present in prompt |
| 8 | Old generic instruction removed | Asserts `inform the user honestly and suggest alternatives` is gone |
| 9 | `resolvedDatetime` type check | Imports `handleChatMessage` and `resolveDatetime` — verifies interface accepts the field |

---

## 4. Error Code Taxonomy

### 4.1 User-Facing Prefixes (appear in `ToolResult.error`)

These are the prefixes the LLM sees when a tool call returns `{ success: false }`:

| Prefix | Source | Example Scenario |
|--------|--------|-----------------|
| `BOOKING_ERROR:` | `BookingError` thrown by `booking.service.ts` | Expired hold, session mismatch |
| `SLOT_CONFLICT:` | `SlotConflictError` thrown by `availability.service.ts` | Double-booking (23P01 exclusion) |
| `INTERNAL_ERROR:` | Catch-all for unrecognized errors | DB outage, timeout, unknown crash |
| `RISK_COOLDOWN:` | Early return in `handleConfirmBooking` | Behavioral risk engine detects abuse |
| `RISK_REVERIFY:` | Early return in `handleConfirmBooking` | Risk score requires re-verification |
| `PHONE_REQUIRED:` | Early return in `handleConfirmBooking` | Missing phone number |
| `INVALID_PHONE:` | Early return in `handleConfirmBooking` | Phone fails validation |
| `EMAIL_VERIFICATION_REQUIRED:` | Early return in `handleConfirmBooking` | Session not email-verified |
| `EMAIL_MISMATCH:` | Early return in `handleConfirmBooking` | Booking email ≠ verified email |
| `SERVICE_REQUIRED:` | Early return in `handleCheckAvailability` | No service specified |
| `DATE_RANGE_TOO_WIDE:` | Early return in `handleCheckAvailability` | Range exceeds 14-day limit |
| `FAR_DATE_CONFIRMATION_REQUIRED:` | Early return in `handleHoldSlot` | Booking >N days in future |
| `CANCELLATION_FAILED:` | Early return in `handleCancelBooking` | Cancel verification failed |
| `CANCELLATION_REQUIRES_VERIFICATION:` | Early return in `handleCancelBooking` | Missing identity info |
| `CANCELLATION_NEEDS_IDENTITY:` | Early return in `handleCancelBooking` | Need email or ref code |
| `CONFIRMATION_REQUIRED:` | Early return in `handleConfirmBooking` | Existing booking in same window |

**Total: 16 distinct error codes, no overlaps.**

### 4.2 Log-Only Classification Codes (used in `[tool-error]` line, NOT user-facing)

| Code | Trigger |
|------|---------|
| `BOOKING_ERROR` | `instanceof BookingError` |
| `SLOT_CONFLICT` | `instanceof SlotConflictError` |
| `CALENDAR_READ_ERROR` | `instanceof CalendarReadError` |
| `CALENDAR_WRITE_ERROR` | Error message contains "calendar"/"Calendar" |
| `DB_EXCLUSION_CONFLICT` | Error message contains "23P01" |
| `TIMEOUT` | Error message contains "timeout"/"ETIMEDOUT" |
| `CONNECTION_ERROR` | Error message contains "connect"/"ECONNREFUSED" |
| `UNKNOWN` | Catch-all |

---

## 5. Data Flow Traces

### 5.1 Error Prefix Survival: Tool → Router → LLM

```
tool-executor.ts:executeToolCall()
  └─ catch block returns { success: false, error: "BOOKING_ERROR: Hold has expired..." }
       │
chat-handler.ts (tool loop, line ~395-399):
  └─ const toolResult = await executeToolCall(...)
  └─ conversation.push({ role: 'tool', content: JSON.stringify(toolResult) })
       │                                    ↑ prefix survives JSON.stringify
       │
OpenAI API:
  └─ messages: [..., { role: 'tool', content: '{"success":false,"error":"BOOKING_ERROR: ..."}' }]
       │
System prompt rule 4:
  └─ LLM reads "BOOKING_ERROR:" prefix → follows instruction to relay specific message
```

**Verified:** `response-post-processor.ts` strips premature confirmations, phone-call claims, legacy brands, calendar data-URIs, and external URLs — but does NOT strip error code prefixes.

### 5.2 ResolvedDatetime: FSM Router → Chat Handler → LLM

```
chat-router.ts:routeChat()
  └─ line 97: resolvedDatetime = resolveDatetime({ userMessage, clientMeta, ... })
  └─ line 131: ActionContext.resolvedDatetime = resolvedDatetime
  └─ line 380 (PASS_TO_LLM): handleChatMessage(..., { resolvedDatetime: ctx.resolvedDatetime ?? undefined })
       │
chat-handler.ts:handleChatMessage()
  └─ line 59: ChatHandlerOptions.resolvedDatetime?: DatetimeResolverResult | null
  └─ line 126-135: if (options.resolvedDatetime) → push system message
       │
OpenAI API:
  └─ messages: [..., { role: 'system', content: 'RESOLVED DATE/TIME: start=2025-02-18T15:00:00...' }]
```

### 5.3 Correlation ID: Log ↔ User Message

```
catch block (line 64):
  correlationId = randomUUID().slice(0, 8)   // e.g. "a1b2c3d4"
       │
Line 72 (structured log):
  console.error("[tool-error] ref=a1b2c3d4 tool=confirm_booking tenant=... code=UNKNOWN ...")
       │
Line 92 (user-facing fallback):
  return { error: "INTERNAL_ERROR: ... reference ID: a1b2c3d4" }
       │
  ↳ Same 8-char ID in both → support can grep logs by ref ID from customer report
```

---

## 6. PII Safety Audit

| Data | In Logs? | In User-Facing Message? | Notes |
|------|----------|------------------------|-------|
| Raw email | ❌ | ⚠️ `EMAIL_MISMATCH` only | Log uses SHA-256 hash prefix (12 chars). `EMAIL_MISMATCH` returns include raw emails for user clarity — this is in the tool result, not logs. |
| Phone | ❌ | ❌ | Only appears in tool args, never logged or returned in errors |
| Customer name | ❌ | ❌ | Same as phone |
| Session ID | ✅ (structured log) | ❌ | Not PII — opaque UUID |
| Tenant ID | ✅ (structured log) | ❌ | Not PII |
| Error message | ✅ (structured log) | ❌ for `INTERNAL_ERROR` | Raw error message is logged for debugging but never exposed to user for unknown errors |

---

## 7. Validation Results

### 7.1 Five Validation Goals

| # | Goal | Result |
|---|------|--------|
| 1 | Error prefixes survive tool → router → LLM boundary | ✅ PASS — JSON.stringify preserves prefixes; post-processor doesn't strip them |
| 2 | `INTERNAL_ERROR` includes ref ID matching structured logs | ✅ PASS — same `correlationId` in both |
| 3 | `resolvedDatetime` is not silently dropped | ✅ PASS — field added to interface; injection logic confirmed |
| 4 | No raw PII (email, phone) in logs | ✅ PASS — SHA-256 hash only; advisory on EMAIL_MISMATCH |
| 5 | No generic fallback text in tool-executor | ✅ PASS — old "An internal error occurred" is gone |

### 7.2 Five Simulation Scenarios

| Scenario | Error Class | Prefix Returned | LLM Instruction |
|----------|------------|-----------------|-----------------|
| Expired hold | `BookingError` | `BOOKING_ERROR: Hold has expired...` | Relay message, offer to rebook |
| Slot conflict (double-book) | `SlotConflictError` | `SLOT_CONFLICT: That time slot is no longer available...` | Apologise, call check_availability |
| Missing phone | Early return | `PHONE_REQUIRED: ...` | Ask for valid phone number |
| Risk cooldown | Early return | `RISK_COOLDOWN: ...` | Inform when they can try again |
| DB outage | Generic `Error` | `INTERNAL_ERROR: ... reference ID: a1b2c3d4` | Apologise, share ref ID |

---

## 8. Findings & Recommendations

### F1 — Low: String-Based Calendar Heuristic in `classifyToolError`

The log classifier uses `msg.includes('calendar')` to detect calendar write errors. If an error message coincidentally contains "calendar" (e.g. "Failed to read calendar config"), it gets misclassified as `CALENDAR_WRITE_ERROR` instead of `UNKNOWN`.

**Impact:** Log-only classification; no user-facing effect.  
**Recommendation:** Consider adding a dedicated `CalendarWriteError` class for stronger typing.

### F2 — Medium: `CalendarReadError` Falls to `INTERNAL_ERROR` in User-Facing Response

The `classifyToolError()` function correctly identifies `CalendarReadError` for **logging**, but the user-facing catch block only has branches for `BookingError` and `SlotConflictError`. A `CalendarReadError` would fall through to the generic `INTERNAL_ERROR` fallback.

**Impact:** User sees "Something went wrong" instead of a calendar-specific message.  
**Recommendation:** Add an `instanceof CalendarReadError` branch between `SlotConflictError` and the fallback:
```typescript
if (error instanceof CalendarReadError) {
  return {
    success: false,
    error: 'CALENDAR_UNAVAILABLE: Unable to check the calendar right now. Please try again in a moment.',
  };
}
```

### F3 — Low: Same DB Root Cause (23P01) Produces Different Error Classes

- `holdSlot` throws `SlotConflictError` on 23P01 exclusion violation
- `confirmBooking` throws `BookingError` on 23P01 exclusion violation

Both are handled correctly in the catch block — `SlotConflictError` and `BookingError` each have their own branch. No action needed.

### F4 — Low-Medium: 5 Error Codes Not in System Prompt Rule 4

The system prompt teaches the LLM how to handle 11 error codes, but 5 exist in tool-executor that aren't listed:

| Missing Code | Where Returned |
|-------------|----------------|
| `FAR_DATE_CONFIRMATION_REQUIRED` | `handleHoldSlot` |
| `CANCELLATION_FAILED` | `handleCancelBooking` |
| `CANCELLATION_REQUIRES_VERIFICATION` | `handleCancelBooking` |
| `CANCELLATION_NEEDS_IDENTITY` | `handleCancelBooking` |
| `CONFIRMATION_REQUIRED` | `handleConfirmBooking` |

**Impact:** LLM will still see the prefix and message, but has no explicit instruction for how to handle these — it will improvise (probably correctly, but not guaranteed).  
**Recommendation:** Add these 5 codes to rule 4 in the system prompt.

### F5 — Negligible: Theoretical `instanceof` Identity Race in ESM

In ESM, if the same error class is loaded from two different module instances (e.g. due to dynamic import caching), `instanceof` could fail. This is a known Node.js edge case.

**Impact:** Near-zero in production — all imports are static.  
**Recommendation:** No action needed unless hot-reloading is introduced.

### F6 — Low: 7 Error Returns Have No Structured Prefix

Seven early-return error paths in tool-executor return plain-text messages without a code prefix (e.g. `"Please provide a start_date and end_date"`). These are validation errors with self-explanatory messages.

**Impact:** Low — the LLM can relay these directly. They don't need code-specific handling.  
**Recommendation:** No action needed.

---

## 9. Test Coverage Summary

**New tests in `tests/error-mapping.test.ts` (9 tests):**

```
✓ BookingError → BOOKING_ERROR: prefix preserving original message
✓ SlotConflictError → SLOT_CONFLICT: prefix with rebooking guidance
✓ Unknown errors → INTERNAL_ERROR: with reference ID
✓ Structured log contains ref, tool, tenant, session, email_hash, code
✓ Raw email NOT in log line (SHA-256 hash only)
✓ Structured log for unknown error
✓ System prompt contains all 11 expected error codes
✓ Old generic instruction removed from prompt
✓ ChatHandlerOptions accepts resolvedDatetime (type check)
```

**Full suite: 54 files, 1,156 tests, all passing.**

---

## 10. Diff Summary

```
Files changed:
  M src/agent/chat-handler.ts      (+12, −25)
  M src/agent/system-prompt.ts     (+10, −25)
  M src/agent/tool-executor.ts     (+52, −4)
  A tests/error-mapping.test.ts    (+395)

Total: +469 lines, −54 lines
Net: +415 lines
```

---

## 11. Questions for Reviewer

1. **F2 (CalendarReadError):** Should we add a `CALENDAR_UNAVAILABLE` user-facing branch now, or is `INTERNAL_ERROR` acceptable for this rare case?

2. **F4 (5 missing prompt codes):** Should all 5 missing codes be added to system prompt rule 4, or are the error messages self-explanatory enough for the LLM to handle without explicit instructions?

3. **Email in EMAIL_MISMATCH:** The `EMAIL_MISMATCH` error returns both the booking email and verified email in the tool result for user clarity. This is in the LLM context, not logs. Is this acceptable, or should the emails be masked?

4. **Correlation ID length:** Currently 8 hex chars from `randomUUID().slice(0, 8)`. Is this sufficient uniqueness for support lookup, or should it be longer?

5. **SLOT_CONFLICT wording:** The current message instructs the LLM to "call check_availability to see what's open." Should tool-executor proactively call it, or is instructing the LLM to do so the right pattern?
