// ============================================================
// Auth Routes — Session token issuance
//
// POST /api/auth/session
//   Body: { tenant_id: string, customer_email?: string, customer_phone?: string }
//   Returns: { token, session_id, expires_at, customer? }
//
// This is the single entry point for SDK clients. It:
//   1. Validates the tenant exists
//   2. Creates a chat session
//   3. Optionally resolves customer identity
//   4. Issues an HMAC-signed session token
//
// No API keys or user accounts required — the tenant must simply
// exist and be active. Rate limiting should be added at the
// infrastructure level (reverse proxy / CDN).
// ============================================================

import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { tenantRepo } from '../repos/tenant.repo.js';
import { sessionRepo } from '../repos/session.repo.js';
import { issueSessionToken } from './session-token.js';
import { markPublic } from './middleware.js';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {

  // ── Rate limiting — scoped to this plugin (auth routes only) ──
  await app.register(rateLimit, {
    max: env.AUTH_RATE_LIMIT_MAX,
    timeWindow: env.AUTH_RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => req.ip,
    // Only apply to POST /api/auth/session (not refresh)
    allowList: (_req, _key) => false,
    onExceeding: (req, _key) => {
      req.log.warn({ ip: req.ip, url: req.url }, 'Auth rate limit approaching');
    },
    onExceeded: (req, _key) => {
      req.log.warn({ ip: req.ip, url: req.url }, 'Auth rate limit exceeded — 429');
    },
    errorResponseBuilder: (_req, context) => ({
      error: 'Too many requests. Please try again later.',
      statusCode: 429,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });
  /**
   * POST /api/auth/session — Issue a session token for SDK clients.
   * Public: this is the login endpoint.
   */
  app.post<{
    Body: {
      tenant_id: string;
      customer_email?: string;
      customer_phone?: string;
    };
  }>('/api/auth/session', {
    preHandler: markPublic,
  }, async (req, reply) => {
    const { tenant_id, customer_email, customer_phone } = req.body ?? {};

    if (!tenant_id) {
      return reply.code(400).send({ error: 'tenant_id is required.' });
    }

    // 1. Validate tenant exists
    const tenant = await tenantRepo.findById(tenant_id);
    if (!tenant || !tenant.is_active) {
      return reply.code(404).send({ error: 'Tenant not found or inactive.' });
    }

    // 2. Create a new chat session
    const sessionId = uuidv4();
    await sessionRepo.findOrCreate(sessionId, tenant_id, 'web');

    // 3. Optionally resolve customer identity
    let customerId: string | undefined;
    let returningCustomer: { display_name: string | null; booking_count: number } | null = null;

    if (customer_email || customer_phone) {
      try {
        const { customerService } = await import('../services/customer.service.js');

        if (customer_email) {
          const { customer } = await customerService.resolveByEmail(customer_email, tenant_id);
          customerId = customer.id;
          await sessionRepo.linkCustomer(sessionId, customer.id);

          const ctx = await customerService.getReturningContext(customer.id);
          if (ctx) {
            returningCustomer = {
              display_name: ctx.display_name,
              booking_count: ctx.booking_count,
            };
          }
        } else if (customer_phone) {
          const { customer } = await customerService.resolveByPhone(customer_phone, tenant_id);
          customerId = customer.id;
          await sessionRepo.linkCustomer(sessionId, customer.id);

          const ctx = await customerService.getReturningContext(customer.id);
          if (ctx) {
            returningCustomer = {
              display_name: ctx.display_name,
              booking_count: ctx.booking_count,
            };
          }
        }
      } catch (err) {
        // Customer resolution is best-effort — don't fail the session
        console.warn('[auth] Customer resolution failed (non-fatal):', err);
      }
    }

    // 4. Issue token
    const ttlSeconds = 4 * 60 * 60; // 4 hours
    const token = issueSessionToken(tenant_id, sessionId, { customerId, ttlSeconds });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    return {
      token,
      session_id: sessionId,
      tenant_id,
      expires_at: expiresAt,
      returning_customer: returningCustomer,
    };
  });

  /**
   * POST /api/auth/refresh — Extend a session token.
   * Public: accepts a valid token in body and returns a fresh one.
   */
  app.post<{
    Body: { token: string };
  }>('/api/auth/refresh', {
    preHandler: markPublic,
  }, async (req, reply) => {
    const { token } = req.body ?? {};

    if (!token) {
      return reply.code(400).send({ error: 'token is required.' });
    }

    const { verifySessionToken } = await import('./session-token.js');
    const payload = verifySessionToken(token);

    if (!payload) {
      return reply.code(401).send({ error: 'Invalid or expired token.' });
    }

    // Issue fresh token with same session
    const ttlSeconds = 4 * 60 * 60;
    const newToken = issueSessionToken(payload.tid, payload.sid, {
      customerId: payload.cid,
      ttlSeconds,
    });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    return {
      token: newToken,
      session_id: payload.sid,
      tenant_id: payload.tid,
      expires_at: expiresAt,
    };
  });
}
