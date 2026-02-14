// ============================================================
// Quiet Hours — Determines if the current time falls within
// a tenant's quiet hours (no outbound SMS allowed).
//
// Pure functions that take tenant config and a reference time.
// Uses date-fns-tz for timezone-aware comparisons.
//
// Default quiet hours: 21:00–08:00 (tenant-local timezone).
// Spans midnight: 21:00 → 23:59 and 00:00 → 08:00.
// ============================================================

import { toZonedTime } from 'date-fns-tz';
import { addDays, setHours, setMinutes, setSeconds, setMilliseconds } from 'date-fns';

export interface QuietHoursConfig {
  /** Start of quiet hours, HH:mm (e.g. '21:00') */
  start: string;
  /** End of quiet hours, HH:mm (e.g. '08:00') */
  end: string;
  /** IANA timezone (e.g. 'America/New_York') */
  timezone: string;
}

/** Default quiet hours: 9 PM – 8 AM */
export const DEFAULT_QUIET_HOURS: Omit<QuietHoursConfig, 'timezone'> = {
  start: '21:00',
  end: '08:00',
};

/**
 * Parse "HH:mm" into { hours, minutes }.
 */
function parseHHMM(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hours: h ?? 0, minutes: m ?? 0 };
}

/**
 * Get the current local time-of-day as total minutes since midnight.
 */
function localMinutesSinceMidnight(now: Date, timezone: string): number {
  const local = toZonedTime(now, timezone);
  return local.getHours() * 60 + local.getMinutes();
}

/**
 * Check whether a given UTC time falls within a tenant's quiet hours.
 *
 * Handles overnight spans (e.g. 21:00 → 08:00) correctly.
 * Returns true if the time is within quiet hours (no sending allowed).
 */
export function isQuietHours(
  now: Date,
  config: QuietHoursConfig,
): boolean {
  const { start, end, timezone } = config;
  const startParsed = parseHHMM(start);
  const endParsed = parseHHMM(end);
  const startMin = startParsed.hours * 60 + startParsed.minutes;
  const endMin = endParsed.hours * 60 + endParsed.minutes;

  const currentMin = localMinutesSinceMidnight(now, timezone);

  if (startMin < endMin) {
    // Same-day range (e.g. 13:00–17:00)
    return currentMin >= startMin && currentMin < endMin;
  }

  // Overnight range (e.g. 21:00–08:00)
  return currentMin >= startMin || currentMin < endMin;
}

/**
 * Calculate the next allowed send time (the first minute after quiet hours end).
 *
 * If it's currently quiet hours, returns the next occurrence of `end` in the
 * tenant's local timezone, converted back to UTC.
 *
 * If it's NOT quiet hours, returns `now` (send immediately).
 */
export function nextAllowedSendTime(
  now: Date,
  config: QuietHoursConfig,
): Date {
  if (!isQuietHours(now, config)) {
    return now;
  }

  const { end, timezone } = config;
  const endParsed = parseHHMM(end);

  // Get "today" in the tenant's local timezone
  const local = toZonedTime(now, timezone);

  // Build "today at quiet-hours-end" in local time
  let target = setMilliseconds(setSeconds(setMinutes(setHours(local, endParsed.hours), endParsed.minutes), 0), 0);

  // If we're past the end time today (we're in the evening part of an overnight range),
  // the next window open is tomorrow at the end time.
  if (target <= local) {
    target = addDays(target, 1);
  }

  // Convert the local target back to a UTC Date.
  // Use the difference between now-UTC and now-local to estimate the offset.
  const nowUtcMs = now.getTime();
  const nowLocalMs = local.getTime();
  const offsetMs = nowLocalMs - nowUtcMs;

  // The target in UTC is approximately: target-local-ms minus the offset
  const targetUtcMs = target.getTime() - offsetMs;

  return new Date(targetUtcMs);
}

/**
 * Build a QuietHoursConfig from a tenant object.
 * Falls back to defaults if the tenant doesn't have quiet hours set.
 */
export function tenantQuietHours(tenant: {
  timezone: string;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
}): QuietHoursConfig {
  return {
    start: tenant.quiet_hours_start ?? DEFAULT_QUIET_HOURS.start,
    end: tenant.quiet_hours_end ?? DEFAULT_QUIET_HOURS.end,
    timezone: tenant.timezone,
  };
}
