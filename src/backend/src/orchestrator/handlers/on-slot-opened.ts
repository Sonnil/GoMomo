// ── on-slot-opened handler ─────────────────────────────────
// When a slot becomes available (cancellation or reschedule),
// check if any waitlist entries match and notify them.

import type { SlotOpenedEvent } from '../../domain/events.js';
import { policyEngine } from '../policy-engine.js';
import { jobRepo } from '../../repos/job.repo.js';
import { waitlistRepo } from '../../repos/waitlist.repo.js';
import { auditRepo } from '../../repos/audit.repo.js';

export async function onSlotOpened(event: SlotOpenedEvent): Promise<void> {
  // Audit the slot opening
  await auditRepo.log({
    tenant_id: event.tenant_id,
    event_type: 'slot.opened',
    entity_type: 'availability',
    entity_id: null,
    actor: 'orchestrator',
    payload: {
      slot_start: event.slot_start,
      slot_end: event.slot_end,
      service: event.service,
      reason: event.reason,
    },
  });

  // Find matching waitlist entries (FIFO order — oldest first)
  const matches = await waitlistRepo.findWaiting(event.tenant_id, {
    service: event.service ?? undefined,
    limit: 5,  // Notify top 5 matches at most
  });

  if (matches.length === 0) return;

  console.log(`[on-slot-opened] Found ${matches.length} waitlist match(es) for slot ${event.slot_start}`);

  for (const entry of matches) {
    // Optional: check day/time preferences
    if (!matchesPreferences(entry, event)) continue;

    // Check policy
    const decision = await policyEngine.evaluate('waitlist_notify', event.tenant_id, {
      channel: 'email',
    });

    if (decision.effect === 'allow') {
      await jobRepo.create({
        tenant_id: event.tenant_id,
        type: 'send_waitlist_notification',
        payload: {
          waitlist_entry_id: entry.id,
          client_email: entry.client_email,
          client_name: entry.client_name,
          slot_start: event.slot_start,
          slot_end: event.slot_end,
          service: event.service,
        },
        priority: 8,
        run_at: new Date(),   // immediately
        max_attempts: 3,
        source_event: event.name,
      });
    }
  }
}

/**
 * Check if a waitlist entry's day/time preferences match the opened slot.
 * Returns true if no preferences are set (matches everything).
 */
function matchesPreferences(
  entry: { preferred_days: string[]; preferred_time_range: { start?: string; end?: string } | null },
  event: SlotOpenedEvent,
): boolean {
  const slotDate = new Date(event.slot_start);

  // Check preferred days
  if (entry.preferred_days && entry.preferred_days.length > 0) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const slotDay = dayNames[slotDate.getUTCDay()];
    if (!entry.preferred_days.includes(slotDay)) return false;
  }

  // Check preferred time range (simple HH:MM comparison in UTC)
  if (entry.preferred_time_range?.start || entry.preferred_time_range?.end) {
    const slotHHMM = `${String(slotDate.getUTCHours()).padStart(2, '0')}:${String(slotDate.getUTCMinutes()).padStart(2, '0')}`;
    if (entry.preferred_time_range.start && slotHHMM < entry.preferred_time_range.start) return false;
    if (entry.preferred_time_range.end && slotHHMM > entry.preferred_time_range.end) return false;
  }

  return true;
}
