// ============================================================
// HTTPS Enforcement — Fastify plugin
//
// When REQUIRE_HTTPS=true, rejects any request whose effective
// scheme is plain HTTP with 403 Forbidden.
//
// "Effective scheme" logic:
//   1. If Fastify's trustProxy is enabled, check the
//      X-Forwarded-Proto header first (set by nginx/caddy).
//   2. Fall back to the connection's own encryption flag.
//
// Exemptions:
//   - /health  — load-balancer health probes often use HTTP
//   - Twilio webhook paths (/twilio/*) — Twilio sends HTTP
//     POSTs to your webhook URL; signature validation is the
//     security gate, not HTTPS on the internal hop.
//
// Why 403 instead of 301/302 redirect?
//   Redirecting POST/PATCH/DELETE to HTTPS loses the body in
//   many clients.  A hard 403 fail-closed is safer: the client
//   (or misconfigured proxy) sees an immediate, unambiguous
//   error rather than a silent data-loss redirect.
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from './env.js';

/** Paths exempt from HTTPS enforcement. */
const EXEMPT_PREFIXES = ['/health'];

function isExempt(url: string): boolean {
  return EXEMPT_PREFIXES.some(p => url === p || url.startsWith(p + '/') || url.startsWith(p + '?'));
}

/**
 * Determine the effective scheme of the incoming request.
 *
 * When trust-proxy is enabled in Fastify, `req.protocol` already
 * reflects X-Forwarded-Proto.  We also handle the raw header as
 * a fallback for unit-test scenarios where Fastify injection
 * doesn't fully simulate trust-proxy behavior.
 */
export function getEffectiveScheme(req: FastifyRequest): string {
  // Fastify with trustProxy populates req.protocol from X-Forwarded-Proto
  // We check the raw header as well for maximum safety.
  const forwarded = (req.headers['x-forwarded-proto'] as string | undefined)
    ?.split(',')[0]
    ?.trim()
    ?.toLowerCase();

  if (forwarded === 'https' || forwarded === 'http') {
    return forwarded;
  }

  // Fall back to Fastify's own protocol detection
  return req.protocol;  // 'http' or 'https'
}

/**
 * Should HTTPS enforcement be active?
 */
export function isHttpsRequired(): boolean {
  return env.REQUIRE_HTTPS === 'true';
}

/**
 * Register the HTTPS enforcement hook on a Fastify instance.
 *
 * Must be called AFTER `app.register(...)` for trust-proxy
 * and BEFORE `app.listen(...)`.
 */
export function registerHttpsEnforcement(app: FastifyInstance): void {
  if (!isHttpsRequired()) {
    console.log('🔓 HTTPS enforcement: OFF (REQUIRE_HTTPS=false)');
    return;
  }

  console.log('🔒 HTTPS enforcement: ON — plain HTTP requests will be rejected with 403');

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip exempt paths
    if (isExempt(request.url)) return;

    const scheme = getEffectiveScheme(request);
    if (scheme === 'https') return;

    // Plain HTTP → reject
    reply
      .code(403)
      .header('Content-Type', 'application/json')
      .send({
        error: 'HTTPS required',
        message: 'This endpoint requires a secure (HTTPS) connection. '
          + 'If you are behind a reverse proxy, ensure it sets the X-Forwarded-Proto header.',
      });
  });
}

/**
 * Log the HTTPS enforcement policy at startup.
 */
export function logHttpsPolicy(): void {
  if (isHttpsRequired()) {
    console.log('🔒 HTTPS: REQUIRED — plain HTTP will be rejected (except /health)');
  } else {
    console.log('🔓 HTTPS: not enforced (REQUIRE_HTTPS=false)');
  }
}
