/**
 * SMS Handoff Token — Short-lived, one-time-use tokens for voice→web handoff
 *
 * When a caller struggles on the phone (complex spelling, long email, etc.)
 * or explicitly requests it, we generate a token encoding partial session
 * context and send it via SMS as a web chat link.
 *
 * SECURITY DESIGN:
 * - HMAC-SHA256 signed to prevent tampering
 * - TTL: 15 minutes (configurable) — short window
 * - One-time use: consumed on first redemption, then deleted
 * - PII minimization: stores only intent + partial fields, NOT email/name
 *   unless the caller already provided them (they're the data subject)
 * - In-memory store (no DB needed) — tokens are ephemeral by design
 * - Token payload is NOT embedded in URL — token is an opaque key that
 *   resolves to server-side context (avoids URL-based data leakage)
 */

import crypto from 'node:crypto';
import { env } from '../config/env.js';
import type { VoiceSession, VoiceIntent } from '../domain/types.js';

// ── Types ───────────────────────────────────────────────────────

export interface HandoffTokenPayload {
  /** Opaque token ID (URL-safe) */
  token: string;
  /** Tenant this handoff belongs to */
  tenantId: string;
  /** Original voice CallSid for audit trail */
  callSid: string;
  /** Voice session ID (maps to chat_sessions.id) */
  sessionId: string;
  /** What the caller was trying to do */
  intent: VoiceIntent;
  /** Voice state at time of handoff */
  voiceState: string;
  /** Partial booking fields collected so far */
  partial: {
    service: string | null;
    date: string | null;
    selectedSlot: { start: string; end: string } | null;
    holdId: string | null;
    clientName: string | null;
    clientEmail: string | null;
    referenceCode: string | null;
    appointmentId: string | null;
  };
  /** When this token was created */
  createdAt: number;
  /** When this token expires */
  expiresAt: number;
  /** Whether this token has been consumed */
  consumed: boolean;
}

// ── Token Store ─────────────────────────────────────────────────

const tokenStore = new Map<string, HandoffTokenPayload>();

// Periodic cleanup of expired tokens (every 60s)
const CLEANUP_INTERVAL = 60_000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, t] of tokenStore) {
      if (t.expiresAt < now) {
        tokenStore.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);
  // Don't hold the process open for cleanup
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function getSigningKey(): string {
  // ENCRYPTION_KEY is validated at startup — always available
  if (!env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is not configured — cannot sign handoff tokens');
  }
  return env.ENCRYPTION_KEY;
}

function generateTokenId(): string {
  return crypto.randomBytes(24).toString('base64url'); // 32 chars, URL-safe
}

function signToken(tokenId: string): string {
  return crypto
    .createHmac('sha256', getSigningKey())
    .update(tokenId)
    .digest('base64url');
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Create a handoff token from the current voice session state.
 * Returns the token string to include in the SMS link.
 */
export function createHandoffToken(session: VoiceSession): string {
  startCleanup();

  const tokenId = generateTokenId();
  const signature = signToken(tokenId);
  const token = `${tokenId}.${signature}`;

  const ttlMs = (env.SMS_HANDOFF_TOKEN_TTL_MINUTES ?? 15) * 60_000;

  const payload: HandoffTokenPayload = {
    token,
    tenantId: session.tenantId,
    callSid: session.callSid,
    sessionId: session.sessionId,
    intent: session.intent,
    voiceState: session.state,
    partial: {
      service: session.service,
      date: session.date,
      selectedSlot: session.selectedSlot,
      holdId: session.holdId,
      clientName: session.clientName,
      clientEmail: session.clientEmail,
      referenceCode: session.referenceCode,
      appointmentId: session.appointmentId,
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    consumed: false,
  };

  tokenStore.set(tokenId, payload);
  return token;
}

/**
 * Validate and consume a handoff token. Returns the payload if valid,
 * or null if invalid/expired/already-consumed.
 *
 * One-time use: after this call, the token cannot be used again.
 */
export function consumeHandoffToken(token: string): HandoffTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [tokenId, providedSig] = parts;

  // Verify HMAC signature
  const expectedSig = signToken(tokenId);
  if (providedSig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))) {
    return null;
  }

  const payload = tokenStore.get(tokenId);
  if (!payload) return null;

  // Check expiration
  if (Date.now() > payload.expiresAt) {
    tokenStore.delete(tokenId);
    return null;
  }

  // Check one-time use
  if (payload.consumed) return null;

  // Mark as consumed and schedule deletion
  payload.consumed = true;
  setTimeout(() => tokenStore.delete(tokenId), 60_000); // Keep for 1 min after consumption

  return payload;
}

/**
 * Peek at a token without consuming it (for debug/status checks).
 */
export function peekHandoffToken(token: string): HandoffTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [tokenId] = parts;
  const payload = tokenStore.get(tokenId);
  if (!payload || Date.now() > payload.expiresAt) return null;
  return payload;
}

/**
 * Get stats about the token store (for debug endpoint).
 */
export function getTokenStoreStats(): { active: number; consumed: number; total: number } {
  let active = 0;
  let consumed = 0;
  const now = Date.now();
  for (const t of tokenStore.values()) {
    if (t.expiresAt < now) continue;
    if (t.consumed) consumed++;
    else active++;
  }
  return { active, consumed, total: tokenStore.size };
}

/**
 * Clear all tokens (for testing).
 */
export function clearAllTokens(): void {
  tokenStore.clear();
}
