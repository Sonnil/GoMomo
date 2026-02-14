// ============================================================
// Orchestrator — Central Wiring for Autonomous Agent Runtime
//
// Subscribes to domain events, evaluates policies, enqueues
// jobs, and coordinates the job runner. This is the "brain"
// of the agent runtime.
//
// Lifecycle: initOrchestrator() → ... → shutdownOrchestrator()
// ============================================================

import { env } from '../config/env.js';
import { eventBus } from './event-bus.js';
import { createJobRunner, getJobRunner } from './job-runner.js';
import { getTool, listRegisteredTools } from './registered-tools.js';
import { onBookingCreated } from './handlers/on-booking-created.js';
import { onBookingCancelled } from './handlers/on-booking-cancelled.js';
import { onBookingRescheduled } from './handlers/on-booking-rescheduled.js';
import { onHoldExpired } from './handlers/on-hold-expired.js';
import { onCalendarWriteFailed } from './handlers/on-calendar-write-failed.js';
import { onSlotOpened } from './handlers/on-slot-opened.js';
import { onCalendarRetryExhausted } from './handlers/on-calendar-retry-exhausted.js';

// Re-export for convenience
export { eventBus } from './event-bus.js';
export { policyEngine } from './policy-engine.js';
export { listRegisteredTools } from './registered-tools.js';
export { getJobRunner } from './job-runner.js';

let initialized = false;
let outboxPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the orchestrator:
 * 1. Register event handlers
 * 2. Wire job runner executors (mapping job types → registered tools)
 * 3. Start the job runner (if autonomy is enabled)
 */
export async function initOrchestrator(): Promise<void> {
  if (initialized) return;

  const autonomyEnabled = env.AUTONOMY_ENABLED === 'true';

  console.log(`[orchestrator] Initializing (autonomy=${autonomyEnabled ? 'ON' : 'OFF'})`);
  console.log(`[orchestrator] Registered tools: ${listRegisteredTools().join(', ')}`);

  // ── Subscribe to domain events ───────────────────────────
  eventBus.on('BookingCreated', onBookingCreated);
  eventBus.on('BookingCancelled', onBookingCancelled);
  eventBus.on('BookingRescheduled', onBookingRescheduled);
  eventBus.on('HoldExpired', onHoldExpired);
  eventBus.on('CalendarWriteFailed', onCalendarWriteFailed);
  eventBus.on('SlotOpened', onSlotOpened);
  eventBus.on('CalendarRetryExhausted', onCalendarRetryExhausted);

  // ── Create and configure job runner ──────────────────────
  const runner = createJobRunner({
    pollIntervalMs: env.AGENT_JOB_POLL_INTERVAL_MS ?? 5000,
    maxConcurrent: env.AGENT_MAX_CONCURRENT_JOBS ?? 3,
    staleTimeoutMs: env.AGENT_JOB_STALE_TIMEOUT_MS ?? 300_000,
  });

  // Wire each registered tool as a job executor
  for (const toolName of listRegisteredTools()) {
    const tool = getTool(toolName);
    if (tool) {
      runner.registerExecutor(toolName, tool);
    }
  }

  // Start the runner only if autonomy is enabled
  if (autonomyEnabled) {
    runner.start();
    console.log('[orchestrator] Job runner started');

    // ── Outbox poller: flush deferred SMS every 30 seconds ──
    //     Skipped when FEATURE_SMS=false (no SMS to deliver).
    if (env.FEATURE_SMS === 'true') {
    outboxPollTimer = setInterval(async () => {
      try {
        const { processOutbox } = await import('../voice/outbound-sms.js');
        const { tenantRepo } = await import('../repos/tenant.repo.js');
        await processOutbox(5, (tid) => tenantRepo.findById(tid));
      } catch (err) {
        console.error('[outbox-poller] Error:', err);
      }
    }, 30_000);
    console.log('[orchestrator] SMS outbox poller started (30s interval)');
    } else {
      console.log('[orchestrator] SMS outbox poller skipped (FEATURE_SMS=false)');
    }
  } else {
    console.log('[orchestrator] Job runner idle (autonomy disabled — events still logged)');
  }

  initialized = true;
}

/**
 * Graceful shutdown: stop the job runner and remove event listeners.
 */
export async function shutdownOrchestrator(): Promise<void> {
  if (!initialized) return;

  console.log('[orchestrator] Shutting down…');

  if (outboxPollTimer) {
    clearInterval(outboxPollTimer);
    outboxPollTimer = null;
  }

  const runner = getJobRunner();
  if (runner) {
    await runner.stop();
  }

  eventBus.removeAllListeners();
  initialized = false;

  console.log('[orchestrator] Shutdown complete');
}

/**
 * Get autonomy runtime status for the /api/autonomy endpoint.
 */
export function getAutonomyStatus(): {
  enabled: boolean;
  runner: { running: boolean; activeJobs: number; registeredTypes: string[] } | null;
  recentEvents: number;
  registeredTools: string[];
} {
  const runner = getJobRunner();
  return {
    enabled: env.AUTONOMY_ENABLED === 'true',
    runner: runner?.getStatus() ?? null,
    recentEvents: eventBus.getRecentEvents().length,
    registeredTools: listRegisteredTools(),
  };
}
