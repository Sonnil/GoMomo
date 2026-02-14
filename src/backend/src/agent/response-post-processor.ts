// ============================================================
// Response Post-Processor — Code-Enforced Guardrails
//
// Sanitizes the LLM's final text response to enforce invariants
// that prompt-only guardrails cannot guarantee:
//
//  Guardrail 3: No "confirmed" / "booked" language UNLESS
//               confirm_booking actually succeeded this turn.
//
//  Guardrail 4: No phone-call claim phrases (transfer, call you,
//               connect you to a person, etc.) — the system
//               CANNOT make or receive phone calls.
// ============================================================

// ── Guardrail 3 — Premature Confirmation Language ─────────

/**
 * Phrases that imply a booking is finalized. These are ONLY acceptable
 * when `confirm_booking` was invoked and succeeded in this turn.
 *
 * The patterns are case-insensitive and use word boundaries.
 */
const CONFIRMATION_PATTERNS: RegExp[] = [
  /\byour\s+(appointment|booking)\s+(is|has\s+been)\s+confirmed\b/i,
  /\byour\s+(appointment|booking)\s+(is|has\s+been)\s+booked\b/i,
  /\bsuccessfully\s+(confirmed|booked)\b/i,
  /\bappointment\s+confirmed\b/i,
  /\bbooking\s+confirmed\b/i,
  /\byou('re| are)\s+all\s+(set|booked)\b/i,
  /\bI('ve| have)\s+(confirmed|booked)\s+your\b/i,
];

/**
 * Safe replacement when the LLM emits confirmation language prematurely.
 * The phrase is vague enough to not mislead the user.
 */
const PREMATURE_CONFIRMATION_REPLACEMENT =
  "I'm still working on finalizing your appointment details";

// ── Guardrail 4 — Forbidden Phone-Call Claims ─────────────

/**
 * Phrases that claim the system can make, transfer, or facilitate
 * a phone call — which it cannot.
 */
const PHONE_CALL_PATTERNS: RegExp[] = [
  /\bI'll\s+have\s+someone\s+call\s+you\b/i,
  /\blet\s+me\s+transfer\s+you\b/i,
  /\bI('ll| will)\s+transfer\s+you\b/i,
  /\bI('ll| will)\s+connect\s+you\s+(to|with)\b/i,
  /\btransferring\s+you\s+(to|now)\b/i,
  /\bI('ll| will)\s+call\s+you\b/i,
  /\bwe('ll| will)\s+call\s+you\b/i,
  /\bsomeone\s+will\s+call\s+you\b/i,
  /\bI('ll| will)\s+put\s+you\s+through\b/i,
  /\bI('ll| will)\s+patch\s+you\s+through\b/i,
  /\bI('m| am)\s+connecting\s+you\b/i,
  /\blet\s+me\s+connect\s+you\b/i,
  /\bI('ll| will)\s+have\s+(them|the\s+\w+)\s+call\b/i,
  /\bI can\s+(call|phone|ring)\s+you\b/i,
  /\bgive\s+you\s+a\s+call\b/i,
];

/**
 * Safe replacement for phone-call claims. Directs the user to
 * the contact methods the system actually supports.
 */
const PHONE_CALL_REPLACEMENT =
  'I can send confirmations or follow-ups by text or email';

// ── Guardrail 5 — Legacy Brand Sanitizer ──────────────────

/**
 * Patterns matching legacy / forbidden brand names that the LLM
 * might hallucinate from training data. These MUST NOT appear in
 * any assistant output.
 *
 * NOTE: The forbidden names are kept HERE (code-level regex) and
 * are intentionally NOT injected into the system prompt, to avoid
 * the Streisand effect (naming a word you forbid feeds it to the model).
 */
const LEGACY_BRAND_PATTERNS: RegExp[] = [
  // "Bloom Wellness Studio" / "Bloom Wellness" / "Bloom Studio"
  /\bBloom\s+Wellness\s+Studio\b/gi,
  /\bBloom\s+Wellness\b/gi,
  /\bBloom\s+Studio\b/gi,
  // Standalone "Bloom" when used as a brand (preceded/followed by brand-context words)
  /\bBloom\.ai\b/gi,
  /\bbloom\.ai\b/gi,
  // "Demo Clinic" / "Demo Wellness"
  /\bDemo\s+Clinic\b/gi,
  /\bDemo\s+Wellness\b/gi,
];

const LEGACY_BRAND_REPLACEMENT = 'Gomomo';

// ── Guardrail 6 — Calendar Data-URI Stripper ──────────────

// ── Guardrail 7 — External URL / Spam Domain Stripper ─────

/**
 * The LLM occasionally hallucates links to unrelated websites
 * (social media, old platforms, random domains) from its training data.
 * The agent should ONLY ever link to gomomo.ai or the tenant domain.
 *
 * This guardrail strips any external URLs that are NOT gomomo.ai.
 */
const EXTERNAL_URL_PATTERNS: RegExp[] = [
  // Markdown links to non-gomomo domains
  /\[([^\]]*)\]\(https?:\/\/(?!(?:www\.)?gomomo\.ai)[^)]+\)/gi,
  // Bare URLs to well-known spam/social/unrelated domains
  /(?:https?:\/\/)?(?:www\.)?myspace\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?facebook\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?twitter\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?instagram\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?tiktok\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?linkedin\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?reddit\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?pinterest\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?snapchat\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?tumblr\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?whatsapp\.com[^\s)}\]"']*/gi,
  /(?:https?:\/\/)?(?:www\.)?discord\.com[^\s)}\]"']*/gi,
];

/**
 * Sentences that introduce an external link, left orphaned after
 * the URL itself is stripped. These patterns target web-navigation
 * phrasing specifically — "visit us at", "check out our page", etc.
 * The word "visit" alone is NOT matched (it could mean a medical visit).
 */
const EXTERNAL_URL_SENTENCE_CLEANUP: RegExp[] = [
  // "visit us at <stripped>" / "visit our website" / "visit <URL>"
  /(?:^|\n)[^\n.!?]*\bvisit\s+(?:us\s+(?:at|on)|our\s+\w+|https?:\/\/)\s*[.:\s]*(?:\n|$)/gi,
  // "check out our …" / "go to our …" / "head to our …"
  /(?:^|\n)[^\n.!?]*(?:check\s+out|go\s+to|head\s+to)\s+(?:our\s+\w+|https?:\/\/)\s*[.:\s]*(?:\n|$)/gi,
  // "find us on …" / "follow us on …" — always web-context
  /(?:^|\n)[^\n.!?]*(?:find\s+us\s+on|follow\s+us\s+on)\s*[.:\s]*(?:\n|$)/gi,
];

// ── Guardrail 8 — Broadcast/Media Sign-Off Phrases ───────

/**
 * YouTube-style, podcast-style, or broadcast-style sign-off phrases
 * that the LLM hallucinates from its training data. These are NEVER
 * appropriate for a business receptionist agent.
 */
const SIGNOFF_PATTERNS: RegExp[] = [
  /\bthanks\s+for\s+watching\s*[.!]?\s*/gi,
  /\bthank\s+you\s+for\s+watching\s*[.!]?\s*/gi,
  /\bthanks\s+for\s+listening\s*[.!]?\s*/gi,
  /\bdon'?t\s+forget\s+to\s+subscribe\b[^.!?]*[.!]?\s*/gi,
  /\bhit\s+(?:the\s+)?(?:like|subscribe|bell|notification)\b[^.!?]*[.!]?\s*/gi,
  /\blike\s+(?:and\s+)?subscribe\b[^.!?]*[.!]?\s*/gi,
  /\bsee\s+you\s+(?:in\s+the\s+)?next\s+(?:one|video|episode)\b[^.!?]*[.!]?\s*/gi,
  /\buntil\s+next\s+time\b[^.!?]*[.!]?\s*/gi,
  /\bstay\s+tuned\b[^.!?]*[.!]?\s*/gi,
  /\bsmash\s+that\s+like\s+button\b[^.!?]*[.!]?\s*/gi,
];

/**
 * The LLM sometimes emits the raw data:text/calendar URI as a markdown
 * link (e.g. "[Add to Calendar](data:text/calendar;charset=utf-8,…)").
 * The calendar download button is rendered client-side from structured
 * booking data, so the raw link in the text is redundant and ugly.
 *
 * Patterns matched (case-insensitive):
 *  • Markdown links:  [any text](data:text/calendar…)
 *  • Bare URLs:       data:text/calendar;charset=utf-8,BEGIN…
 *  • Surrounding sentence fragments like "You can download it here: <link>"
 */
const CALENDAR_LINK_PATTERNS: RegExp[] = [
  // Markdown link: [text](data:text/calendar…)
  /\[([^\]]*)\]\(data:text\/calendar[^)]*\)/gi,
  // Bare data URI (entire URI, can be very long)
  /data:text\/calendar[^\s)}\]"']*/gi,
];

