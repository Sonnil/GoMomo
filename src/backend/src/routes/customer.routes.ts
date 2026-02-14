// ============================================================
// Customer Identity Routes
//
// Privacy-first: supports soft-delete (GDPR),
// and minimal customer info retrieval.
// All routes require admin API key (PII management).
// ============================================================

import { FastifyInstance } from 'fastify';
import { customerRepo } from '../repos/customer.repo.js';
import { customerService } from '../services/customer.service.js';
import { requireAdminKey } from '../auth/middleware.js';

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/customers/:id — retrieve customer (admin only)
  app.get<{ Params: { id: string } }>(
    '/api/customers/:id',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const customer = await customerRepo.findById(req.params.id);
      if (!customer) return reply.code(404).send({ error: 'Customer not found' });

      // Return only safe fields (no raw PII in API responses)
      return {
        id: customer.id,
        tenant_id: customer.tenant_id,
        display_name: customer.display_name,
        preferences: customer.preferences,
        booking_count: customer.booking_count,
        last_seen_at: customer.last_seen_at,
        created_at: customer.created_at,
      };
    },
  );

  // DELETE /api/customers/:id — soft-delete (GDPR / privacy request, admin only)
  app.delete<{ Params: { id: string } }>(
    '/api/customers/:id',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const customer = await customerRepo.findById(req.params.id);
      if (!customer) return reply.code(404).send({ error: 'Customer not found' });

      const deleted = await customerService.deleteCustomer(req.params.id);
      if (!deleted) return reply.code(500).send({ error: 'Failed to delete customer' });

      return { status: 'deleted', customer_id: req.params.id };
    },
  );

  // PATCH /api/customers/:id/preferences — update preferences (admin only)
  app.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>('/api/customers/:id/preferences', {
    preHandler: requireAdminKey,
  }, async (req, reply) => {
    const customer = await customerRepo.findById(req.params.id);
    if (!customer) return reply.code(404).send({ error: 'Customer not found' });

    await customerRepo.updatePreferences(req.params.id, req.body as any);
    const updated = await customerRepo.findById(req.params.id);
    return { preferences: updated?.preferences };
  });
}
