// ============================================================
// reCAPTCHA v3 server-side verification
//
// Calls Google's siteverify API. Returns { success, score? }
// so the caller can decide how to respond.
//
// IMPORTANT: Never log the raw token — it is a user credential.
// ============================================================

import { env } from '../config/env.js';

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

export interface RecaptchaResult {
  /** Whether the verification passed all checks. */
  success: boolean;
  /** The bot-likelihood score (0.0 = bot, 1.0 = human). Only set on success. */
  score?: number;
  /** Machine-readable error codes from Google (for logging/debugging). */
  errorCodes?: string[];
}

/**
 * Returns true when reCAPTCHA enforcement is active.
 * Use this to short-circuit early in routes.
 */
export function isRecaptchaEnabled(): boolean {
  return env.RECAPTCHA_ENABLED === 'true';
}

/**
 * Verify a reCAPTCHA v3 token with Google's siteverify endpoint.
 *
 * @param token  The `g-recaptcha-response` token from the frontend.
 * @param remoteIp  Optional client IP forwarded for extra validation.
 * @returns Result object — never throws (network errors → success: false).
 */
export async function verifyRecaptcha(
  token: string,
  remoteIp?: string,
): Promise<RecaptchaResult> {
  if (!token) {
    return { success: false, errorCodes: ['missing-input-response'] };
  }

  const body = new URLSearchParams({
    secret: env.RECAPTCHA_SECRET_KEY,
    response: token,
  });
  if (remoteIp) body.append('remoteip', remoteIp);

  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(5000), // 5 s hard timeout
    });

    if (!res.ok) {
      return { success: false, errorCodes: [`http-${res.status}`] };
    }

    const data = (await res.json()) as {
      success: boolean;
      score?: number;
      'error-codes'?: string[];
    };

    if (!data.success) {
      return { success: false, errorCodes: data['error-codes'] ?? ['unknown'] };
    }

    // Score check — reject likely bots
    const minScore = env.RECAPTCHA_MIN_SCORE;
    if (typeof data.score === 'number' && data.score < minScore) {
      return { success: false, score: data.score, errorCodes: ['score-too-low'] };
    }

    return { success: true, score: data.score };
  } catch {
    // Network / timeout errors — fail closed
    return { success: false, errorCodes: ['network-error'] };
  }
}
