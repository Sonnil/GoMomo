import { addMinutes, eachDayOfInterval, addDays, startOfDay } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import type { Tenant, TimeSlot, AvailabilityResult, AvailabilityHold, BusinessHours } from '../domain/types.js';
import { appointmentRepo } from '../repos/appointment.repo.js';
import { holdRepo } from '../repos/hold.repo.js';
import { auditRepo } from '../repos/audit.repo.js';
import { env } from '../config/env.js';
import { getCalendarProvider } from '../integrations/calendar/index.js';
import {
  getCachedBusyRanges,
  setCachedBusyRanges,
  invalidateTenantCache,
  type BusyRange,
} from '../integrations/calendar/busy-range-cache.js';
import { getNowUTC } from './clock.js';

const DAYS_OF_WEEK = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;

// ── Demo Availability ───────────────────────────────────────────
// Mon–Fri 9:00 AM – 5:00 PM, America/New_York, no holidays.
// Used when DEMO_AVAILABILITY=true to guarantee GUI testing works.
const DEMO_TIMEZONE = 'America/New_York';
const DEMO_SLOT_DURATION = 30; // minutes
const DEMO_LOOKAHEAD_DAYS = 14; // generate up to 14 days out

const DEMO_BUSINESS_HOURS: BusinessHours = {
  monday:    { start: '09:00', end: '17:00' },
  tuesday:   { start: '09:00', end: '17:00' },
  wednesday: { start: '09:00', end: '17:00' },
  thursday:  { start: '09:00', end: '17:00' },
  friday:    { start: '09:00', end: '17:00' },
  saturday:  null,
  sunday:    null,
};

/**
 * Returns true when demo availability mode is active.
 * Conditions: DEMO_AVAILABILITY=true AND no real calendar connected (mock mode).
 */
export function isDemoAvailabilityActive(): boolean {
  return env.DEMO_AVAILABILITY === 'true' && env.CALENDAR_MODE === 'mock';
}

// ── Helper: cached busy-range fetch ─────────────────────────────
/**
 * Fetch Google Calendar busy ranges, with in-memory caching.
 *
 * Flow:
 *  1. Check cache (keyed on tenant + time window, TTL from env).
 *  2. On miss → call calendarProvider.getBusyRanges() → cache the result.
 *  3. Return ranges as epoch-ms pairs ready for the occupied array.
 */
// ── Helper: format epoch range for debug (PII-safe — times only, no titles) ──
function fmtRange(r: { start: number; end: number }): string {
  return `${new Date(r.start).toISOString()} → ${new Date(r.end).toISOString()}`;
}

/**
 * Snapshot of the last calendar-debug run per tenant.
 * Only populated when CALENDAR_DEBUG=true.
 */
export interface CalendarDebugSnapshot {
  tenant_id: string;
  timestamp: string;
  calendar_mode: string;
  oauth_connected: boolean;
  should_read_calendar: boolean;
  busy_ranges_fetched: Array<{ start: string; end: string }>;
  db_appointments_count: number;
  db_holds_count: number;
  total_slots_generated: number;
  slots_excluded_by_busy: number;
  slots_excluded_by_appointments: number;
  slots_excluded_by_holds: number;
  slots_excluded_by_past: number;
  slots_available: number;
  verified: boolean;
  calendar_error?: string;
}

const _debugSnapshots = new Map<string, CalendarDebugSnapshot>();

export function getCalendarDebugSnapshot(tenantId: string): CalendarDebugSnapshot | null {
  return _debugSnapshots.get(tenantId) ?? null;
}

async function fetchBusyRangesWithCache(
  tenant: Tenant,
  from: Date,
  to: Date,
): Promise<BusyRange[]> {
  // Try cache first
  const cached = getCachedBusyRanges(tenant.id, from, to);
  if (cached) return cached;

  // Cache miss — fetch from Google Calendar
  const provider = getCalendarProvider();
  const rawRanges = await provider.getBusyRanges(tenant, from, to);

  // Provider already returns { start: number, end: number } (epoch-ms)
  const busyRanges: BusyRange[] = rawRanges.map((r) => ({
    start: r.start,
    end: r.end,
  }));

  // Cache for next request
  setCachedBusyRanges(tenant.id, from, to, busyRanges);

  return busyRanges;
}

