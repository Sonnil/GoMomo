/**
 * Calendar Debug Routes — Dev-only introspection endpoints.
 *
 * Only registered when CALENDAR_DEBUG=true.
 * Protected by requireAdminKey — never exposed to end users.
 *
 * GET /api/dev/calendar-debug/:tenantId
 *   → Returns the last CalendarDebugSnapshot for the tenant
 *   → PII-safe: no event titles, no attendee emails — only time ranges
 *
 * GET /api/dev/calendar-debug/:tenantId/connectivity
 *   → Tests live Google Calendar connectivity (freebusy query)
 *   → Returns success/error + sample busy ranges
 *
 * GET /api/debug/availability?date=YYYY-MM-DD&start=HH:mm&end=HH:mm&service=...
 *   → Live availability debug: runs query and returns slots, busy ranges, exclusions
 *   → PII-safe: no event names, no emails, no calendar IDs
 */

import { FastifyInstance } from 'fastify';
import { tenantRepo } from '../repos/tenant.repo.js';
import { getCalendarProvider } from '../integrations/calendar/index.js';
import { getBusyRangeCacheStats } from '../integrations/calendar/busy-range-cache.js';
import { getCalendarDebugSnapshot, availabilityService, CalendarReadError } from '../services/availability.service.js';
import { requireAdminKey } from '../auth/middleware.js';
import { env } from '../config/env.js';
import { fromZonedTime } from 'date-fns-tz';

export async function calendarDebugRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/dev/calendar-debug/:tenantId
   * Returns the last debug snapshot from an availability query.
   */
  app.get<{ Params: { tenantId: string } }>(
    '/api/dev/calendar-debug/:tenantId',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const snapshot = getCalendarDebugSnapshot(req.params.tenantId);
      if (!snapshot) {
        return reply.code(404).send({
          error: 'No debug snapshot available. Run an availability query first with CALENDAR_DEBUG=true.',
        });
      }

      return {
        ...snapshot,
        cache_stats: getBusyRangeCacheStats(),
        env: {
          CALENDAR_MODE: env.CALENDAR_MODE,
          CALENDAR_READ_REQUIRED: env.CALENDAR_READ_REQUIRED,
          CALENDAR_BUSY_CACHE_TTL_SECONDS: env.CALENDAR_BUSY_CACHE_TTL_SECONDS,
          CALENDAR_DEBUG: env.CALENDAR_DEBUG,
        },
      };
    },
  );

  /**
   * GET /api/dev/calendar-debug/:tenantId/connectivity
   * Live connectivity test — calls Google Calendar freebusy for the next 7 days.
   */
  app.get<{ Params: { tenantId: string } }>(
    '/api/dev/calendar-debug/:tenantId/connectivity',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const tenant = await tenantRepo.findById(req.params.tenantId);
      if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

      if (!tenant.google_oauth_tokens) {
        return reply.code(400).send({
          error: 'No OAuth tokens — Google Calendar not connected for this tenant.',
          oauth_url: env.CALENDAR_MODE === 'real'
            ? `GET /api/tenants/${tenant.id}/oauth/google (admin-key required)`
            : 'Set CALENDAR_MODE=real first',
        });
      }

      const provider = getCalendarProvider();
      const now = new Date();
      const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      try {
        const ranges = await provider.getBusyRanges(tenant, now, weekFromNow);
        return {
          status: 'connected',
          calendar_id: tenant.google_calendar_id ?? 'primary',
          provider: provider.name,
          query_window: { from: now.toISOString(), to: weekFromNow.toISOString() },
          busy_ranges: ranges.map(r => ({
            start: new Date(r.start).toISOString(),
            end: new Date(r.end).toISOString(),
          })),
          busy_count: ranges.length,
        };
      } catch (err: any) {
        return reply.code(502).send({
          status: 'error',
          provider: provider.name,
          error: err.message,
          hint: 'Check OAuth tokens, calendar permissions, or network connectivity.',
        });
      }
    },
  );

  /**
   * GET /api/debug/availability
   *
   * Live availability debug — runs a real availability query and returns
   * structured results: generated slots, busy ranges, and per-slot exclusions.
   *
   * Query params:
   *   date      — YYYY-MM-DD (required)
   *   start     — HH:mm, default 00:00
   *   end       — HH:mm, default 23:59
   *   service   — service name (optional)
   *   tenant_id — tenant UUID (optional, defaults to gomomo demo tenant)
   *
   * PII-safe: no event names, no emails, no calendar IDs.
   */
  app.get<{
    Querystring: {
      date: string;
      start?: string;
      end?: string;
      service?: string;
      tenant_id?: string;
    };
  }>(
    '/api/debug/availability',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const {
        date,
        start = '00:00',
        end = '23:59',
        service,
        tenant_id = '00000000-0000-4000-a000-000000000001',
      } = req.query;

      // Validate date
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply.code(400).send({
          error: 'date is required in YYYY-MM-DD format.',
          example: '/api/debug/availability?date=2026-02-09&start=12:00&end=17:00',
        });
      }

      const tenant = await tenantRepo.findById(tenant_id);
      if (!tenant) {
        return reply.code(404).send({ error: `Tenant ${tenant_id} not found.` });
      }

      const tz = tenant.timezone;
      const [startH, startM] = start.split(':').map(Number);
      const [endH, endM] = end.split(':').map(Number);
      const [year, month, day] = date.split('-').map(Number);

      // Build UTC range from wall-clock times in the tenant's timezone
      const fromDate = fromZonedTime(new Date(year, month - 1, day, startH, startM, 0), tz);
      const toDate = fromZonedTime(new Date(year, month - 1, day, endH, endM, 0), tz);

      try {
        const result = await availabilityService.getAvailableSlots(tenant, fromDate, toDate);
        const snapshot = getCalendarDebugSnapshot(tenant_id);

        // Classify slots
        const availableSlots = result.slots.filter(s => s.available);
        const excludedSlots = result.slots.filter(s => !s.available);

        return {
          query: { date, start, end, service: service ?? null, tenant_id, timezone: tz },
          summary: {
            total_slots_generated: result.slots.length,
            available: availableSlots.length,
            excluded: excludedSlots.length,
            verified: result.verified,
            calendar_source: result.calendarSource ?? 'none',
            ...(result.calendarError && { calendar_error: result.calendarError }),
          },
          busy_ranges: snapshot?.busy_ranges_fetched ?? [],
          available_slots: availableSlots.map(s => ({
            start: s.start,
            end: s.end,
          })),
          excluded_slots: excludedSlots.map(s => ({
            start: s.start,
            end: s.end,
            reason: 'busy_overlap',
          })),
          debug_snapshot: snapshot ? {
            slots_excluded_by_busy: snapshot.slots_excluded_by_busy,
            slots_excluded_by_appointments: snapshot.slots_excluded_by_appointments,
            slots_excluded_by_holds: snapshot.slots_excluded_by_holds,
            slots_excluded_by_past: snapshot.slots_excluded_by_past,
          } : null,
        };
      } catch (err: unknown) {
        if (err instanceof CalendarReadError) {
          return reply.code(502).send({
            error: 'Calendar read failed (CALENDAR_READ_REQUIRED=true)',
            detail: (err as CalendarReadError).message,
          });
        }
        throw err;
      }
    },
  );
}
