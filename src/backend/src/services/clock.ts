// ============================================================
// Clock Service — Centralized Time Source
// ============================================================
// Provides a single source of "now" for the entire application.
// All date-dependent logic (system prompt, guardrails, NLU,
// availability) should use this instead of new Date() / Date.now().
//
// Supports:
//  - Tenant-timezone-aware "now" via getNow(timezone)
//  - Test injection via overrideNow() / resetClock()
//  - Raw UTC now via getNowUTC()
// ============================================================

import { toZonedTime } from 'date-fns-tz';
import { format } from 'date-fns';

type NowProvider = () => Date;

let _nowProvider: NowProvider = () => new Date();

// ── Public API ──────────────────────────────────────────────

/**
 * Get the current time as a Date in UTC.
 * Respects any test override set via overrideNow().
 */
export function getNowUTC(): Date {
  return _nowProvider();
}

/**
 * Get the current time as a Date projected into the given IANA timezone.
 * The returned Date's getHours/getMinutes/etc. reflect the wall-clock
 * time in that timezone — suitable for display and day-of-week logic.
 *
 * @example
 *   const etNow = getNow('America/New_York');
 *   etNow.getDay()  // correct day-of-week in ET
 */
export function getNow(timezone: string): Date {
  return toZonedTime(_nowProvider(), timezone);
}

/**
 * Format the current time in a given timezone as a human-readable string.
 * Returns e.g. "Saturday, February 8, 2026 at 3:45 PM EST"
 */
export function formatNow(timezone: string): string {
  const zoned = getNow(timezone);
  return format(zoned, "EEEE, MMMM d, yyyy 'at' h:mm a");
}

/**
 * Get the current date portion only (no time) in a given timezone.
 * Returns e.g. "2026-02-08"
 */
export function getTodayISO(timezone: string): string {
  const zoned = getNow(timezone);
  return format(zoned, 'yyyy-MM-dd');
}

/**
 * Compute the number of calendar days between "now" and a target date,
 * both evaluated in the given timezone.
 *
 * Positive = target is in the future.
 * Negative = target is in the past.
 */
export function daysFromNow(target: Date, timezone: string): number {
  const nowZoned = getNow(timezone);
  const targetZoned = toZonedTime(target, timezone);

  // Strip time components — compare dates only
  const nowDay = new Date(nowZoned.getFullYear(), nowZoned.getMonth(), nowZoned.getDate());
  const targetDay = new Date(targetZoned.getFullYear(), targetZoned.getMonth(), targetZoned.getDate());

  return Math.round((targetDay.getTime() - nowDay.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Test Helpers ────────────────────────────────────────────

/**
 * Override the clock for testing. The provided function will be
 * called instead of `new Date()` whenever getNow/getNowUTC is used.
 *
 * @example
 *   overrideNow(() => new Date('2026-02-08T12:00:00-05:00'));
 *   // ... run tests ...
 *   resetClock();
 */
export function overrideNow(provider: NowProvider): void {
  _nowProvider = provider;
}

/**
 * Reset the clock to use the real system time.
 */
export function resetClock(): void {
  _nowProvider = () => new Date();
}
