// ── on-hold-expired handler ────────────────────────────────
// When a hold expires without being converted to a booking:
// 1. Audit the expiry
// 2. If user left contact info, send a follow-up message
//    ("Your slot hold expired — want new options?")
//    Subject to hold_followup policy + cooldown check.

import type { HoldExpiredEvent } from '../../domain/events.js';
import { policyEngine } from '../policy-engine.js';
import { jobRepo } from '../../repos/job.repo.js';
import { auditRepo } from '../../repos/audit.repo.js';

/**
 * Cooldown: don't send more than one hold follow-up per session within 30 minutes.
 * Check the jobs table for recent hold_followup jobs for the same session.
 */
async function isInCooldown(tenantId: string, sessionId: string): Promise<boolean> {
  const { query } = await import('../../db/client.js');
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM jobs
     WHERE tenant_id = $1
       AND type = 'send_hold_followup'
       AND payload->>'session_id' = $2
       AND created_at > NOW() - INTERVAL '30 minutes'`,
    [tenantId, sessionId],
  );
  return parseInt(rows[0]?.count ?? '0', 10) > 0;
}

export async function onHoldExpired(event: HoldExpiredEvent): Promise<void> {
  // Always audit the expiry
  await auditRepo.log({
    tenant_id: event.tenant_id,
    event_type: 'hold.expired',
    entity_type: 'hold',
    entity_id: event.hold_id,
    actor: 'orchestrator',
    payload: {
      slot_start: event.slot_start,
      slot_end: event.slot_end,
      session_id: event.session_id,
    },
  });

  // If no session_id, we can't look up contact info → done
  if (!event.session_id) return;

  // Look up session metadata for contact info
  const { sessionRepo } = await import('../../repos/session.repo.js');
  const session = await sessionRepo.findById(event.session_id);
  if (!session) return;

  // Try to find an email from session metadata or conversation context
  // The agent stores client_email in session metadata when collected
  const clientEmail = (session.metadata as any)?.client_email as string | undefined;
  const clientName = (session.metadata as any)?.client_name as string | undefined;

  // No contact info → can't follow up
  if (!clientEmail) return;

  // Check cooldown — don't spam the same session
  const cooledDown = await isInCooldown(event.tenant_id, event.session_id);
  if (cooledDown) {
    console.log(`[on-hold-expired] Cooldown active for session ${event.session_id} — skipping follow-up`);
    return;
  }

  // Check policy
  const decision = await policyEngine.evaluate('hold_followup', event.tenant_id, {
    channel: 'email',
  });

  if (decision.effect === 'allow') {
    await jobRepo.create({
      tenant_id: event.tenant_id,
      type: 'send_hold_followup',
      payload: {
        session_id: event.session_id,
        hold_id: event.hold_id,
        client_email: clientEmail,
        client_name: clientName ?? 'there',
        slot_start: event.slot_start,
        slot_end: event.slot_end,
      },
      priority: 5,
      run_at: new Date(),     // send immediately
      max_attempts: 3,
      source_event: event.name,
    });
  }
}
