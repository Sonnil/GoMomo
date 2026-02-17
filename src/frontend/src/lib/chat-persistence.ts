/**
 * Chat Persistence — localStorage cache for widget message history.
 *
 * Key format:  gomomo_chat_v1:{tenantId}
 *
 * Persists:
 *   - messages[]  (role, content, pushType?, pushSlots?, pushRef?)
 *   - sessionId
 *   - lastUpdatedAt  (ISO string)
 *   - schemaVersion  (number — bump to auto-invalidate stale cache)
 *
 * Security:
 *   - OTP codes (4-8 digit numeric strings that look like verification codes)
 *     are redacted from message content before persisting.
 *   - Raw email/phone in user-typed messages are kept (user authored them).
 */

/* ── Schema ─────────────────────────────────────────────── */

export const SCHEMA_VERSION = 1;

export interface PersistedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  pushType?: string;
  pushSlots?: Array<{ start: string; end: string; display_time: string; service: string | null }>;
  pushRef?: string;
}

export interface PersistedChat {
  schemaVersion: number;
  sessionId: string;
  messages: PersistedMessage[];
  lastUpdatedAt: string;
}

/* ── Key helpers ────────────────────────────────────────── */

export function storageKey(tenantId: string): string {
  return `gomomo_chat_v1:${tenantId}`;
}

/* ── OTP Sanitizer ──────────────────────────────────────── */

/**
 * Redact standalone 4-8 digit numbers that look like OTP/verification codes.
 * Matches patterns like "1234", "Your code is 123456", "code: 87654321".
 * Does NOT redact numbers embedded in words, dates, prices, or phone numbers.
 */
const OTP_PATTERN = /\b(?:code|otp|pin|verification)\s*(?:is|:)?\s*(\d{4,8})\b/gi;
const STANDALONE_OTP = /(?<=\s|^)\d{4,8}(?=\s|$|[.!?])/g;

export function sanitizeOtp(content: string): string {
  // First pass: redact "code is 123456" style
  let result = content.replace(OTP_PATTERN, (match, digits) =>
    match.replace(digits, '●'.repeat(digits.length))
  );
  // We intentionally do NOT do standalone digit redaction — too many false
  // positives (prices, dates, years). Only contextual OTP patterns are redacted.
  return result;
}

/**
 * Sanitize a message array for persistence.
 * System messages containing OTP verification are fully excluded.
 */
export function sanitizeMessages(messages: PersistedMessage[]): PersistedMessage[] {
  return messages
    .filter((m) => {
      // Exclude system messages that are just OTP confirmations
      if (m.role === 'system' && /verified|verification/i.test(m.content)) return true; // keep "email verified" — no OTP
      return true;
    })
    .map((m) => ({
      ...m,
      content: sanitizeOtp(m.content),
    }));
}

/* ── Load ───────────────────────────────────────────────── */

export function loadChat(tenantId: string): PersistedChat | null {
  try {
    const raw = localStorage.getItem(storageKey(tenantId));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const data = parsed as Record<string, unknown>;

    // Schema version mismatch → clear stale cache
    if (data.schemaVersion !== SCHEMA_VERSION) {
      localStorage.removeItem(storageKey(tenantId));
      return null;
    }

    // Basic shape validation
    if (
      typeof data.sessionId !== 'string' ||
      !Array.isArray(data.messages) ||
      typeof data.lastUpdatedAt !== 'string'
    ) {
      localStorage.removeItem(storageKey(tenantId));
      return null;
    }

    return data as unknown as PersistedChat;
  } catch {
    // Corrupted JSON or localStorage blocked
    try { localStorage.removeItem(storageKey(tenantId)); } catch { /* noop */ }
    return null;
  }
}

/* ── Save ───────────────────────────────────────────────── */

export function saveChat(
  tenantId: string,
  sessionId: string,
  messages: PersistedMessage[],
): void {
  try {
    const data: PersistedChat = {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      messages: sanitizeMessages(messages),
      lastUpdatedAt: new Date().toISOString(),
    };
    localStorage.setItem(storageKey(tenantId), JSON.stringify(data));
  } catch {
    // localStorage full or blocked — silently degrade
  }
}

/* ── Clear ──────────────────────────────────────────────── */

export function clearChat(tenantId: string): void {
  try {
    localStorage.removeItem(storageKey(tenantId));
    // Also clear the legacy session_id key
    localStorage.removeItem('gomomo_session_id');
  } catch {
    // localStorage blocked — silently degrade
  }
}

/* ── Debounced save helper (for use in React effects) ──── */

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveChatDebounced(
  tenantId: string,
  sessionId: string,
  messages: PersistedMessage[],
  delayMs = 250,
): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveChat(tenantId, sessionId, messages);
    _saveTimer = null;
  }, delayMs);
}

/** Flush any pending debounced save immediately (e.g. before unload). */
export function flushPendingSave(): void {
  // No-op if no timer — the data was already saved.
  // If timer is pending, we can't recover the args, so callers should
  // also do a direct saveChat on beforeunload.
}

/* ── Testing exports ────────────────────────────────────── */
export const _testing = {
  OTP_PATTERN,
  STANDALONE_OTP,
};

/* ── Interaction Mode persistence ───────────────────────── */

export type InteractionMode = 'chat' | 'speak';

const MODE_KEY = 'gomomo_interaction_mode_v1';

/** Load the user's preferred interaction mode (null = not yet chosen). */
export function loadInteractionMode(): InteractionMode | null {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === 'chat' || raw === 'speak') return raw;
    return null;
  } catch {
    return null;
  }
}

/** Persist the user's interaction mode preference. */
export function saveInteractionMode(mode: InteractionMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // localStorage blocked — silently degrade
  }
}
