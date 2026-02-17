// ============================================================
// Intent Classifier — Deterministic (No LLM)
// ============================================================
// Regex/keyword-based classification for the hybrid FSM + LLM
// architecture. Fast, zero-token, runs synchronously.
//
// Intents:
//   GREETING         — hi, hello, hey, etc.
//   FAQ_BOOKING      — "how does booking work", "what services"
//   BOOK_DEMO        — user wants to book/schedule/try a demo
//   PROVIDE_EMAIL    — message looks like an email address
//   PROVIDE_OTP      — message looks like a 6-digit code
//   CHANGE_EMAIL     — user wants to switch/change email
//   GENERAL_SALES_Q  — non-FAQ sales/product question
//   OTHER            — fallback (→ LLM)
// ============================================================

export type ChatIntent =
  | 'GREETING'
  | 'FAQ_BOOKING'
  | 'BOOK_DEMO'
  | 'PROVIDE_EMAIL'
  | 'PROVIDE_OTP'
  | 'CHANGE_EMAIL'
  | 'GENERAL_SALES_Q'
  | 'OTHER';

// ── Pattern Banks ───────────────────────────────────────────

const GREETING_PATTERNS = [
  /^\s*(hi|hello|hey|howdy|hola|yo|sup|g'day|good\s*(morning|afternoon|evening|day))\s*[!.?]?\s*$/i,
  /^\s*(what'?s?\s*up|how\s*are\s*you|how'?s?\s*it\s*going)\s*[!.?]?\s*$/i,
];

const EMAIL_PATTERN = /^[\w.+-]+@[\w.-]+\.\w{2,}$/;

// Generous email detection: a message that IS or CONTAINS an email address
const CONTAINS_EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.\w{2,}/;

// Strict 6-digit only
const OTP_STRICT_PATTERN = /^\s*\d{6}\s*$/;

const CHANGE_EMAIL_PATTERNS = [
  /\b(change|switch|update|different|new|wrong)\b.*\bemail\b/i,
  /\bemail\b.*\b(change|switch|update|different|new|wrong)\b/i,
  /\buse\s+(a\s+)?different\s+email\b/i,
  /\bthat'?s?\s+not\s+my\s+email\b/i,
];

const BOOK_DEMO_PATTERNS = [
  /\b(book|schedule|make|set\s*up|arrange)\b.*\b(appointment|booking|demo|consultation|session|meeting|call)\b/i,
  /\b(appointment|booking|demo|consultation|session|meeting|call)\b.*\b(book|schedule|make|set\s*up|arrange)\b/i,
  /\b(try|want|like)\b.*\b(book|demo|appointment|schedule)\b/i,
  /\bbook\s+(me|a|an)\b/i,
  /\b(yes|yeah|yep|sure|ok|okay|let'?s?\s*(do\s*it|go|try))\s*$/i, // affirmative after CTA
  /\b(i'?d?\s*like\s*to|can\s*i|let'?s)\s*(book|schedule|try)\b/i,
  /\bwant\s*to\s*(try|book|schedule)\b/i,
  /\breschedule\b/i,
  /\bcancel\b.*\b(appointment|booking)\b/i,
];

const FAQ_BOOKING_PATTERNS = [
  /\bhow\s+(does|do)\s+(booking|scheduling|appointment)\b/i,
  /\bhow\s+to\s+(book|schedule|make\s+an?\s+appointment)\b/i,
  /\bwhat\s+(services?|do\s+you\s+offer|can\s+you\s+do)\b/i,
  /\bhow\s+(long|much\s+time)\b.*\b(appointment|session)\b/i,
  /\b(business|office)\s+hours\b/i,
  /\bwhen\s+are\s+you\s+open\b/i,
  /\bwhat\s+time\b.*\b(open|close|available)\b/i,
  /\bdo\s+you\s+take\s+walk-?ins?\b/i,
  /\bhow\s+(does|do)\s+(it|this|the\s+process)\s+work\b/i,
];

const GENERAL_SALES_PATTERNS = [
  /\b(pricing|price|cost|how\s+much|plans?|subscription|free\s+(plan|trial|tier))\b/i,
  /\b(features?|integrat|channel|industry|industries)\b/i,
  /\b(what\s+is|tell\s+me\s+about|who\s+(is|are|built|made))\s+(gomomo|you|this)\b/i,
  /\b(partner|investor|invest|agency|white\s*label|reseller|affiliate)\b/i,
  /\b(demo|talk\s+to\s+sales|speak\s+to\s+someone|sales\s+call|pitch)\b/i,
  /\b(privacy|terms|gdpr|data\s+deletion|contact|support|help)\b/i,
  /\b(mission|vision|purpose|why\s+gomomo|roi|benefits?|outcomes?)\b/i,
];

// ── Classifier ──────────────────────────────────────────────

/**
 * Classify a user message into a deterministic intent.
 * Returns the intent and a confidence hint.
 *
 * @param message  Raw user message
 * @param fsmState Current FSM state (influences classification)
 */
export function classifyIntent(
  message: string,
  fsmState?: string,
): { intent: ChatIntent; confidence: 'high' | 'medium' | 'low' } {
  const trimmed = message.trim();

  // ── Context-aware: if we're waiting for OTP, a number IS the OTP ──
  if (fsmState === 'OTP_SENT') {
    const digits = trimmed.replace(/[\s-]/g, '');
    if (/^\d{4,8}$/.test(digits)) {
      return { intent: 'PROVIDE_OTP', confidence: 'high' };
    }
  }

  // ── Context-aware: if we asked for email, an email IS the answer ──
  if (fsmState === 'EMAIL_REQUESTED') {
    if (EMAIL_PATTERN.test(trimmed)) {
      return { intent: 'PROVIDE_EMAIL', confidence: 'high' };
    }
    // Also detect if they say "it's user@example.com" or "my email is ..."
    if (CONTAINS_EMAIL_PATTERN.test(trimmed)) {
      return { intent: 'PROVIDE_EMAIL', confidence: 'high' };
    }
  }

  // ── OTP (6-digit code) — high confidence when strict match ──
  if (OTP_STRICT_PATTERN.test(trimmed)) {
    return { intent: 'PROVIDE_OTP', confidence: 'high' };
  }

  // ── Pure email ──
  if (EMAIL_PATTERN.test(trimmed)) {
    return { intent: 'PROVIDE_EMAIL', confidence: 'high' };
  }

  // ── Change email ──
  if (CHANGE_EMAIL_PATTERNS.some((p) => p.test(trimmed))) {
    return { intent: 'CHANGE_EMAIL', confidence: 'high' };
  }

  // ── Greeting (short messages only — prevents false positives) ──
  if (trimmed.length < 50 && GREETING_PATTERNS.some((p) => p.test(trimmed))) {
    return { intent: 'GREETING', confidence: 'high' };
  }

  // ── Book/schedule ──
  if (BOOK_DEMO_PATTERNS.some((p) => p.test(trimmed))) {
    return { intent: 'BOOK_DEMO', confidence: 'high' };
  }

  // ── FAQ about booking process ──
  if (FAQ_BOOKING_PATTERNS.some((p) => p.test(trimmed))) {
    return { intent: 'FAQ_BOOKING', confidence: 'medium' };
  }

  // ── General sales/product question ──
  if (GENERAL_SALES_PATTERNS.some((p) => p.test(trimmed))) {
    return { intent: 'GENERAL_SALES_Q', confidence: 'medium' };
  }

  // ── Affirmative responses in context ──
  if (fsmState && /^\s*(yes|yeah|yep|sure|ok|okay|absolutely|definitely|let'?s?\s*(go|do\s*it)?)\s*[!.?]?\s*$/i.test(trimmed)) {
    // Affirmative while in EMAIL_REQUESTED or OTP_SENT: keep current state
    // Affirmative in ANON/SALES_CHAT: treat as booking intent
    if (fsmState === 'ANON' || fsmState === 'SALES_CHAT') {
      return { intent: 'BOOK_DEMO', confidence: 'medium' };
    }
  }

  // ── Fallback ──
  return { intent: 'OTHER', confidence: 'low' };
}

/**
 * Extract an email address from a user message.
 * Returns null if no valid email is found.
 */
export function extractEmail(message: string): string | null {
  const match = message.match(CONTAINS_EMAIL_PATTERN);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Extract a numeric code from a user message (for OTP).
 * Returns null if no plausible code is found.
 */
export function extractOtp(message: string): string | null {
  const digits = message.trim().replace(/[\s-]/g, '');
  if (/^\d{4,8}$/.test(digits)) {
    return digits;
  }
  return null;
}
