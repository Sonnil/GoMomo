/**
 * Voice NLU — Simple rule-based intent & entity extraction
 *
 * Extracts intents (book, reschedule, cancel) and entities (date, time,
 * name, email, service, reference code, yes/no) from transcribed speech.
 * No ML model — pattern matching only for MVP determinism.
 */

import type { VoiceIntent } from '../domain/types.js';
import { addDays, nextMonday, nextTuesday, nextWednesday, nextThursday, nextFriday, format } from 'date-fns';
import { getNow } from '../services/clock.js';

/** Default timezone used when caller doesn't specify one. */
const DEFAULT_TZ = 'America/New_York';

// ── Intent Detection ────────────────────────────────────────────

const INTENT_PATTERNS: Record<VoiceIntent, RegExp[]> = {
  book: [
    /\b(book|schedule|make|set\s*up|create|new)\b.*\b(appointment|booking|visit|session|consultation)\b/i,
    /\b(appointment|booking)\b/i,
    /\b(book|schedule)\b/i,
    /\bi(?:'d| would) like to (?:book|schedule|make)\b/i,
  ],
  reschedule: [
    /\b(reschedule|move|change|shift)\b.*\b(appointment|booking|visit|session)\b/i,
    /\breschedule\b/i,
    /\b(move|change)\b.*\b(time|date|appointment)\b/i,
  ],
  cancel: [
    /\b(cancel|remove|delete)\b.*\b(appointment|booking|visit|session)\b/i,
    /\bcancel\b/i,
  ],
  unknown: [],
};

export function detectIntent(text: string): VoiceIntent {
  const cleaned = text.trim().toLowerCase();
  // Check cancel first (more specific) before book
  for (const intent of ['cancel', 'reschedule', 'book'] as VoiceIntent[]) {
    for (const pattern of INTENT_PATTERNS[intent]) {
      if (pattern.test(cleaned)) return intent;
    }
  }
  return 'unknown';
}

// ── Yes/No Detection ────────────────────────────────────────────

export function detectYesNo(text: string): 'yes' | 'no' | null {
  const cleaned = text.trim().toLowerCase();
  if (/\b(yes|yeah|yep|yup|sure|correct|absolutely|please|confirm|that'?s? right|go ahead|do it)\b/i.test(cleaned)) {
    return 'yes';
  }
  if (/\b(no|nope|nah|not really|cancel|never\s?mind|forget it|don'?t|stop)\b/i.test(cleaned)) {
    return 'no';
  }
  return null;
}

// ── Service Detection ───────────────────────────────────────────

export function detectService(text: string, availableServices: string[]): string | null {
  const cleaned = text.trim().toLowerCase();
  // Try exact/fuzzy match against available services
  for (const svc of availableServices) {
    const svcLower = svc.toLowerCase();
    // Check if service name appears in text
    if (cleaned.includes(svcLower)) return svc;
    // Check first word match ("general" → "General Consultation")
    const firstWord = svcLower.split(/\s+/)[0];
    if (firstWord.length > 3 && cleaned.includes(firstWord)) return svc;
  }
  // Fallback patterns
  if (/\b(follow[\s-]?up)\b/i.test(cleaned)) {
    return availableServices.find((s) => /follow/i.test(s)) ?? null;
  }
  if (/\b(extended|long|in[\s-]?depth)\b/i.test(cleaned)) {
    return availableServices.find((s) => /extended|long/i.test(s)) ?? null;
  }
  if (/\b(general|regular|standard|normal)\b/i.test(cleaned)) {
    return availableServices.find((s) => /general|standard/i.test(s)) ?? null;
  }
  // If there's only one service, accept any affirmative
  if (availableServices.length === 1 && detectYesNo(text) === 'yes') {
    return availableServices[0];
  }
  return null;
}

// ── Date Detection ──────────────────────────────────────────────

export function detectDate(text: string, timezone: string = DEFAULT_TZ): string | null {
  const cleaned = text.trim().toLowerCase();
  const today = getNow(timezone);

  // "today"
  if (/\btoday\b/.test(cleaned)) {
    return format(today, 'yyyy-MM-dd');
  }
  // "tomorrow"
  if (/\btomorrow\b/.test(cleaned)) {
    return format(addDays(today, 1), 'yyyy-MM-dd');
  }
  // "next monday", "this tuesday", etc
  const dayMap: Record<string, (d: Date) => Date> = {
    monday: nextMonday,
    tuesday: nextTuesday,
    wednesday: nextWednesday,
    thursday: nextThursday,
    friday: nextFriday,
  };
  for (const [dayName, nextFn] of Object.entries(dayMap)) {
    if (cleaned.includes(dayName)) {
      return format(nextFn(today), 'yyyy-MM-dd');
    }
  }
  // "february 10", "feb 10th", "mar 5", "2/10", "02/10/2026"
  const monthNameMatch = cleaned.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (monthNameMatch) {
    const monthLookup: Record<string, number> = {
      jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
      apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
      aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
      nov: 10, november: 10, dec: 11, december: 11,
    };
    const m = monthLookup[monthNameMatch[1].toLowerCase()];
    const d = parseInt(monthNameMatch[2], 10);
    if (m !== undefined) {
      const year = today.getFullYear();
      const candidate = new Date(year, m, d);
      if (candidate < today) candidate.setFullYear(year + 1);
      return format(candidate, 'yyyy-MM-dd');
    }
  }
  // "2/10" or "02/10"
  const slashMatch = cleaned.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashMatch) {
    const m = parseInt(slashMatch[1], 10) - 1;
    const d = parseInt(slashMatch[2], 10);
    let y = slashMatch[3] ? parseInt(slashMatch[3], 10) : today.getFullYear();
    if (y < 100) y += 2000;
    return format(new Date(y, m, d), 'yyyy-MM-dd');
  }
  return null;
}

// ── Slot Choice Detection ───────────────────────────────────────

/**
 * Match user speech to one of the offered slot display_times.
 * Handles: "9 AM", "the 10 o'clock one", "3:30 PM", "the second one", ordinals.
 */
export function detectSlotChoice(
  text: string,
  slots: Array<{ start: string; end: string; display_time: string }>,
): { start: string; end: string; display_time: string } | null {
  const cleaned = text.trim().toLowerCase();

  // Try ordinal / number references: "the first one", "number 2", "the third"
  const ordinalMap: Record<string, number> = {
    first: 0, '1st': 0, one: 0, '1': 0,
    second: 1, '2nd': 1, two: 1, '2': 1,
    third: 2, '3rd': 2, three: 2, '3': 2,
    fourth: 3, '4th': 3, four: 3, '4': 3,
    fifth: 4, '5th': 4, five: 4, '5': 4,
  };
  for (const [word, idx] of Object.entries(ordinalMap)) {
    if (cleaned.includes(word) && idx < slots.length) {
      return slots[idx];
    }
  }

  // Try time matching: "9 am", "2:30 pm", "10 o'clock"
  const timeMatch = cleaned.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)?/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const min = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const period = timeMatch[3]?.toLowerCase().replace(/\./g, '');
    if (period === 'pm' && hour < 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
    // If no am/pm and hour <= 6, assume PM (business hours heuristic)
    if (!period && hour >= 1 && hour <= 6) hour += 12;

    // Find closest matching slot
    for (const slot of slots) {
      const slotDate = new Date(slot.start);
      if (slotDate.getUTCHours() === hour && slotDate.getUTCMinutes() === min) return slot;
      // Also check with local offset — display_time may differ
    }
    // Fallback: match display_time text
    const timeStr = `${hour % 12 || 12}:${min.toString().padStart(2, '0')}`;
    for (const slot of slots) {
      if (slot.display_time.toLowerCase().includes(timeStr)) return slot;
    }
  }

  return null;
}

// ── Email Detection ─────────────────────────────────────────────

export function detectEmail(text: string): string | null {
  // Spoken email: "alex at example dot com"
  let cleaned = text.trim().toLowerCase();
  // Normalize spoken patterns
  cleaned = cleaned
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+/g, '');
  const emailMatch = cleaned.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return emailMatch ? emailMatch[0] : null;
}

