import { FastifyInstance } from 'fastify';
import { tenantRepo } from '../repos/tenant.repo.js';
import { requireAdminKey } from '../auth/middleware.js';

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/tenants/:id — admin only
  app.get<{ Params: { id: string } }>('/api/tenants/:id', {
    preHandler: requireAdminKey,
  }, async (req, reply) => {
    const tenant = await tenantRepo.findById(req.params.id);
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });
    // Strip OAuth tokens from response
    const { google_oauth_tokens, ...safe } = tenant;
    return safe;
  });

  // POST /api/tenants — admin only
  app.post<{ Body: Record<string, any> }>('/api/tenants', {
    preHandler: requireAdminKey,
  }, async (req, reply) => {
    const { name, slug, timezone, business_hours, services, slot_duration } = req.body;
    if (!name || !timezone || !business_hours) {
      return reply.code(400).send({ error: 'name, timezone, and business_hours are required' });
    }
    const autoSlug = slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const tenant = await tenantRepo.create({
      name,
      slug: autoSlug,
      timezone,
      slot_duration,
      business_hours,
      services: services ?? [],
    });
    return reply.code(201).send(tenant);
  });

  // PATCH /api/tenants/:id — admin only
  app.patch<{ Params: { id: string }; Body: Record<string, any> }>(
    '/api/tenants/:id',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const existing = await tenantRepo.findById(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'Tenant not found' });
      const updated = await tenantRepo.update(req.params.id, req.body);
      return updated;
    },
  );
}