/**
 * Sentences that ONLY exist to introduce the calendar link.
 * After the link itself is stripped, these become orphaned fragments.
 * We clean them up to avoid empty sentences like "Here's your calendar link: "
 */
const CALENDAR_SENTENCE_CLEANUP: RegExp[] = [
  // "You can [also] add it to your calendar:" / "Here's the calendar link:" etc.
  /(?:^|\n)[^\n.!?]*(?:add\s+(?:it\s+)?to\s+(?:your\s+)?calendar|calendar\s+(?:link|download|file|invite))[\s:.\-—]*(?:\n|$)/gi,
  // Orphaned colons / dashes left over after link removal
  /\s*:\s*$/gm,
];

// ── Post-Processor Function ───────────────────────────────

export interface PostProcessorContext {
  /** Tool names that were invoked (and returned) during this turn. */
  toolsUsed: string[];
  /** Channel this response is being sent to. Affects formatting rules. */
  channel?: 'web' | 'sms' | 'voice';
}

/**
 * Applies code-enforced guardrails to the assistant's final response
 * text. Returns the sanitized string.
 *
 * This is a **deterministic, synchronous** function — no LLM calls.
 */
export function postProcessResponse(
  response: string,
  ctx: PostProcessorContext,
): string {
  let sanitized = response;

  // ── Guardrail 3 ─────────────────────────────────────────
  // Only allow confirmation language if confirm_booking was used.
  const confirmBookingUsed = ctx.toolsUsed.includes('confirm_booking');

  if (!confirmBookingUsed) {
    for (const pattern of CONFIRMATION_PATTERNS) {
      sanitized = sanitized.replace(pattern, PREMATURE_CONFIRMATION_REPLACEMENT);
    }
  }

  // ── Guardrail 4 ─────────────────────────────────────────
  // Always strip phone-call claims (system never has phone capability).
  for (const pattern of PHONE_CALL_PATTERNS) {
    sanitized = sanitized.replace(pattern, PHONE_CALL_REPLACEMENT);
  }

  // ── Guardrail 5 ─────────────────────────────────────────
  // Strip any legacy brand names the LLM might hallucinate.
  for (const pattern of LEGACY_BRAND_PATTERNS) {
    sanitized = sanitized.replace(pattern, LEGACY_BRAND_REPLACEMENT);
  }

  // ── Guardrail 6 ─────────────────────────────────────────
  // Strip raw data:text/calendar links — the download button is rendered
  // client-side from structured booking data. The link in the text is ugly.
  for (const pattern of CALENDAR_LINK_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }
  // Clean up orphaned sentences that only introduced the calendar link
  for (const pattern of CALENDAR_SENTENCE_CLEANUP) {
    sanitized = sanitized.replace(pattern, '');
  }

  // ── Guardrail 7 ─────────────────────────────────────────
  // Strip external URLs the LLM may hallucinate (myspace.com, social media, etc.).
  // First: markdown links to non-gomomo domains → keep link text, drop URL
  sanitized = sanitized.replace(
    /\[([^\]]*)\]\(https?:\/\/(?!(?:www\.)?gomomo\.ai)[^)]+\)/gi,
    (_match, linkText: string) => linkText?.trim() || '',
  );
  // Then: bare social-media / spam domain URLs → strip entirely
  for (let i = 1; i < EXTERNAL_URL_PATTERNS.length; i++) {
    sanitized = sanitized.replace(EXTERNAL_URL_PATTERNS[i], '');
  }
  // Clean up orphaned "visit …" sentences after URL removal
  for (const pattern of EXTERNAL_URL_SENTENCE_CLEANUP) {
    sanitized = sanitized.replace(pattern, '');
  }

  // ── Guardrail 8 ─────────────────────────────────────────
  // Strip broadcast/YouTube-style sign-off phrases.
  for (const pattern of SIGNOFF_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }

  // Collapse any runs of 3+ newlines that stripping may have left
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim();

  // ── SMS Formatting ──────────────────────────────────────
  // Strip markdown artifacts that the LLM might emit despite instructions.
  if (ctx.channel === 'sms') {
    sanitized = formatForSms(sanitized);
  }

  return sanitized;
}

