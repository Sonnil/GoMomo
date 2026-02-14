// ============================================================
// Auth Middleware — Fastify preHandler + Socket.IO middleware
//
// Three auth strategies:
//   1. Session Token  — for customer-facing routes (chat, booking, availability)
//   2. Admin API Key  — for operator routes (tenant CRUD, customer mgmt, autonomy)
//   3. Session OR Admin — routes that can be accessed by either
//
// Every route MUST be explicitly tagged:
//   - preHandler: [requireSessionToken]      — customer
//   - preHandler: [requireAdminKey]           — operator
//   - preHandler: [requireSessionOrAdmin]     — dual-access
//   - config: { authPublic: true }            — public (no auth)
//
// When SDK_AUTH_REQUIRED=false (dev mode), all guards pass through.
// When SDK_AUTH_REQUIRED=true (pilot/prod), unauthenticated = 401.
//
// Default-deny: index.ts registers an onRoute hook that rejects
// any route without an explicit auth tag.
// ============================================================

import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual, createHmac } from 'crypto';
import { verifySessionToken, extractToken, type SessionTokenPayload } from './session-token.js';
import { env } from '../config/env.js';

// ── Decoration key — tracks that a route has been auth-tagged ──
export const AUTH_TAG_KEY = '__authTagged';

/** Check whether SDK auth enforcement is turned on. */
export function isAuthEnforced(): boolean {
  return (env as any).SDK_AUTH_REQUIRED === 'true';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. SESSION TOKEN — customer-facing routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Fastify preHandler — validates session token on REST routes.
 *
 * Attaches `request.sessionToken` on success.
 * When auth is NOT enforced, always passes through.
 */
export async function requireSessionToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Tag this route as auth-handled
  (request as any)[AUTH_TAG_KEY] = true;

  // If auth not enforced, skip entirely (backwards compat)
  if (!isAuthEnforced()) return;

  const raw = extractToken(
    request.headers.authorization,
    (request.query as any)?.token,
  );

  if (!raw) {
    reply.code(401).send({ error: 'Missing session token. Use POST /api/auth/session to obtain one.' });
    return;
  }

  const payload = verifySessionToken(raw);
  if (!payload) {
    reply.code(401).send({ error: 'Invalid or expired session token.' });
    return;
  }

  // Attach to request for downstream use
  (request as any).sessionToken = payload;
}

/**
 * Require a session token AND verify it belongs to the :tenantId in the route.
 * Use on all tenant-scoped customer-facing routes.
 */
export async function requireSessionTokenTenantScoped(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Tag this route as auth-handled
  (request as any)[AUTH_TAG_KEY] = true;

  if (!isAuthEnforced()) return;

  const raw = extractToken(
    request.headers.authorization,
    (request.query as any)?.token,
  );

  if (!raw) {
    reply.code(401).send({ error: 'Missing session token. Use POST /api/auth/session to obtain one.' });
    return;
  }

  const payload = verifySessionToken(raw);
  if (!payload) {
    reply.code(401).send({ error: 'Invalid or expired session token.' });
    return;
  }

  // Enforce tenant scope
  const tenantId = (request.params as any)?.tenantId ?? (request.params as any)?.id;
  if (tenantId && payload.tid !== tenantId) {
    reply.code(403).send({ error: 'Token does not belong to this tenant.' });
    return;
  }

  (request as any).sessionToken = payload;
}

/**
 * Optional Fastify preHandler — validates token if present,
 * but does NOT reject missing tokens. Useful for routes that
 * should work with or without auth.
 */
