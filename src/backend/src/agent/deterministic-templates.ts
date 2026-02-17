// ============================================================
// Deterministic Templates — Zero-Token Responses
// ============================================================
// Short, friendly, salesy responses for deterministic intents.
// These NEVER call the LLM. Keeps token usage at zero and
// response latency under 5ms.
// ============================================================

export type TemplateId =
  | 'GREETING'
  | 'GREETING_VERIFIED'
  | 'FAQ_BOOKING'
  | 'ASK_EMAIL'
  | 'ASK_EMAIL_AGAIN'
  | 'ASK_NEW_EMAIL'
  | 'INVALID_EMAIL'
  | 'OTP_SENT'
  | 'OTP_PENDING'
  | 'OTP_VERIFIED'
  | 'OTP_FAILED'
  | 'OTP_MAX_ATTEMPTS'
  | 'OTP_NOT_EXPECTED'
  | 'INVALID_OTP'
  | 'ALREADY_VERIFIED'
  | 'BOOKING_REQUIRES_EMAIL'
  | 'EMAIL_CHANGE_REVERIFY';

/**
 * Render a deterministic template with optional data interpolation.
 */
export function renderTemplate(
  id: TemplateId,
  data: Record<string, unknown> = {},
): string {
  const template = TEMPLATES[id];
  if (!template) {
    return `I'm sorry, something went wrong. Could you rephrase that?`;
  }
  return template(data);
}

// ── Template Definitions ────────────────────────────────────

const TEMPLATES: Record<TemplateId, (data: Record<string, unknown>) => string> = {
  GREETING: () =>
    `Hi 👋 I'm Gomomo — I help businesses automate bookings, confirmations, and reminders in seconds.\n\nWant to try a quick demo booking? Or ask me anything about how it works!`,

  GREETING_VERIFIED: (data) => {
    const email = data.verifiedEmail as string | undefined;
    return email
      ? `Welcome back! 👋 You're verified as **${email}**. Ready to book an appointment, or have any questions?`
      : `Welcome back! 👋 You're all verified. Ready to book an appointment?`;
  },

  FAQ_BOOKING: () =>
    `Great question! Here's how it works:\n\n` +
    `1. **Tell me when** — I'll check available time slots\n` +
    `2. **Pick a slot** — I'll hold it for 5 minutes while we finalize\n` +
    `3. **Quick verify** — confirm your email with a 6-digit code\n` +
    `4. **Done!** — you'll get a confirmation with calendar link\n\n` +
    `The whole process takes about 2 minutes. Want to try it now?`,

  ASK_EMAIL: () =>
    `Awesome — to send your confirmation, what email should I use?`,

  ASK_EMAIL_AGAIN: () =>
    `I still need your email to continue with the booking. What email should I use?`,

  ASK_NEW_EMAIL: (data) => {
    const prev = data.previousEmail as string | undefined;
    return prev
      ? `No problem! Your previous email was **${prev}**. What's the new email you'd like to use? (You'll need to verify it again.)`
      : `Sure! What email would you like to use instead? (You'll need to verify it with a quick code.)`;
  },

  INVALID_EMAIL: () =>
    `That doesn't look like a valid email address. Could you double-check and try again?`,

  OTP_SENT: (data) => {
    const email = data.email as string;
    return `Great — I sent a 6-digit code to **${email}**. What's the code?`;
  },

  OTP_PENDING: (data) => {
    const email = data.email as string | undefined;
    return email
      ? `I'm still waiting for the 6-digit code I sent to **${email}**. Check your inbox (and spam folder) and paste it here.`
      : `I'm still waiting for your verification code. Check your email and paste the 6-digit code here.`;
  },

  OTP_VERIFIED: () =>
    `Perfect ✅ You're verified! What day and time works best for your appointment?`,

  OTP_FAILED: (data) => {
    const attemptsLeft = data.attemptsLeft as number | undefined;
    return attemptsLeft !== undefined && attemptsLeft <= 3
      ? `That code didn't match. You have **${attemptsLeft}** attempts left. Try again or say "change email" to use a different one.`
      : `That code didn't match. Please double-check and try again, or say "change email" to use a different address.`;
  },

  OTP_MAX_ATTEMPTS: () =>
    `You've used all verification attempts. Let's start fresh — what email would you like to use?`,

  OTP_NOT_EXPECTED: () =>
    `I wasn't expecting a code right now. If you'd like to verify your email, just tell me and I'll send a new code!`,

  INVALID_OTP: () =>
    `That doesn't look like a valid code. Please enter the 6-digit number from your email.`,

  ALREADY_VERIFIED: () =>
    `You're already verified with that email! ✅ Ready to book?`,

  BOOKING_REQUIRES_EMAIL: () =>
    `Before we can finalize the booking, I need to verify your email. What email should I send the confirmation to?`,

  EMAIL_CHANGE_REVERIFY: (data) => {
    const newEmail = data.newEmail as string;
    const oldEmail = data.oldEmail as string | undefined;
    return oldEmail
      ? `I see you want to book with **${newEmail}** instead of **${oldEmail}**. I'll need to verify the new email first — sending a code now.`
      : `I'll need to verify **${newEmail}** before booking. Sending a code now.`;
  },
};