// ── SMS Formatting Helper ─────────────────────────────────

/**
 * Clean up LLM output for SMS delivery:
 * - Strip markdown bold/italic/headers
 * - Convert markdown bullet lists to numbered lists
 * - Collapse excessive whitespace
 * - Convert "**Heading:**" patterns to "HEADING:" for readability
 */
export function formatForSms(text: string): string {
  let s = text;

  // Remove markdown headers (## Heading → HEADING)
  s = s.replace(/^#{1,4}\s+(.+)$/gm, (_m, heading: string) => heading.toUpperCase());

  // Remove markdown bold **text** and __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');

  // Remove markdown italic *text* and _text_ (but not in contractions like "don't")
  s = s.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1');

  // Convert markdown bullet lists (- item) to numbered lists
  // Find consecutive lines starting with "- "
  s = s.replace(/((?:^- .+$\n?)+)/gm, (block) => {
    const lines = block.trim().split('\n');
    return lines
      .map((line, i) => `${i + 1}) ${line.replace(/^- /, '')}`)
      .join('\n') + '\n';
  });

  // Collapse 3+ newlines into 2
  s = s.replace(/\n{3,}/g, '\n\n');

  // Trim trailing whitespace per line
  s = s.replace(/[ \t]+$/gm, '');

  return s.trim();
}

// ── Exports for testing ───────────────────────────────────
export const _testing = {
  CONFIRMATION_PATTERNS,
  PHONE_CALL_PATTERNS,
  PREMATURE_CONFIRMATION_REPLACEMENT,
  PHONE_CALL_REPLACEMENT,
  LEGACY_BRAND_PATTERNS,
  LEGACY_BRAND_REPLACEMENT,
  CALENDAR_LINK_PATTERNS,
  CALENDAR_SENTENCE_CLEANUP,
  EXTERNAL_URL_PATTERNS,
  EXTERNAL_URL_SENTENCE_CLEANUP,
  SIGNOFF_PATTERNS,
};
