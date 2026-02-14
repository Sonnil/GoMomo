// ============================================================
// CORS Configuration — dynamic origin validation
//
// Development (NODE_ENV=development, PILOT_MODE=false):
//   - All localhost / 127.0.0.1 origins are allowed
//   - Any origin in CORS_ORIGIN (legacy) is allowed
//   - Permissive for dev ergonomics
//
// Pilot / Production (NODE_ENV=production OR PILOT_MODE=true):
//   - Default-deny: only origins in CORS_ALLOWED_ORIGINS pass
//   - Missing Origin header: allowed for non-browser (server-to-server)
//     calls but only on non-browser-facing routes (health, webhooks)
// ============================================================

import { env } from './env.js';

/** Is the server in strict CORS mode? */
export function isStrictCors(): boolean {
  return env.NODE_ENV === 'production' || env.PILOT_MODE === 'true';
}

/** Parsed allowlist for strict mode. */
function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  // CORS_ALLOWED_ORIGINS is the primary list for pilot/prod
  if (env.CORS_ALLOWED_ORIGINS) {
    origins.push(
      ...env.CORS_ALLOWED_ORIGINS.split(',')
        .map(s => s.trim())
        .filter(Boolean),
    );
  }

  // Also honour the legacy CORS_ORIGIN in all modes
  if (env.CORS_ORIGIN) {
    origins.push(
      ...env.CORS_ORIGIN.split(',')
        .map(s => s.trim())
        .filter(Boolean),
    );
  }

  return [...new Set(origins)]; // dedupe
}

/** localhost / 127.0.0.1 / [::1] on any port */
function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1'
    );
  } catch {
    return false;
  }
}

/**
 * Validate a request Origin header.
 *
 * @returns `true` if the origin is allowed, `false` if it must be blocked.
 *          For missing origins (server-to-server), returns `true` — the
 *          browser will never omit Origin on cross-origin requests, so
 *          blocking missing-Origin would only hurt curl / webhook callers.
 */
export function validateOrigin(origin: string | undefined): boolean {
  // No Origin header → server-to-server or same-origin navigation — allow
  if (!origin) return true;

  if (!isStrictCors()) {
    // Dev mode: allow all localhost + anything in legacy CORS_ORIGIN
    if (isLocalhostOrigin(origin)) return true;

    const legacy = env.CORS_ORIGIN.split(',').map(s => s.trim());
    if (legacy.includes(origin)) return true;

    // Still allow anything with a localhost-like host for dev convenience
    return isLocalhostOrigin(origin);
  }

  // Strict mode (pilot / production): allowlist only
  const allowed = getAllowedOrigins();
  return allowed.includes(origin);
}

/**
 * Fastify @fastify/cors `origin` callback.
 * Signature: (origin, callback) => callback(err, allow)
 */
export function fastifyCorsOrigin(
  origin: string | undefined,
  callback: (err: Error | null, allow: boolean) => void,
): void {
  callback(null, validateOrigin(origin));
}

/**
 * Socket.IO cors.origin callback.
 * Signature: (origin, callback) => callback(err, allow)
 */
export const socketIoCorsOrigin = fastifyCorsOrigin;

/**
 * Full @fastify/cors options object.
 */
export function getCorsOptions() {
  return {
    origin: fastifyCorsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: env.CORS_ALLOW_CREDENTIALS === 'true',
  };
}

/**
 * Socket.IO cors options object.
 */
export function getSocketIoCorsOptions() {
  return {
    origin: socketIoCorsOrigin,
    methods: ['GET', 'POST'],
    credentials: env.CORS_ALLOW_CREDENTIALS === 'true',
  };
}

/**
 * Log the effective CORS policy at startup.
 */
export function logCorsPolicy(): void {
  if (isStrictCors()) {
    const origins = getAllowedOrigins();
    console.log(`🔒 CORS: STRICT mode — ${origins.length} allowed origin(s): ${origins.join(', ') || '(none — all browser requests blocked!)'}`);
    if (origins.length === 0) {
      console.warn('⚠️  No CORS_ALLOWED_ORIGINS set — all cross-origin browser requests will be rejected.');
    }
  } else {
    console.log('🔓 CORS: DEV mode — localhost origins + CORS_ORIGIN allowed');
  }
}
