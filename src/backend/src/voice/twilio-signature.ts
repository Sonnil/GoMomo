/**
 * Twilio Signature Validation — Shared Module
 *
 * Unified validation logic for all Twilio webhook routes (voice + SMS).
 *
 * Skip policy:
 *   - TWILIO_AUTH_TOKEN empty AND dev/test mode → skip (local dev convenience)
 *   - TWILIO_AUTH_TOKEN empty AND PILOT_MODE=true or production → fail closed (403)
 *   - TWILIO_AUTH_TOKEN present → always validate
 */

import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';

export function validateTwilioSignature(
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const isDev = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';

  // No auth token configured
  if (!env.TWILIO_AUTH_TOKEN) {
    if (isDev && env.PILOT_MODE !== 'true') {
      // Local dev / test — skip silently
      return true;
    }
    // Production or pilot mode — fail closed
    reply.code(403).send('TWILIO_AUTH_TOKEN is required in production / pilot mode');
    return false;
  }

  // Auth token present — always validate
  const sig = req.headers['x-twilio-signature'] as string | undefined;
  if (!sig) {
    reply.code(403).send('Missing Twilio signature');
    return false;
  }

  const url = `${env.TWILIO_WEBHOOK_BASE_URL}${req.url.split('?')[0]}`;
  const body = (req.body ?? {}) as Record<string, string>;

  // Sort body params and concatenate (per Twilio spec)
  const data = url + Object.keys(body)
    .sort()
    .reduce((acc, key) => acc + key + body[key], '');

  const expected = crypto
    .createHmac('sha1', env.TWILIO_AUTH_TOKEN)
    .update(data)
    .digest('base64');

  // Constant-time comparison
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    reply.code(403).send('Invalid Twilio signature');
    return false;
  }

  return true;
}
