import { FastifyInstance } from 'fastify';
import { tenantRepo } from '../repos/tenant.repo.js';
import { getCalendarProvider } from '../integrations/calendar/index.js';
import { requireAdminKey, markPublic } from '../auth/middleware.js';

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/tenants/:tenantId/oauth/google — get authorization URL (admin only)
  app.get<{ Params: { tenantId: string } }>(
    '/api/tenants/:tenantId/oauth/google',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const tenant = await tenantRepo.findById(req.params.tenantId);
      if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

      const calendar = getCalendarProvider();
      const url = calendar.getAuthUrl(tenant.id);
      return { authorization_url: url, calendar_mode: calendar.name };
    },
  );

  // GET /api/oauth/google/callback?code=...&state=...
  // Public: Google redirects here after consent — no auth header possible
  app.get<{
    Querystring: { code: string; state: string };
  }>('/api/oauth/google/callback', {
    preHandler: markPublic,
  }, async (req, reply) => {
    const { code, state: tenantId } = req.query;
    if (!code || !tenantId) {
      return reply.code(400).send({ error: 'code and state are required' });
    }

    try {
      const calendar = getCalendarProvider();
      await calendar.handleCallback(code, tenantId);
      return { success: true, message: 'Google Calendar connected.', calendar_mode: calendar.name };
    } catch (err: any) {
      console.error('OAuth callback error:', err);
      return reply.code(500).send({ error: 'Failed to connect Google Calendar.' });
    }
  });
}
