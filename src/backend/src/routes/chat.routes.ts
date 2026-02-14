import { FastifyInstance } from 'fastify';
import { tenantRepo } from '../repos/tenant.repo.js';
import { handleChatMessage } from '../agent/chat-handler.js';
import { customerService } from '../services/customer.service.js';
import { sessionRepo } from '../repos/session.repo.js';
import { requireSessionToken, isAuthEnforced } from '../auth/middleware.js';
import type { SessionTokenPayload } from '../auth/session-token.js';
import { isRecaptchaEnabled, verifyRecaptcha } from '../auth/recaptcha.js';
import { env } from '../config/env.js';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/tenants/:tenantId/chat
  // REST fallback for chat (WebSocket preferred)
  // When SDK_AUTH_REQUIRED=true, requires a valid session token.
  app.post<{
    Params: { tenantId: string };
    Body: {
      session_id: string;
      message: string;
      customer_email?: string;
      customer_phone?: string;
      recaptcha_token?: string;
    };
  }>('/api/tenants/:tenantId/chat', {
    preHandler: requireSessionToken,
  }, async (req, reply) => {
    const tenant = await tenantRepo.findById(req.params.tenantId);
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    // When auth is enforced, use session_id from token (prevent session hijacking)
    const tokenPayload = (req as any).sessionToken as SessionTokenPayload | undefined;
    const sessionIdFromBody = req.body.session_id;
    const message = req.body.message;

    let session_id: string;
    if (tokenPayload) {
      // Token present — enforce tenant match + use token's session
      if (tokenPayload.tid !== req.params.tenantId) {
        return reply.code(403).send({ error: 'Token tenant mismatch.' });
      }
      session_id = tokenPayload.sid;
    } else {
      // No token (auth not enforced) — use body session_id (backwards compat)
      session_id = sessionIdFromBody;
    }

    if (!session_id || !message) {
      return reply.code(400).send({ error: 'session_id and message are required' });
    }

    // ── reCAPTCHA check on BOOKING_REQUEST messages ─────
    if (isRecaptchaEnabled() && message.startsWith('BOOKING_REQUEST:')) {
      const { recaptcha_token } = req.body;
      if (!recaptcha_token) {
        return reply.code(400).send({
          error: 'Verification failed. Please try again.',
        });
      }
      const captchaResult = await verifyRecaptcha(recaptcha_token, req.ip);
      if (!captchaResult.success) {
        req.log.warn(
          { errorCodes: captchaResult.errorCodes, score: captchaResult.score },
          'reCAPTCHA verification failed on BOOKING_REQUEST',
        );
        return reply.code(400).send({
          error: 'Verification failed. Please try again.',
        });
      }
    }

    // ── Email Gate Check ──────────────────────────────────
    if (env.REQUIRE_EMAIL_AFTER_FIRST_MESSAGE === 'true') {
      const isVerified = await sessionRepo.isEmailVerified(session_id);
      if (!isVerified) {
        const msgCount = await sessionRepo.incrementMessageCount(session_id);
        if (msgCount > 1) {
          return reply.code(403).send({
            error: 'Email verification required to continue the conversation.',
            email_gate_required: true,
            session_id,
            message_count: msgCount,
          });
        }
      }
    }

    // ── Trial Message Cap — REMOVED (Phase 14: unlimited chat) ──

    // Resolve customer identity if provided
    const { customer_email, customer_phone } = req.body;
    let customerContext = null;
    if (customer_email || customer_phone) {
      try {
        if (customer_email) {
          const { customer } = await customerService.resolveByEmail(customer_email, tenant.id);
          await sessionRepo.linkCustomer(session_id, customer.id);
          customerContext = await customerService.getReturningContext(customer.id);
        } else if (customer_phone) {
          const { customer } = await customerService.resolveByPhone(customer_phone!, tenant.id);
          await sessionRepo.linkCustomer(session_id, customer.id);
          customerContext = await customerService.getReturningContext(customer.id);
        }
      } catch { /* best-effort */ }
    }

    const { response, meta } = await handleChatMessage(session_id, tenant.id, message, tenant, {
      customerContext,
    });
    return { session_id, response, meta };
  });
}
