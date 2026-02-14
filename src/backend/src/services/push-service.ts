// ============================================================
// Push Service — Feature 3 (Proactive UI Push)
//
// Singleton that holds the Socket.IO server reference and exposes
// `emitPush()` for workflow tools to push proactive messages to
// active chat sessions.
//
// Architecture:
// 1. Workflow tool completes (e.g. send_waitlist_notification)
// 2. Tool calls pushService.emitPush(sessionId, tenantId, payload)
// 3. Push service: writes to push_events table, then emits via
//    Socket.IO to the `session:<sessionId>` room
// 4. If no client is connected, the DB row persists for REST polling
// ============================================================

import type { Server as SocketIOServer } from 'socket.io';
import { pushEventRepo } from '../repos/push-event.repo.js';
import { auditRepo } from '../repos/audit.repo.js';
import { redactPII } from '../orchestrator/redact.js';
import type { PushEventPayload, PushEventType, PushEvent } from '../domain/types.js';

let io: SocketIOServer | null = null;

export const pushService = {
  /**
   * Initialize the push service with the Socket.IO server instance.
   * Called once at startup in index.ts after creating io.
   */
  init(server: SocketIOServer): void {
    io = server;
    console.log('[push-service] Initialized — proactive push delivery enabled');
  },

  /**
   * Push a proactive event to a chat session.
   *
   * 1. Checks cooldown (prevent duplicate pushes within 60s)
   * 2. Persists to push_events table (delivery guarantee)
   * 3. Emits to the session room via Socket.IO
   * 4. Writes a PII-redacted audit log entry
   *
   * Returns the created PushEvent, or null if blocked by cooldown.
   */
  async emitPush(
    sessionId: string,
    tenantId: string,
    type: PushEventType,
    payload: PushEventPayload,
  ): Promise<PushEvent | null> {
    // Guard: cooldown check
    const inCooldown = await pushEventRepo.checkCooldown(sessionId, type);
    if (inCooldown) {
      console.log(`[push-service] Cooldown active for session=${sessionId.slice(0, 12)} type=${type} — skipping`);
      return null;
    }

    // 1. Persist to DB (delivery guarantee + REST fallback)
    const pushEvent = await pushEventRepo.insert({
      tenant_id: tenantId,
      session_id: sessionId,
      type,
      payload,
    });

    // 2. Emit via Socket.IO if available
    if (io) {
      const room = `session:${sessionId}`;
      io.to(room).emit('push', {
        id: pushEvent.id,
        type: pushEvent.type,
        payload: pushEvent.payload,
        created_at: pushEvent.created_at,
      });

      // Mark as delivered (client is presumed connected if room has sockets)
      const sockets = await io.in(room).fetchSockets();
      if (sockets.length > 0) {
        await pushEventRepo.markDelivered(pushEvent.id);
      }
    }

    // 3. Audit log (PII-redacted)
    await auditRepo.log({
      tenant_id: tenantId,
      event_type: `push.${type}`,
      entity_type: 'push_event',
      entity_id: pushEvent.id,
      actor: 'orchestrator',
      payload: redactPII({
        session_id: sessionId,
        type,
        delivered: io ? true : false,
        payload_summary: payload.message,
      }),
    });

    console.log(`[push-service] Push emitted: type=${type} session=${sessionId.slice(0, 12)} id=${pushEvent.id.slice(0, 8)}`);
    return pushEvent;
  },

  /**
   * Deliver any pending push events to a session that just (re)connected.
   * Called from the socket 'join' handler to catch up missed pushes.
   */
  async deliverPending(sessionId: string): Promise<void> {
    if (!io) return;

    const pending = await pushEventRepo.findPending(sessionId);
    if (pending.length === 0) return;

    const room = `session:${sessionId}`;
    for (const event of pending) {
      io.to(room).emit('push', {
        id: event.id,
        type: event.type,
        payload: event.payload,
        created_at: event.created_at,
      });
      await pushEventRepo.markDelivered(event.id);
    }

    console.log(`[push-service] Delivered ${pending.length} pending push(es) to session=${sessionId.slice(0, 12)}`);
  },

  /** Check if the service is initialized. */
  isReady(): boolean {
    return io !== null;
  },
};
