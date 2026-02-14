// ============================================================
// Email Verification Repository
//
// Manages OTP codes for email-gated lead capture.
// - Create verification records (6-digit codes)
// - Verify codes with attempt tracking
// - Rate-limit code requests per email
// - Cleanup expired codes
//
// PII Note: emails are stored for verification only.
// Logs must NOT include email addresses.
// ============================================================

import { query } from '../db/client.js';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';

export interface EmailVerification {
  id: string;
  email: string;
  code: string;
  session_id: string;
  tenant_id: string;
  attempts: number;
  verified_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

/** Generate a 6-digit numeric code. */
function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Disposable Email Detection ────────────────────────────
// Basic check — blocks obvious throwaway domains.
// Not exhaustive — just catches the most common ones.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'dispostable.com', 'mailnesia.com', 'maildrop.cc', 'temp-mail.org',
  'fakeinbox.com', 'trashmail.com', 'getnada.com', '10minutemail.com',
  'tempail.com', 'mohmal.com', 'burnermail.io', 'mailtemp.net',
]);

/**
 * Basic email validation + disposable domain check.
 * Returns null if valid, or an error message string.
 */
export function validateEmail(email: string): string | null {
  if (!email || typeof email !== 'string') {
    return 'Email is required.';
  }

  const trimmed = email.trim().toLowerCase();

  // Basic format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed)) {
    return 'Invalid email format.';
  }

  // Length check
  if (trimmed.length > 254) {
    return 'Email address is too long.';
  }

  // Disposable domain check
  const domain = trimmed.split('@')[1];
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return 'Please use a permanent email address.';
  }

  return null;
}

export const emailVerificationRepo = {
  /**
   * Create a new verification code for an email + session.
   * Invalidates any previous unused codes for the same email + session.
   */
  async create(
    email: string,
    sessionId: string,
    tenantId: string,
  ): Promise<{ id: string; code: string; expires_at: Date }> {
    const id = uuidv4();
    const code = generateCode();
    const ttlMs = env.EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);

    // Soft-invalidate previous pending codes for same email+session
    await query(
      `UPDATE email_verifications
       SET expires_at = NOW()
       WHERE email = $1 AND session_id = $2 AND verified_at IS NULL AND expires_at > NOW()`,
      [email.toLowerCase(), sessionId],
    );

    await query(
      `INSERT INTO email_verifications (id, email, code, session_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, email.toLowerCase(), code, sessionId, tenantId, expiresAt],
    );

    return { id, code, expires_at: expiresAt };
  },

  /**
   * Verify a code. Returns the verification record if valid.
   * Increments attempt counter on failure.
   * Returns null if code is invalid, expired, or max attempts exceeded.
   */
  async verify(
    email: string,
    code: string,
    sessionId: string,
  ): Promise<EmailVerification | null> {
    // Find the most recent unexpired, unverified code for this email+session
    const { rows } = await query<EmailVerification>(
      `SELECT * FROM email_verifications
       WHERE email = $1 AND session_id = $2
         AND verified_at IS NULL
         AND expires_at > NOW()
         AND attempts < $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [email.toLowerCase(), sessionId, env.EMAIL_VERIFICATION_MAX_ATTEMPTS],
    );

    if (rows.length === 0) return null;

    const record = rows[0];

    if (record.code !== code) {
      // Wrong code — increment attempts
      await query(
        'UPDATE email_verifications SET attempts = attempts + 1 WHERE id = $1',
        [record.id],
      );
      return null;
    }

    // Correct code — mark verified
    await query(
      'UPDATE email_verifications SET verified_at = NOW() WHERE id = $1',
      [record.id],
    );

    return { ...record, verified_at: new Date() };
  },

  /**
   * Count recent verification requests for rate limiting.
   * Returns number of codes requested in the last hour.
   */
  async countRecent(email: string, tenantId: string): Promise<number> {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM email_verifications
       WHERE email = $1 AND tenant_id = $2
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [email.toLowerCase(), tenantId],
    );
    return parseInt(rows[0].count, 10);
  },

  /**
   * Check if an email is already verified for a session.
   */
  async isVerified(email: string, sessionId: string): Promise<boolean> {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM email_verifications
       WHERE email = $1 AND session_id = $2 AND verified_at IS NOT NULL`,
      [email.toLowerCase(), sessionId],
    );
    return parseInt(rows[0].count, 10) > 0;
  },

  /**
   * Check if any email is verified for a session (regardless of which email).
   */
  async isSessionVerified(sessionId: string): Promise<boolean> {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM email_verifications
       WHERE session_id = $1 AND verified_at IS NOT NULL`,
      [sessionId],
    );
    return parseInt(rows[0].count, 10) > 0;
  },

  /**
   * Get the verified email for a session (most recent).
   */
  async getVerifiedEmail(sessionId: string): Promise<string | null> {
    const { rows } = await query<{ email: string }>(
      `SELECT email FROM email_verifications
       WHERE session_id = $1 AND verified_at IS NOT NULL
       ORDER BY verified_at DESC
       LIMIT 1`,
      [sessionId],
    );
    return rows[0]?.email ?? null;
  },
};