// ── Reference Code Detection ────────────────────────────────────

export function detectReferenceCode(text: string): string | null {
  const match = text.match(/APT[- ]?([A-Z0-9]{4,8})/i);
  if (match) return `APT-${match[1].toUpperCase()}`;
  return null;
}

// ── Name Detection (simple heuristic) ───────────────────────────

export function detectName(text: string): string | null {
  const cleaned = text.trim();
  // Reject if it looks like it's not a name (too short, or is a question, etc.)
  if (cleaned.length < 2) return null;
  if (/^(yes|no|yeah|nah|um|uh|hmm)\b/i.test(cleaned)) return null;
  // If it looks like "my name is X", extract X
  const nameIsMatch = cleaned.match(/(?:my name is|i'?m|this is|it'?s)\s+(.+)/i);
  if (nameIsMatch) return titleCase(nameIsMatch[1].trim());
  // If 1-3 words and looks like a name, accept
  const words = cleaned.split(/\s+/);
  if (words.length >= 1 && words.length <= 4 && /^[a-z]/i.test(words[0])) {
    return titleCase(cleaned);
  }
  return null;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── SMS Handoff Request Detection ───────────────────────────────

const HANDOFF_PATTERNS: RegExp[] = [
  /\b(text|sms|send)\b.*\b(me|link|message)\b/i,
  /\b(switch|continue|do\s*it)\b.*\b(online|web|website|text|phone|chat)\b/i,
  /\b(can i|let me)\b.*\b(do this|finish|complete)\b.*\b(online|web|text)\b/i,
  /\bsend\s*(me\s*)?a?\s*(text|link|sms)\b/i,
  /\btext\s*me\b/i,
  /\bonline\s*(instead|please|rather)\b/i,
  /\b(just|rather)\s*(text|message)\b/i,
];

/**
 * Detect if the caller is requesting an SMS handoff to web chat.
 * Returns true if the speech matches handoff intent patterns.
 */
export function detectHandoffRequest(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  return HANDOFF_PATTERNS.some((p) => p.test(cleaned));
}
