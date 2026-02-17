// ============================================================
// Datetime Resolver — Deterministic Date/Time for Booking
// ============================================================
// Converts relative time expressions ("today at 3pm", "tomorrow
// at 10am", "next monday at 2") into absolute ISO-8601 strings
// BEFORE the LLM / booking-availability logic runs.
//
// Used ONLY for booking-related intents (BOOK_DEMO).
//
// Inputs:
//   • userMessage — raw utterance
//   • clientMeta  — { client_now_iso, client_tz, ... }
//   • businessHours — tenant's weekly schedule
//
// Output:
//   • { start_iso, end_iso?, confidence, reasons }
//
// Dependencies: date-fns + date-fns-tz (already in project),
//               clock.ts (getNow, getNowUTC).
// ============================================================

import { addDays, setHours, setMinutes, setSeconds, setMilliseconds, nextDay } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import { getNow } from '../services/clock.js';
import type { BusinessHours, DayHours } from '../domain/types.js';

// ── Public Types ────────────────────────────────────────────

export interface DatetimeResolverInput {
  /** Raw user message to parse. */
  userMessage: string;
  /** Client-side metadata from the widget. */
  clientMeta?: {
    client_now_iso?: string;
    client_tz?: string;
    client_utc_offset_minutes?: number;
    locale?: string;
  };
  /** Tenant timezone (IANA). Fallback when clientMeta.client_tz is missing. */
  tenantTimezone: string;
  /** Tenant business hours for boundary clamping. */
  businessHours?: BusinessHours;
}

export interface DatetimeResolverResult {
  /** Resolved start time as ISO-8601 string in UTC. */
  start_iso: string;
  /** Optional end time (e.g. +1hr from start). */
  end_iso?: string;
  /** Confidence level. */
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable reasons for how we resolved. */
  reasons: string[];
}

// ── Day-name mapping ────────────────────────────────────────

const DAY_NAMES: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** Maps JS Date.getDay() (0=Sun) to BusinessHours key. */
const DAY_INDEX_TO_KEY: (keyof BusinessHours)[] = [
  'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday',
];

// ── Regex Patterns ──────────────────────────────────────────

// Relative day: "today", "tomorrow", "day after tomorrow"
const TODAY_RE = /\btoday\b/i;
const TOMORROW_RE = /\btomorrow\b/i;
const DAY_AFTER_TOMORROW_RE = /\bday\s+after\s+tomorrow\b/i;

// Named day: "next monday", "this friday", "on wednesday"
const NEXT_DAY_RE = /\b(?:next|this|on)\s+(sunday|sun|monday|mon|tuesday|tue(?:s)?|wednesday|wed|thursday|thu(?:r)?(?:s)?|friday|fri|saturday|sat)\b/i;

// Standalone day name (without "next"/"this"): "monday at 2pm"
const BARE_DAY_RE = /\b(sunday|sun|monday|mon|tuesday|tue(?:s)?|wednesday|wed|thursday|thu(?:r)?(?:s)?|friday|fri|saturday|sat)\b/i;

// Time extraction: "at 3pm", "at 10:30am", "at 14:00", "3 pm", "10am"
const TIME_RE = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?\b/;

// Time-of-day periods: "this morning", "this afternoon", "this evening"
const MORNING_RE = /\b(?:this\s+)?morning\b/i;
const AFTERNOON_RE = /\b(?:this\s+)?afternoon\b/i;
const EVENING_RE = /\b(?:this\s+)?evening\b/i;

// ── Main Resolver ───────────────────────────────────────────

/**
 * Attempt to resolve a date/time expression from a user message.
 *
 * Returns `null` if no recognisable date/time expression is found
 * (the LLM should handle it as free-form text).
 */
export function resolveDatetime(
  input: DatetimeResolverInput,
): DatetimeResolverResult | null {
  const { userMessage, clientMeta, tenantTimezone, businessHours } = input;
  const msg = userMessage.trim();

  // Determine the reference timezone (prefer client, fallback to tenant)
  const tz = resolveTimezone(clientMeta?.client_tz, tenantTimezone);

  // Determine "now" in the reference timezone
  const nowZoned = getNow(tz);

  // ── Step 1: Resolve the DATE part ─────────────────────────
  const dateResult = resolveDate(msg, nowZoned);
  if (!dateResult) {
    // No recognisable date expression → let LLM handle it
    return null;
  }

  // ── Step 2: Resolve the TIME part ─────────────────────────
  const timeResult = resolveTime(msg);

  // ── Step 3: Combine date + time ───────────────────────────
  let resolvedZoned: Date;
  const reasons: string[] = [...dateResult.reasons];
  let confidence: 'high' | 'medium' | 'low' = dateResult.confidence;

  if (timeResult) {
    // Explicit time provided
    resolvedZoned = applyTime(dateResult.date, timeResult.hours, timeResult.minutes);
    reasons.push(...timeResult.reasons);
    // If both date and time are explicit, confidence stays high
  } else {
    // No explicit time — check for period-of-day keywords
    const periodResult = resolvePeriodOfDay(msg, businessHours, dateResult.date);
    if (periodResult) {
      resolvedZoned = periodResult.date;
      reasons.push(...periodResult.reasons);
      confidence = 'medium';
    } else {
      // No time at all — only a date was mentioned.
      // Return null: we have a date but no time, insufficient for booking.
      // The LLM should ask the user for a preferred time.
      return null;
    }
  }

  // ── Step 4: Convert to UTC ISO ────────────────────────────
  const utcDate = fromZonedTime(resolvedZoned, tz);
  const start_iso = utcDate.toISOString();

  // ── Step 5: Default end time (+1 hour) ────────────────────
  const endUtc = new Date(utcDate.getTime() + 60 * 60 * 1000);
  const end_iso = endUtc.toISOString();

  reasons.push(`timezone=${tz}`);

  return { start_iso, end_iso, confidence, reasons };
}

