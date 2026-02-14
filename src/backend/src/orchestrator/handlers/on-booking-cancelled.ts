// ── on-booking-cancelled handler ───────────────────────────
// When a booking is cancelled:
// 1. Enqueue cancellation notification
// 2. Cancel any pending SMS/email reminders for this appointment
// 3. Abort any queued outbound SMS for this appointment

import type { BookingCancelledEvent } from '../../domain/events.js';
import { policyEngine } from '../policy-engine.js';
import { jobRepo } from '../../repos/job.repo.js';
import { appointmentReminderRepo } from '../../repos/appointment-reminder.repo.js';
import { smsOutboxRepo } from '../../repos/sms-outbox.repo.js';

export async function onBookingCancelled(event: BookingCancelledEvent): Promise<void> {
  const { tenant_id, appointment } = event;
  const { reference_code, client_email } = appointment;

  const decision = await policyEngine.evaluate('send_cancellation', tenant_id, {
    channel: 'email',
  });

  if (decision.effect === 'allow') {
    await jobRepo.create({
      tenant_id,
      type: 'send_cancellation',
      payload: {
        reference_code,
        client_email: client_email ?? null,
      },
      priority: 10,
      run_at: new Date(),
      max_attempts: 3,
      source_event: event.name,
    });
  }

  // ── Cancel any pending reminders for this appointment ────
  try {
    const cancelledCount = await appointmentReminderRepo.cancelByAppointment(appointment.id);
    if (cancelledCount > 0) {
      console.log(`[on-booking-cancelled] Cancelled ${cancelledCount} pending reminder(s) for appointment ${appointment.id.slice(0, 8)}…`);
    }
  } catch (err) {
    console.error('[on-booking-cancelled] Failed to cancel reminders:', err);
  }

  // ── Abort any queued outbound SMS for this appointment ───
  try {
    const abortedCount = await smsOutboxRepo.abortByBooking(appointment.id, 'booking_cancelled');
    if (abortedCount > 0) {
      console.log(`[on-booking-cancelled] Aborted ${abortedCount} queued outbound SMS for appointment ${appointment.id.slice(0, 8)}…`);
    }
  } catch (err) {
    console.error('[on-booking-cancelled] Failed to abort outbox SMS:', err);
  }
}
