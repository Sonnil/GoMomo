// ============================================================
// Event Bus — Typed, In-Process Domain Event Dispatcher
//
// Features:
//   - Strongly typed via DomainEventMap
//   - Auto-audit: every emitted event → audit_log (PII-redacted)
//   - Async subscribers (errors are caught, logged, never crash)
//   - Introspection: listenerCount(), eventLog() for debugging
// ============================================================

import { EventEmitter } from 'node:events';
import type { DomainEvent, DomainEventName, DomainEventMap } from '../domain/events.js';
import { auditRepo } from '../repos/audit.repo.js';
import { redactPII } from './redact.js';

type EventHandler<E extends DomainEvent> = (event: E) => void | Promise<void>;

export class DomainEventBus {
  private emitter = new EventEmitter();
  private recentEvents: Array<{ name: string; timestamp: string; tenant_id: string }> = [];
  private maxRecentEvents = 200;

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  /**
   * Subscribe to a domain event.
   * Handler errors are caught and logged — they never crash the bus.
   */
  on<K extends DomainEventName>(
    eventName: K,
    handler: EventHandler<DomainEventMap[K]>,
  ): void {
    this.emitter.on(eventName, async (event: DomainEventMap[K]) => {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[event-bus] Handler error for ${eventName}:`, err);
      }
    });
  }

  /**
   * Emit a domain event.
   * Automatically writes a PII-redacted audit log entry.
   */
  async emit<E extends DomainEvent>(event: E): Promise<void> {
    // Track recent events for introspection
    this.recentEvents.push({
      name: event.name,
      timestamp: event.timestamp,
      tenant_id: event.tenant_id,
    });
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.shift();
    }

    // Auto-audit: PII-redacted log entry
    try {
      const redactedPayload = redactPII(event as unknown as Record<string, unknown>);
      await auditRepo.log({
        tenant_id: event.tenant_id,
        event_type: `domain.${event.name}`,
        entity_type: 'event',
        entity_id: null,
        actor: 'event_bus',
        payload: redactedPayload,
      });
    } catch (err) {
      console.error(`[event-bus] Audit log failed for ${event.name}:`, err);
    }

    // Dispatch to all listeners
    this.emitter.emit(event.name, event);
  }

  /**
   * Number of listeners for a given event.
   */
  listenerCount(eventName: DomainEventName): number {
    return this.emitter.listenerCount(eventName);
  }

  /**
   * Recent event log (for debugging / UI introspection).
   */
  getRecentEvents(): Array<{ name: string; timestamp: string; tenant_id: string }> {
    return [...this.recentEvents];
  }

  /**
   * Remove all listeners. Used in tests and shutdown.
   */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

// Singleton — imported by orchestrator and services
export const eventBus = new DomainEventBus();