export const availabilityService = {
  /**
   * Get available time slots for a tenant within a date range.
   *
   * Conflict sources (all subtracted from generated slots):
   *   1. Existing appointments (DB)
   *   2. Active holds (DB)
   *   3. Google Calendar busy ranges (external, when CALENDAR_MODE=real + OAuth connected)
   *
   * Returns an AvailabilityResult with:
   *   - slots: the time slots with available/occupied flags
   *   - verified: true when external calendar was successfully cross-referenced
   *
   * Degradation policy (CALENDAR_READ_REQUIRED):
   *   - strict (true):  if calendar read fails → throws CalendarReadError
   *   - lenient (false): if calendar read fails → DB-only slots, verified=false
   */
  async getAvailableSlots(
    tenant: Tenant,
    fromDate: Date,
    toDate: Date,
  ): Promise<AvailabilityResult> {
    const demoMode = isDemoAvailabilityActive();

    // In demo mode, override tenant hours with guaranteed Mon-Fri 9-5 ET
    const tz           = demoMode ? DEMO_TIMEZONE           : tenant.timezone;
    const slotDuration = demoMode ? DEMO_SLOT_DURATION      : tenant.slot_duration;
    const bizHours     = demoMode ? DEMO_BUSINESS_HOURS     : tenant.business_hours;

    // In demo mode, ensure the range always reaches at least DEMO_LOOKAHEAD_DAYS
    // into the future so the AI agent can find upcoming weekday slots even when
    // the user asks about "today" on a weekend.
    let effectiveFrom = fromDate;
    let effectiveTo   = toDate;
    if (demoMode) {
      const now = getNowUTC();
      if (effectiveFrom < now) effectiveFrom = startOfDay(now);
      const minEnd = addDays(now, DEMO_LOOKAHEAD_DAYS);
      if (effectiveTo < minEnd) effectiveTo = minEnd;
    }

    // Get existing appointments and holds in the range
    const [appointments, holds] = await Promise.all([
      appointmentRepo.listByTenantAndRange(tenant.id, effectiveFrom, effectiveTo),
      holdRepo.listByTenantAndRange(tenant.id, effectiveFrom, effectiveTo),
    ]);

    // Build a set of occupied ranges (as epoch pairs for fast lookup)
    const occupied: Array<{ start: number; end: number }> = [];

    for (const apt of appointments) {
      occupied.push({
        start: new Date(apt.start_time).getTime(),
        end: new Date(apt.end_time).getTime(),
      });
    }

    for (const hold of holds) {
      occupied.push({
        start: new Date(hold.start_time).getTime(),
        end: new Date(hold.end_time).getTime(),
      });
    }

    // ── Google Calendar busy-range integration ────────────────
    let verified = true;
    let calendarSource: 'google' | 'db_only' | undefined;
    let calendarError: string | undefined;
    let busyRangesFetched: BusyRange[] = [];

    const shouldReadCalendar =
      env.CALENDAR_MODE === 'real' &&
      !demoMode &&
      tenant.google_oauth_tokens != null;

    if (shouldReadCalendar) {
      try {
        busyRangesFetched = await fetchBusyRangesWithCache(tenant, effectiveFrom, effectiveTo);
        for (const br of busyRangesFetched) {
          occupied.push(br);
        }
        calendarSource = 'google';
        console.log(`[availability] Calendar busy ranges for ${tenant.id}: ${busyRangesFetched.length} range(s)`);

        if (env.CALENDAR_DEBUG === 'true' && busyRangesFetched.length > 0) {
          console.log(`[calendar-debug] Busy ranges for ${tenant.id}:`);
          for (const br of busyRangesFetched) {
            console.log(`  ⏱  ${fmtRange(br)}`);
          }
        }
      } catch (err: any) {
        console.error(`[availability] Calendar read failed for ${tenant.id}:`, err);

        if (env.CALENDAR_READ_REQUIRED === 'true') {
          // Strict mode: refuse to return unverified slots
          throw new CalendarReadError(
            'Cannot check schedule right now — external calendar is unavailable. Please try again in a moment.',
          );
        }

        // Lenient mode: continue with DB-only, mark as unverified
        verified = false;
        calendarSource = 'db_only';
        calendarError = err.message || 'Calendar read failed';
        console.warn(`[availability] Degraded to DB-only for ${tenant.id} (unverified slots)`);
      }
    }

    // ── Debug counters ────────────────────────────────────────
    const isDebug = env.CALENDAR_DEBUG === 'true';
    let dbgTotalGenerated = 0;
    let dbgExBusy = 0;
    let dbgExAppt = 0;
    let dbgExHold = 0;
    let dbgExPast = 0;

    // Pre-split occupied ranges by source for debug attribution
    const apptRanges = appointments.map(a => ({
      start: new Date(a.start_time).getTime(),
      end: new Date(a.end_time).getTime(),
    }));
    const holdRanges = holds.map(h => ({
      start: new Date(h.start_time).getTime(),
      end: new Date(h.end_time).getTime(),
    }));

    // Snapshot "now" once for consistent past-slot filtering
    const nowEpoch = getNowUTC().getTime();

    // Generate slots day by day
    const slots: TimeSlot[] = [];
    const days = eachDayOfInterval({ start: effectiveFrom, end: effectiveTo });

    for (const day of days) {
      const zonedDay = toZonedTime(day, tz);
      const dayOfWeek = DAYS_OF_WEEK[zonedDay.getDay()];
      const hours = bizHours[dayOfWeek as keyof typeof bizHours];

      if (!hours) continue; // Closed on this day

      const [startH, startM] = hours.start.split(':').map(Number);
      const [endH, endM] = hours.end.split(':').map(Number);

      // Build dates whose **local** getters (getHours, getDate, …) carry the
      // intended wall-clock values.  fromZonedTime reads those local getters
      // and interprets them as the specified timezone, then returns the
      // corresponding UTC instant.  Using Date.UTC here would be wrong
      // because fromZonedTime does NOT read getUTCHours().
      const y = zonedDay.getFullYear();
      const mo = zonedDay.getMonth();
      const d = zonedDay.getDate();

      const localStart = fromZonedTime(new Date(y, mo, d, startH, startM, 0), tz);
      const localEnd   = fromZonedTime(new Date(y, mo, d, endH,   endM,   0), tz);

      let cursor = localStart;

      while (cursor.getTime() + slotDuration * 60000 <= localEnd.getTime()) {
        const slotStart = cursor.getTime();
        const slotEnd = slotStart + slotDuration * 60000;
        dbgTotalGenerated++;

        // Don't show past slots
        const isPast = slotStart < nowEpoch;
        if (isPast) {
          dbgExPast++;
          cursor = addMinutes(cursor, slotDuration);
          continue;
        }

        // Check if slot overlaps with any occupied range
        // (appointments + holds + Google Calendar busy times)
        const isOccupied = occupied.some(
          (o) => slotStart < o.end && slotEnd > o.start,
        );

        if (isDebug && isOccupied) {
          // Attribute the exclusion to a specific source
          const hitBusy = busyRangesFetched.some(b => slotStart < b.end && slotEnd > b.start);
          const hitAppt = apptRanges.some(a => slotStart < a.end && slotEnd > a.start);
          const hitHold = holdRanges.some(h => slotStart < h.end && slotEnd > h.start);
          if (hitBusy) dbgExBusy++;
          if (hitAppt) dbgExAppt++;
          if (hitHold) dbgExHold++;

          // Per-slot exclusion log (PII-safe — times only, no names/titles)
          const reasons: string[] = [];
          if (hitBusy) reasons.push('calendar-busy');
          if (hitAppt) reasons.push('db-appointment');
          if (hitHold) reasons.push('db-hold');
          console.log(
            `[calendar-debug] ❌ EXCLUDED ${new Date(slotStart).toISOString()} → ${new Date(slotEnd).toISOString()} (${reasons.join(', ')})`,
          );
        }

        slots.push({
          start: new Date(slotStart).toISOString(),
          end: new Date(slotEnd).toISOString(),
          available: !isOccupied,
        });

        cursor = addMinutes(cursor, slotDuration);
      }
    }

    // ── Calendar debug snapshot ───────────────────────────────
    if (isDebug) {
      const availCount = slots.filter(s => s.available).length;
      const snapshot: CalendarDebugSnapshot = {
        tenant_id: tenant.id,
        timestamp: getNowUTC().toISOString(),
        calendar_mode: env.CALENDAR_MODE,
        oauth_connected: tenant.google_oauth_tokens != null,
        should_read_calendar: shouldReadCalendar,
        busy_ranges_fetched: busyRangesFetched.map(r => ({
          start: new Date(r.start).toISOString(),
          end: new Date(r.end).toISOString(),
        })),
        db_appointments_count: appointments.length,
        db_holds_count: holds.length,
        total_slots_generated: dbgTotalGenerated,
        slots_excluded_by_busy: dbgExBusy,
        slots_excluded_by_appointments: dbgExAppt,
        slots_excluded_by_holds: dbgExHold,
        slots_excluded_by_past: dbgExPast,
        slots_available: availCount,
        verified,
        ...(calendarError && { calendar_error: calendarError }),
      };
      _debugSnapshots.set(tenant.id, snapshot);

      console.log(`[calendar-debug] ${tenant.id}: ${dbgTotalGenerated} generated, ${dbgExPast} past, ${dbgExBusy} busy, ${dbgExAppt} appt, ${dbgExHold} hold → ${availCount} available (verified=${verified})`);
    }

    return { slots, verified, calendarSource, calendarError };
  },

  /**
   * Place a hold on a time slot. Returns the hold or throws if slot is taken.
   */
  async holdSlot(
    tenantId: string,
    sessionId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<AvailabilityHold> {
    try {
      const hold = await holdRepo.create({
        tenant_id: tenantId,
        session_id: sessionId,
        start_time: startTime,
        end_time: endTime,
      });

      await auditRepo.log({
        tenant_id: tenantId,
        event_type: 'hold.created',
        entity_type: 'availability_hold',
        entity_id: hold.id,
        actor: 'ai_agent',
        payload: {
          session_id: sessionId,
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          expires_at: hold.expires_at,
        },
      });

      return hold;
    } catch (error: any) {
      // EXCLUDE constraint violation = slot already held/booked
      if (error.code === '23P01') {
        throw new SlotConflictError('This time slot is no longer available');
      }
      throw error;
    }
  },

  /**
   * Release a hold (e.g., user abandoned the flow).
   */
  async releaseHold(holdId: string, tenantId: string): Promise<void> {
    await holdRepo.delete(holdId);
    await auditRepo.log({
      tenant_id: tenantId,
      event_type: 'hold.released',
      entity_type: 'availability_hold',
      entity_id: holdId,
      actor: 'system',
      payload: null,
    });
  },
};

export class SlotConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotConflictError';
  }
}

export class CalendarReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarReadError';
  }
}