// ── Date Resolution ─────────────────────────────────────────

interface DateResolveResult {
  date: Date;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
}

function resolveDate(msg: string, nowZoned: Date): DateResolveResult | null {
  // Order matters: check most specific first

  // "day after tomorrow"
  if (DAY_AFTER_TOMORROW_RE.test(msg)) {
    const d = addDays(stripTime(nowZoned), 2);
    return { date: d, confidence: 'high', reasons: ['date=day_after_tomorrow'] };
  }

  // "today"
  if (TODAY_RE.test(msg)) {
    return { date: stripTime(nowZoned), confidence: 'high', reasons: ['date=today'] };
  }

  // "tomorrow"
  if (TOMORROW_RE.test(msg)) {
    const d = addDays(stripTime(nowZoned), 1);
    return { date: d, confidence: 'high', reasons: ['date=tomorrow'] };
  }

  // "next monday", "this friday", "on wednesday"
  const nextDayMatch = msg.match(NEXT_DAY_RE);
  if (nextDayMatch) {
    const dayName = nextDayMatch[1].toLowerCase();
    const targetDay = findDayNumber(dayName);
    if (targetDay !== null) {
      const d = nextDay(stripTime(nowZoned), targetDay);
      return { date: d, confidence: 'high', reasons: [`date=next_${dayName}`] };
    }
  }

  // Bare day name without "next"/"this": "monday at 2pm"
  // Only match if there's also a time component (otherwise it's ambiguous)
  const bareDayMatch = msg.match(BARE_DAY_RE);
  if (bareDayMatch && TIME_RE.test(msg)) {
    const dayName = bareDayMatch[1].toLowerCase();
    const targetDay = findDayNumber(dayName);
    if (targetDay !== null) {
      const currentDay = nowZoned.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
      let d: Date;
      if (targetDay === currentDay) {
        // Same day — use today
        d = stripTime(nowZoned);
      } else {
        d = nextDay(stripTime(nowZoned), targetDay);
      }
      return { date: d, confidence: 'medium', reasons: [`date=bare_${dayName}`] };
    }
  }

  return null;
}

// ── Time Resolution ─────────────────────────────────────────

interface TimeResolveResult {
  hours: number;
  minutes: number;
  reasons: string[];
}

function resolveTime(msg: string): TimeResolveResult | null {
  const match = msg.match(TIME_RE);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();

  // Validate basic ranges
  if (hours > 23 || minutes > 59) return null;

  if (meridiem === 'pm' && hours < 12) {
    hours += 12;
  } else if (meridiem === 'am' && hours === 12) {
    hours = 0;
  } else if (!meridiem && hours >= 1 && hours <= 7) {
    // Ambiguous: "at 3" with no am/pm — assume PM for business context
    hours += 12;
    return { hours, minutes, reasons: [`time=${hours}:${pad(minutes)} (assumed PM)`] };
  }

  return { hours, minutes, reasons: [`time=${pad(hours)}:${pad(minutes)}`] };
}

// ── Period-of-Day Resolution ────────────────────────────────

interface PeriodResult {
  date: Date;
  reasons: string[];
}

function resolvePeriodOfDay(
  msg: string,
  businessHours: BusinessHours | undefined,
  baseDate: Date,
): PeriodResult | null {
  if (MORNING_RE.test(msg)) {
    // Morning = business open time or 09:00
    const openHour = getBusinessOpenHour(businessHours, baseDate) ?? 9;
    return {
      date: applyTime(baseDate, openHour, 0),
      reasons: ['period=morning', `time=${pad(openHour)}:00`],
    };
  }

  if (AFTERNOON_RE.test(msg)) {
    return {
      date: applyTime(baseDate, 14, 0),
      reasons: ['period=afternoon', 'time=14:00'],
    };
  }

  if (EVENING_RE.test(msg)) {
    return {
      date: applyTime(baseDate, 17, 0),
      reasons: ['period=evening', 'time=17:00'],
    };
  }

  return null;
}

// ── Utility Functions ───────────────────────────────────────

/**
 * Determine the best timezone to use.
 * Prefers client timezone if it's a valid IANA string.
 */
function resolveTimezone(clientTz?: string, tenantTz?: string): string {
  if (clientTz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: clientTz });
      return clientTz;
    } catch {
      // Invalid IANA — fall through
    }
  }
  return tenantTz || 'UTC';
}

/** Zero out the time components of a Date (keep year/month/day). */
function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Set specific hour/minute on a date, zero seconds + ms. */
function applyTime(d: Date, hours: number, minutes: number): Date {
  return setMilliseconds(setSeconds(setMinutes(setHours(d, hours), minutes), 0), 0);
}

/** Look up day-of-week number from a name string. */
function findDayNumber(name: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 | null {
  const n = name.toLowerCase();
  // Check exact, then check abbreviation prefixes
  if (n in DAY_NAMES) return DAY_NAMES[n];
  // Try partial match (e.g. "thur" → thursday)
  for (const [key, val] of Object.entries(DAY_NAMES)) {
    if (key.startsWith(n) || n.startsWith(key)) return val as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  }
  return null;
}

/** Get the business opening hour for a given date, or null if closed. */
function getBusinessOpenHour(
  bh: BusinessHours | undefined,
  date: Date,
): number | null {
  if (!bh) return null;
  const dayKey = DAY_INDEX_TO_KEY[date.getDay()];
  const hours: DayHours | null | undefined = bh[dayKey];
  if (!hours) return null;
  const [h] = hours.start.split(':').map(Number);
  return h;
}

/** Pad a number to 2 digits. */
function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
