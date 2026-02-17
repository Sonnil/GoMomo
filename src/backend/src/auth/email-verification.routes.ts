// ============================================================
// Email Verification Routes — Lead capture / email gate
//
// POST /api/auth/request-code
//   Body: { email, session_id, tenant_id }
//   Returns: { success, message, expires_in_minutes }
//
// POST /api/auth/verify-code
//   Body: { email, code, session_id, tenant_id, newsletter_opt_in? }
//   Returns: { success, message, customer_id? }
//
// Both endpoints are public (no session token required) since
// they are called before the user is fully authenticated.
// Rate limiting is applied per-IP and per-email.
// ============================================================

import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { markPublic } from './middleware.js';
import { isRecaptchaEnabled, verifyRecaptcha } from './recaptcha.js';
import { env } from '../config/env.js';
import { emailVerificationRepo, validateEmail } from '../repos/email-verification.repo.js';
import { sessionRepo } from '../repos/session.repo.js';
import { customerService } from '../services/customer.service.js';
import { sendVerificationEmail } from '../email/transport.js';

export async function emailVerificationRoutes(app: FastifyInstance): Promise<void> {

  // ── Rate limiting — scoped to verification routes ──
  await app.register(rateLimit, {
    max: Number(env.EMAIL_VERIFICATION_RATE_LIMIT),
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, context) => ({
      error: 'Too many verification requests. Please try again later.',
      statusCode: 429,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });

  /**
   * POST /api/auth/request-code — Request a verification code for email.
   */
  app.post<{
    Body: {
      email: string;
      session_id: string;
      tenant_id: string;
      recaptcha_token?: string;
    };
  }>('/api/auth/request-code', {
    preHandler: markPublic,
  }, async (req, reply) => {
    const { email, session_id, tenant_id, recaptcha_token } = req.body ?? {};

    if (!email || !session_id || !tenant_id) {
      return reply.code(400).send({
        error: 'email, session_id, and tenant_id are required.',
      });
    }

    // ── reCAPTCHA check (when enabled) ──────────────────
    if (isRecaptchaEnabled()) {
      if (!recaptcha_token) {
        return reply.code(400).send({
          error: 'Verification failed. Please try again.',
        });
      }
      const captchaResult = await verifyRecaptcha(recaptcha_token, req.ip);
      if (!captchaResult.success) {
        req.log.warn(
          { errorCodes: captchaResult.errorCodes, score: captchaResult.score },
          'reCAPTCHA verification failed on request-code',
        );
        return reply.code(400).send({
          error: 'Verification failed. Please try again.',
        });
      }
    }

    // Validate email format + disposable check
    const emailError = validateEmail(email);
    if (emailError) {
      return reply.code(400).send({ error: emailError });
    }

    // Rate limit by email+tenant (recent codes in last hour)
    const recentCount = await emailVerificationRepo.countRecent(email, tenant_id);
    if (recentCount >= Number(env.EMAIL_VERIFICATION_RATE_LIMIT)) {
      return reply.code(429).send({
        error: 'Too many verification codes requested for this email. Please wait before trying again.',
      });
    }

    // Create verification code
    const result = await emailVerificationRepo.create(email, session_id, tenant_id);

    // Send the OTP email via the configured provider
    const emailResult = await sendVerificationEmail(
      email,
      result.code,
      Number(env.EMAIL_VERIFICATION_TTL_MINUTES),
    );

    if (!emailResult.success) {
      req.log.error(
        { email, error: emailResult.error },
        'Failed to send verification email',
      );
      return reply.code(502).send({
        error: 'Unable to send verification email. Please try again shortly.',
      });
    }

    // Log code only in dev/test — NEVER in production
    const isDev = env.NODE_ENV !== 'production';
    if (isDev) {
      req.log.info(
        { email, session_id, code: result.code },
        'Verification code created (dev mode)',
      );
    } else {
      req.log.info(
        { email, session_id },
        'Verification code sent',
      );
    }

    return {
      success: true,
      message: 'Verification code sent to your email.',
      expires_in_minutes: Number(env.EMAIL_VERIFICATION_TTL_MINUTES),
      // Include code in dev/test for easy testing (never in production)
      ...(isDev ? { code: result.code } : {}),
    };
  });

  /**
   * POST /api/auth/verify-code — Verify the email code and create/link customer.
   */
  app.post<{
    Body: {
      email: string;
      code: string;
      session_id: string;
      tenant_id: string;
      newsletter_opt_in?: boolean;
    };
  }>('/api/auth/verify-code', {
    preHandler: markPublic,
  }, async (req, reply) => {
    const { email, code, session_id, tenant_id, newsletter_opt_in } = req.body ?? {};

    if (!email || !code || !session_id || !tenant_id) {
      return reply.code(400).send({
        error: 'email, code, session_id, and tenant_id are required.',
      });
    }

    // Verify the code
    const verified = await emailVerificationRepo.verify(email, code, session_id);

    if (!verified) {
      return reply.code(400).send({
        error: 'Invalid or expired verification code. Please try again.',
      });
    }

    // Mark session as email-verified
    await sessionRepo.markEmailVerified(session_id);

    // Resolve or create customer — link to session
    let customerId: string | undefined;
    try {
      const { customer } = await customerService.resolveByEmail(email, tenant_id);
      customerId = customer.id;
      await sessionRepo.linkCustomer(session_id, customer.id);

      // Update newsletter preference (default true from schema, but respect explicit opt-out)
      const newsletterPref = newsletter_opt_in !== false; // default true
      await updateNewsletterPreference(customer.id, newsletterPref);
    } catch (err) {
      req.log.warn({ err, email }, 'Customer resolution after verification failed (non-fatal)');
    }

    return {
      success: true,
      message: 'Email verified successfully.',
      customer_id: customerId,
    };
  });
}

// ── Helper: Update newsletter preference ──

import { query } from '../db/client.js';

async function updateNewsletterPreference(customerId: string, optIn: boolean): Promise<void> {
  await query(
    `UPDATE customers
     SET newsletter_opt_in = $1, email_verified_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [optIn, customerId],
  );
}
