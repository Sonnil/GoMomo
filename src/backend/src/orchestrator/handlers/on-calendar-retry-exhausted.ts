// ── on-calendar-retry-exhausted handler ────────────────────
// When calendar retries are exhausted (all 3 attempts failed),
// escalate: notify the user + audit the escalation.

import type { CalendarRetryExhaustedEvent } from '../../domain/events.js';
import { policyEngine } from '../policy-engine.js';
import { jobRepo } from '../../repos/job.repo.js';
import { auditRepo } from '../../repos/audit.repo.js';

export async function onCalendarRetryExhausted(event: CalendarRetryExhaustedEvent): Promise<void> {
  // Audit the exhaustion
  await auditRepo.log({
    tenant_id: event.tenant_id,
    event_type: 'calendar.retry_exhausted',
    entity_type: 'appointment',
    entity_id: event.appointment_id,
    actor: 'orchestrator',
    payload: {
      reference_code: event.reference_code,
      attempts: event.attempts,
      last_error: event.last_error,
    },
  });

  // Look up the appointment to get client details
  const { getDefaultStore } = await import('../../stores/booking-store-factory.js');
  const store = getDefaultStore();
  const appointment = await store.findById(event.appointment_id, event.tenant_id);

  // Check policy before escalating
  const decision = await policyEngine.evaluate('escalate_calendar_failure', event.tenant_id, {
    failure_type: 'calendar_write',
  });

  if (decision.effect === 'allow') {
    await jobRepo.create({
      tenant_id: event.tenant_id,
      type: 'escalate_calendar_failure',
      payload: {
        appointment_id: event.appointment_id,
        reference_code: event.reference_code,
        client_email: appointment?.client_email ?? null,
        client_name: appointment?.client_name ?? null,
        attempts: event.attempts,
        last_error: event.last_error,
      },
      priority: 10,  // high priority
      run_at: new Date(),
      max_attempts: 3,
      source_event: event.name,
    });
  }
}
