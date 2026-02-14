import { FastifyInstance } from 'fastify';
import { tenantRepo } from '../repos/tenant.repo.js';
import { bookingService } from '../services/booking.service.js';
import { requireSessionOrAdmin } from '../auth/middleware.js';

export async function appointmentRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/tenants/:tenantId/appointments — confirm booking
  app.post<{
    Params: { tenantId: string };
    Body: {
      session_id: string;
      hold_id: string;
      client_name: string;
      client_email: string;
      client_notes?: string;
      service?: string;
    };
  }>('/api/tenants/:tenantId/appointments', {
    preHandler: requireSessionOrAdmin,
  }, async (req, reply) => {
    const tenant = await tenantRepo.findById(req.params.tenantId);
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    const { session_id, hold_id, client_name, client_email, client_notes, service } = req.body;
    if (!session_id || !hold_id || !client_name || !client_email) {
      return reply.code(400).send({
        error: 'session_id, hold_id, client_name, client_email are required',
      });
    }

    try {
      const appointment = await bookingService.confirmBooking({
        tenant_id: tenant.id,
        session_id,
        hold_id,
        client_name,
        client_email,
        client_notes,
        service,
        timezone: tenant.timezone,
      });
      return reply.code(201).send(appointment);
    } catch (err: any) {
      if (err.constructor?.name === 'BookingError') {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /api/tenants/:tenantId/appointments/lookup?ref=...&email=...
  app.get<{
    Params: { tenantId: string };
    Querystring: { ref?: string; email?: string };
  }>('/api/tenants/:tenantId/appointments/lookup', {
    preHandler: requireSessionOrAdmin,
  }, async (req, reply) => {
    const { ref, email } = req.query;
    if (!ref && !email) {
      return reply.code(400).send({ error: 'ref or email query param is required' });
    }

    const appointments = await bookingService.lookup(req.params.tenantId, {
      reference: ref,
      email,
    });

    return { appointments };
  });

  // POST /api/tenants/:tenantId/appointments/:id/reschedule
  app.post<{
    Params: { tenantId: string; id: string };
    Body: { session_id: string; new_hold_id: string };
  }>('/api/tenants/:tenantId/appointments/:id/reschedule', {
    preHandler: requireSessionOrAdmin,
  }, async (req, reply) => {
    const tenant = await tenantRepo.findById(req.params.tenantId);
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    const { session_id, new_hold_id } = req.body;
    if (!session_id || !new_hold_id) {
      return reply.code(400).send({ error: 'session_id and new_hold_id are required' });
    }

    try {
      const newAppointment = await bookingService.reschedule({
        appointment_id: req.params.id,
        tenant_id: tenant.id,
        session_id,
        new_hold_id,
        timezone: tenant.timezone,
      });
      return newAppointment;
    } catch (err: any) {
      if (err.constructor?.name === 'BookingError') {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  // POST /api/tenants/:tenantId/appointments/:id/cancel
  app.post<{
    Params: { tenantId: string; id: string };
  }>('/api/tenants/:tenantId/appointments/:id/cancel', {
    preHandler: requireSessionOrAdmin,
  }, async (req, reply) => {
    try {
      const cancelled = await bookingService.cancel(req.params.id, req.params.tenantId);
      return cancelled;
    } catch (err: any) {
      if (err.constructor?.name === 'BookingError') {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });
}
