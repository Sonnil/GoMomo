import { FastifyInstance } from 'fastify';
import { tenantRepo } from '../repos/tenant.repo.js';
import { availabilityService } from '../services/availability.service.js';
import { requireSessionOrAdmin } from '../auth/middleware.js';

export async function availabilityRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/tenants/:tenantId/availability?start=...&end=...
  app.get<{
    Params: { tenantId: string };
    Querystring: { start: string; end: string };
  }>('/api/tenants/:tenantId/availability', {
    preHandler: requireSessionOrAdmin,
  }, async (req, reply) => {
    const tenant = await tenantRepo.findById(req.params.tenantId);
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    const { start, end } = req.query;
    if (!start || !end) {
      return reply.code(400).send({ error: 'start and end query params are required' });
    }

    const from = new Date(start);
    const to = new Date(end);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return reply.code(400).send({ error: 'Invalid date format. Use ISO-8601.' });
    }

    const result = await availabilityService.getAvailableSlots(tenant, from, to);
    return {
      timezone: tenant.timezone,
      slots: result.slots,
      verified: result.verified,
      ...(result.calendarSource && { calendar_source: result.calendarSource }),
      ...(result.calendarError && { calendar_error: result.calendarError }),
    };
  });

  // POST /api/tenants/:tenantId/holds
  app.post<{
    Params: { tenantId: string };
    Body: { session_id: string; start_time: string; end_time: string };
  }>('/api/tenants/:tenantId/holds', {
    preHandler: requireSessionOrAdmin,
  }, async (req, reply) => {
    const tenant = await tenantRepo.findById(req.params.tenantId);
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    const { session_id, start_time, end_time } = req.body;
    if (!session_id || !start_time || !end_time) {
      return reply.code(400).send({ error: 'session_id, start_time, end_time are required' });
    }

    try {
      const hold = await availabilityService.holdSlot(
        tenant.id,
        session_id,
        new Date(start_time),
        new Date(end_time),
      );
      return reply.code(201).send(hold);
    } catch (err: any) {
      if (err.constructor?.name === 'SlotConflictError') {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });
}
