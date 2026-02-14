// ============================================================
// Session Token — HMAC-SHA256 signed short-lived tokens
//
// Token format: base64url({ tenantId, sessionId, customerId?, iat, exp }) + "." + signature
//
// Design:
//   - No database state — token is self-contained (like a mini-JWT)
//   - Short-lived (default 4 hours) — long enough for a chat session
//   - Signed with SESSION_TOKEN_SECRET (required in non-dev mode)
//   - In dev/test: falls back to ENCRYPTION_KEY for backwards compatibility
//   - Tenant-scoped: token is only valid for the tenant it was issued for
//   - No full user accounts needed — just proves "someone started a valid session with this tenant"
// ============================================================

import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env.js';

/** Token payload (the cleartext portion). */
export interface SessionTokenPayload {
  /** Tenant this token is scoped to. */
  tid: string;
  /** Chat session ID. */
  sid: string;
  /** Optional customer ID (if identity was resolved). */
  cid?: string;
  /** Issued-at (unix epoch seconds). */
  iat: number;
  /** Expiry (unix epoch seconds). */
  exp: number;
}

const DEFAULT_TTL_SECONDS = 4 * 60 * 60; // 4 hours

function getSecret(): string {
  // In dev/test, fall back to ENCRYPTION_KEY for convenience
  const secret = env.SESSION_TOKEN_SECRET || env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('SESSION_TOKEN_SECRET is not configured — cannot sign tokens');
  }
  return secret;
}

/** Base64url encode (no padding). */
function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Base64url decode. */
function b64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/**
 * Sign a payload and return a compact token string.
 */
export function issueSessionToken(
  tenantId: string,
  sessionId: string,
  options?: { customerId?: string; ttlSeconds?: number },
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionTokenPayload = {
    tid: tenantId,
    sid: sessionId,
    iat: now,
    exp: now + (options?.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  if (options?.customerId) payload.cid = options.customerId;

  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest();
  const sigB64 = b64url(sig);

  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a token and return the decoded payload.
 * Returns null if the token is invalid, expired, or tampered.
 */
export function verifySessionToken(token: string): SessionTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, sigB64] = parts;

  // Recompute signature
  const expectedSig = createHmac('sha256', getSecret()).update(payloadB64).digest();
  const actualSig = b64urlDecode(sigB64);

  // Timing-safe comparison
  if (expectedSig.length !== actualSig.length) return null;
  if (!timingSafeEqual(expectedSig, actualSig)) return null;

  // Decode payload
  try {
    const payload: SessionTokenPayload = JSON.parse(
      b64urlDecode(payloadB64).toString('utf8'),
    );

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    // Basic shape check
    if (!payload.tid || !payload.sid) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract token from an Authorization header ("Bearer <token>")
 * or from a query parameter.
 */
export function extractToken(
  authHeader?: string,
  queryToken?: string,
): string | null {
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return queryToken ?? null;
}
