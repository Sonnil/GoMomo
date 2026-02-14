// ── on-calendar-write-failed handler ───────────────────────
// When a Google Calendar write fails, enqueue a retry job
// with exponential backoff. If max retries exhausted, emit
// CalendarRetryExhausted for escalation.

import type { CalendarWriteFailedEvent } from '../../domain/events.js';
import type { CalendarRetryExhaustedEvent } from '../../domain/events.js';
import { policyEngine } from '../policy-engine.js';
import { jobRepo } from '../../repos/job.repo.js';
import { auditRepo } from '../../repos/audit.repo.js';
import { eventBus } from '../event-bus.js';

/** Exponential backoff delays: attempt 1→30s, 2→120s, 3→480s */
const BACKOFF_DELAYS_MS = [30_000, 120_000, 480_000];
const MAX_RETRIES = 3;

export async function onCalendarWriteFailed(event: CalendarWriteFailedEvent): Promise<void> {
  const { tenant_id, appointment_id, reference_code, session_id, error } = event;

  // Log the failure
  await auditRepo.log({
    tenant_id,
    event_type: 'calendar.write_failed',
    entity_type: 'appointment',
    entity_id: appointment_id,
    actor: 'orchestrator',
    payload: { reference_code, error },
  });

  // Count existing retry jobs for this appointment
  const { query } = await import('../../db/client.js');
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM jobs
     WHERE tenant_id = $1
       AND type = 'retry_calendar_sync'
       AND payload->>'appointment_id' = $2
       AND status IN ('pending', 'claimed', 'completed')`,
    [tenant_id, appointment_id],
  );
  const existingRetries = parseInt(rows[0]?.count ?? '0', 10);

  // If max retries reached, escalate instead of retrying
  if (existingRetries >= MAX_RETRIES) {
    console.log(`[on-calendar-write-failed] Max retries (${MAX_RETRIES}) exhausted for ${reference_code} — escalating`);

    setImmediate(() => {
      eventBus.emit<CalendarRetryExhaustedEvent>({
        name: 'CalendarRetryExhausted',
        tenant_id,
        appointment_id,
        reference_code,
        attempts: existingRetries,
        last_error: error,
        timestamp: new Date().toISOString(),
      });
    });
    return;
  }

  // Check policy before scheduling retry
  const decision = await policyEngine.evaluate('retry_calendar_sync', tenant_id, {
    failure_type: 'calendar_write',
  });

  if (decision.effect === 'allow') {
    const delayMs = BACKOFF_DELAYS_MS[existingRetries] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
    const runAt = new Date(Date.now() + delayMs);

    await jobRepo.create({
      tenant_id,
      type: 'retry_calendar_sync',
      payload: {
        appointment_id,
        reference_code,
        session_id: session_id ?? null,
      },
      priority: 8,
      run_at: runAt,
      max_attempts: 3,
      source_event: event.name,
    });

    console.log(`[on-calendar-write-failed] Retry ${existingRetries + 1}/${MAX_RETRIES} scheduled in ${delayMs / 1000}s for ${reference_code}`);
  }
}
