// ============================================================
// Autonomy API Routes
//
// GET  /api/autonomy          — Runtime status
// GET  /api/autonomy/events   — Recent domain events
// GET  /api/autonomy/jobs     — Upcoming/recent jobs
// GET  /api/autonomy/policies — Active policy rules
// PATCH /api/autonomy/policies/:id — Update a policy rule
// GET  /api/autonomy/workflows — Workflow activity summary
// GET  /api/autonomy/waitlist  — Waitlist entries
//
// All routes require admin API key.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { getAutonomyStatus, eventBus } from '../orchestrator/orchestrator.js';
import { jobRepo } from '../repos/job.repo.js';
import { policyRepo } from '../repos/policy.repo.js';
import { waitlistRepo } from '../repos/waitlist.repo.js';
import { requireAdminKey } from '../auth/middleware.js';

export async function autonomyRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/autonomy — runtime status ────────────────────
  app.get('/api/autonomy', {
    preHandler: requireAdminKey,
  }, async (_req, reply) => {
    return reply.send(getAutonomyStatus());
  });

  // ── GET /api/autonomy/events — recent domain events ───────
  app.get('/api/autonomy/events', {
    preHandler: requireAdminKey,
  }, async (_req, reply) => {
    return reply.send(eventBus.getRecentEvents());
  });

  // ── GET /api/autonomy/jobs — list jobs ────────────────────
  app.get<{ Querystring: { tenant_id?: string; status?: string; limit?: string } }>(
    '/api/autonomy/jobs',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const tenantId = req.query.tenant_id;
      const status = req.query.status as import('../domain/types.js').JobStatus | undefined;
      const limit = parseInt(req.query.limit ?? '50', 10);

      if (tenantId) {
        const jobs = await jobRepo.listByTenant(tenantId, { status, limit });
        return reply.send(jobs);
      }

      // If no tenant_id, return upcoming jobs across tenants
      const upcoming = await jobRepo.listUpcoming(limit);
      return reply.send(
        status ? upcoming.filter((j) => j.status === status) : upcoming,
      );
    },
  );

  // ── GET /api/autonomy/jobs/stats — job queue stats ────────
  app.get('/api/autonomy/jobs/stats', {
    preHandler: requireAdminKey,
  }, async (_req, reply) => {
    const stats = await jobRepo.countByStatus();
    return reply.send(stats);
  });

  // ── GET /api/autonomy/policies — list all policy rules ────
  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/autonomy/policies',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const rules = await policyRepo.list(req.query.tenant_id ?? undefined);
      return reply.send(rules);
    },
  );

  // ── PATCH /api/autonomy/policies/:id — update rule ────────
  app.patch<{
    Params: { id: string };
    Body: { effect?: 'allow' | 'deny'; is_active?: boolean; conditions?: Record<string, unknown> };
  }>('/api/autonomy/policies/:id', {
    preHandler: requireAdminKey,
  }, async (req, reply) => {
    const { id } = req.params;
    const updates: Record<string, unknown> = {};

    if (req.body.effect !== undefined) updates.effect = req.body.effect;
    if (req.body.is_active !== undefined) updates.is_active = req.body.is_active;
    if (req.body.conditions !== undefined) updates.conditions = req.body.conditions;

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'No updates provided.' });
    }

    const updated = await policyRepo.update(id, updates);
    if (!updated) {
      return reply.status(404).send({ error: 'Policy rule not found.' });
    }

    return reply.send(updated);
  });

  // ── GET /api/autonomy/waitlist — waitlist entries ─────────
  app.get<{ Querystring: { tenant_id?: string; status?: string; limit?: string } }>(
    '/api/autonomy/waitlist',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const tenantId = req.query.tenant_id;
      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_id is required.' });
      }
      const status = req.query.status as any;
      const limit = parseInt(req.query.limit ?? '50', 10);
      const entries = await waitlistRepo.listByTenant(tenantId, { status, limit });
      return reply.send(entries);
    },
  );

  // ── GET /api/autonomy/workflows — workflow activity summary ─
  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/autonomy/workflows',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const tenantId = req.query.tenant_id;
      if (!tenantId) {
        return reply.status(400).send({ error: 'tenant_id is required.' });
      }

      // Gather workflow stats in parallel
      const [waitlistCount, jobStats, recentEvents] = await Promise.all([
        waitlistRepo.countWaiting(tenantId),
        jobRepo.countByStatus(),
        Promise.resolve(eventBus.getRecentEvents()),
      ]);

      // Count workflow-specific jobs from recent events
      const workflowEvents = recentEvents.filter(
        (e: any) => e.tenant_id === tenantId,
      );

      return reply.send({
        waitlist: { waiting: waitlistCount },
        jobs: jobStats,
        recent_workflow_events: workflowEvents.length,
        workflows: {
          hold_followup: workflowEvents.filter((e: any) => e.name === 'HoldExpired').length,
          slot_opened: workflowEvents.filter((e: any) => e.name === 'SlotOpened').length,
          calendar_retries: workflowEvents.filter((e: any) => e.name === 'CalendarWriteFailed').length,
          calendar_escalations: workflowEvents.filter((e: any) => e.name === 'CalendarRetryExhausted').length,
        },
      });
    },
  );
}