export async function optionalSessionToken(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  (request as any)[AUTH_TAG_KEY] = true;

  const raw = extractToken(
    request.headers.authorization,
    (request.query as any)?.token,
  );
  if (!raw) return;

  const payload = verifySessionToken(raw);
  if (payload) {
    (request as any).sessionToken = payload;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. ADMIN API KEY — operator/backend routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Extract admin key from request.
 * Supported formats:
 *   - Authorization: Bearer admin.<key>
 *   - X-Admin-Key: <key>
 */
function extractAdminKey(request: FastifyRequest): string | null {
  // Check X-Admin-Key header first
  const headerKey = request.headers['x-admin-key'];
  if (typeof headerKey === 'string' && headerKey.length > 0) {
    return headerKey;
  }

  // Check Authorization: Bearer admin.<key>
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer admin.')) {
    return auth.slice('Bearer admin.'.length);
  }

  return null;
}

/**
 * Timing-safe comparison for admin key.
 */
function verifyAdminKey(provided: string): boolean {
  const expected = (env as any).ADMIN_API_KEY;
  if (!expected || expected.length === 0) return false;

  // Pad to same length for timing-safe comparison
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still do a comparison to avoid timing leak on length
    const padded = Buffer.alloc(b.length);
    a.copy(padded, 0, 0, Math.min(a.length, b.length));
    timingSafeEqual(padded, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Fastify preHandler — requires a valid admin API key.
 * When auth is NOT enforced, passes through.
 */
export async function requireAdminKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  (request as any)[AUTH_TAG_KEY] = true;

  if (!isAuthEnforced()) return;

  const key = extractAdminKey(request);
  if (!key) {
    reply.code(401).send({ error: 'Admin API key required. Pass via X-Admin-Key header or Authorization: Bearer admin.<key>' });
    return;
  }

  if (!verifyAdminKey(key)) {
    reply.code(403).send({ error: 'Invalid admin API key.' });
    return;
  }

  (request as any).isAdmin = true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. SESSION OR ADMIN — dual-access routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Accept either a valid session token (tenant-scoped) or an admin key.
 * Useful for routes like push-events (customer polls) or appointment lookup
 * that may be accessed by either customers or operators.
 */
export async function requireSessionOrAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  (request as any)[AUTH_TAG_KEY] = true;

  if (!isAuthEnforced()) return;

  // Try admin key first
  const adminKey = extractAdminKey(request);
  if (adminKey && verifyAdminKey(adminKey)) {
    (request as any).isAdmin = true;
    return;
  }

  // Try session token
  const raw = extractToken(
    request.headers.authorization,
    (request.query as any)?.token,
  );

  if (!raw) {
    reply.code(401).send({ error: 'Authentication required. Provide a session token or admin API key.' });
    return;
  }

  const payload = verifySessionToken(raw);
  if (!payload) {
    reply.code(401).send({ error: 'Invalid or expired token.' });
    return;
  }

  // Enforce tenant scope if route has tenantId param
  const tenantId = (request.params as any)?.tenantId ?? (request.params as any)?.id;
  if (tenantId && payload.tid !== tenantId) {
    reply.code(403).send({ error: 'Token does not belong to this tenant.' });
    return;
  }

  (request as any).sessionToken = payload;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. PUBLIC — explicitly mark routes as needing no auth
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * PreHandler that simply tags the route as "auth checked" so the
 * default-deny hook does not reject it.  No actual validation.
 * Used for: /health, /api/config, /api/auth/session, /api/auth/refresh,
 *           /api/oauth/google/callback, /twilio/sms/incoming
 */
export async function markPublic(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  (request as any)[AUTH_TAG_KEY] = true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Socket.IO helpers (unchanged)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Validate a token string for WebSocket join.
 * Returns the payload or null.
 */
export function validateSocketToken(token: string | undefined): SessionTokenPayload | null {
  if (!token) return null;
  return verifySessionToken(token);
}

/**
 * Check that a token's tenant matches the requested tenant.
 */
export function tokenMatchesTenant(
  payload: SessionTokenPayload | null | undefined,
  tenantId: string,
): boolean {
  if (!payload) return !isAuthEnforced(); // if auth not enforced, always ok
  return payload.tid === tenantId;
}
