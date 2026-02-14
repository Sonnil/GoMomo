// ============================================================
// Push Event Routes — Feature 3 (REST Polling Fallback)
//
// GET /api/sessions/:sessionId/push-events
//   Returns undelivered push events for a session.
//   Marks them as delivered after returning.
//   Used by REST-mode clients that don't have WebSocket.
//
// Requires session token (whose sid matches :sessionId) or admin key.
// ============================================================

import type { FastifyInstance } from 'fastify';
import { pushEventRepo } from '../repos/push-event.repo.js';
import { requireSessionOrAdmin } from '../auth/middleware.js';
import { isAuthEnforced } from '../auth/middleware.js';

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/sessions/:sessionId/push-events
   * Returns pending (undelivered) push events for the given session.
   * After returning them, marks them all as delivered.
   */
  app.get<{
    Params: { sessionId: string };
  }>('/api/sessions/:sessionId/push-events', {
    preHandler: requireSessionOrAdmin,
  }, async (request, reply) => {
    const { sessionId } = request.params;

    if (!sessionId || sessionId.length < 5) {
      return reply.status(400).send({ error: 'Invalid session ID.' });
    }

    // If authed with a session token, verify session ownership
    const tokenPayload = (request as any).sessionToken;
    if (isAuthEnforced() && tokenPayload && tokenPayload.sid !== sessionId) {
      return reply.status(403).send({ error: 'Token session does not match requested session.' });
    }

    const pending = await pushEventRepo.findPending(sessionId);

    // Mark all as delivered (they've now been fetched)
    if (pending.length > 0) {
      await pushEventRepo.markAllDelivered(sessionId);
    }

    return {
      session_id: sessionId,
      events: pending.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        created_at: e.created_at,
      })),
    };
  });
}
