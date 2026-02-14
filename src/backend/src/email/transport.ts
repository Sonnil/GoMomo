// ============================================================
// Email Transport Abstraction
//
// Provides a unified `sendEmail()` function that delegates to
// the configured provider (Resend, Postmark, or console).
//
// Provider selection:
//   1. If EMAIL_DEV_MODE=true  → always use console (no real delivery)
//   2. Otherwise               → use EMAIL_PROVIDER env var
//
// Usage:
//   import { sendEmail } from '../email/transport.js';
//   await sendEmail({ to: 'user@example.com', subject: '…', text: '…' });
// ============================================================

import { env } from '../config/env.js';

// ── Public Types ────────────────────────────────────────────

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  /** Whether the email was accepted for delivery (or logged in dev). */
  success: boolean;
  /** Provider-specific message ID, or 'console' in dev mode. */
  messageId?: string;
  /** Human-readable error when success=false. */
  error?: string;
}

// ── Provider Interface ──────────────────────────────────────

type EmailProvider = (payload: EmailPayload) => Promise<EmailResult>;

// ── Console Provider (dev / CI) ─────────────────────────────

const consoleProvider: EmailProvider = async (payload) => {
  console.log(
    '[EMAIL:console] To: %s | Subject: %s | Body: %s',
    payload.to,
    payload.subject,
    payload.text,
  );
  return { success: true, messageId: 'console' };
};

// ── Resend Provider ─────────────────────────────────────────

const resendProvider: EmailProvider = async (payload) => {
  // Lazy-import so the SDK is only loaded when actually used.
  const { Resend } = await import('resend');
  const resend = new Resend(env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO || undefined,
    to: [payload.to],
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, messageId: data?.id };
};

// ── Postmark Provider ───────────────────────────────────────

const postmarkProvider: EmailProvider = async (payload) => {
  // Postmark uses a simple REST API — we call it directly to
  // avoid adding another SDK dependency.
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': env.POSTMARK_API_TOKEN,
    },
    body: JSON.stringify({
      From: env.EMAIL_FROM,
      ReplyTo: env.EMAIL_REPLY_TO || undefined,
      To: payload.to,
      Subject: payload.subject,
      TextBody: payload.text,
      HtmlBody: payload.html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return { success: false, error: `Postmark ${res.status}: ${body}` };
  }

  const json = (await res.json()) as { MessageID?: string };
  return { success: true, messageId: json.MessageID };
};

// ── Provider Lookup ─────────────────────────────────────────

function resolveProvider(): EmailProvider {
  // Dev mode always bypasses real delivery
  if (env.EMAIL_DEV_MODE === 'true') {
    return consoleProvider;
  }

  switch (env.EMAIL_PROVIDER) {
    case 'resend':
      return resendProvider;
    case 'postmark':
      return postmarkProvider;
    case 'console':
      return consoleProvider;
    default:
      return consoleProvider;
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Send an email via the configured provider.
 *
 * In dev mode (EMAIL_DEV_MODE=true) this always logs to console
 * instead of sending a real email.
 */
export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
  const provider = resolveProvider();
  return provider(payload);
}

// ── OTP Email Builder ───────────────────────────────────────

/**
 * Build the OTP verification email payload (without sending).
 * Exported for testing.
 */
export function buildVerificationEmail(
  to: string,
  code: string,
  expiryMinutes: number,
): EmailPayload {
  const subject = 'Your gomomo verification code';

  const text = [
    `Your verification code is: ${code}`,
    '',
    `This code expires in ${expiryMinutes} minutes.`,
    '',
    'If you didn\'t request this code, you can safely ignore this email.',
    '',
    '— gomomo.ai',
  ].join('\n');

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #111; margin-bottom: 16px;">Your verification code</h2>
  <div style="background: #f4f4f5; border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 16px;">
    <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #111;">${code}</span>
  </div>
  <p style="color: #555; font-size: 14px; line-height: 1.5;">
    This code expires in <strong>${expiryMinutes} minutes</strong>.
  </p>
  <p style="color: #888; font-size: 13px; line-height: 1.5;">
    If you didn't request this code, you can safely ignore this email.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="color: #aaa; font-size: 12px;">gomomo.ai</p>
</div>`.trim();

  return { to, subject, text, html };
}

/**
 * Build and send the OTP verification email.
 */
export async function sendVerificationEmail(
  to: string,
  code: string,
  expiryMinutes: number,
): Promise<EmailResult> {
  const payload = buildVerificationEmail(to, code, expiryMinutes);
  return sendEmail(payload);
}
