// ── on-booking-rescheduled handler ─────────────────────────
// When a booking is rescheduled:
// 1. Cancel pending reminders for the OLD appointment
// 2. Schedule new SMS reminder for the NEW appointment

import type { BookingRescheduledEvent } from '../../domain/events.js';
import { appointmentReminderRepo } from '../../repos/appointment-reminder.repo.js';
import { smsOutboxRepo } from '../../repos/sms-outbox.repo.js';
import { jobRepo } from '../../repos/job.repo.js';

export async function onBookingRescheduled(event: BookingRescheduledEvent): Promise<void> {
  const { tenant_id, old_appointment, new_appointment } = event;

  // ── 1. Cancel old appointment's pending reminders ────────
  try {
    const cancelledCount = await appointmentReminderRepo.cancelByAppointment(old_appointment.id);
    if (cancelledCount > 0) {
      console.log(`[on-booking-rescheduled] Cancelled ${cancelledCount} old reminder(s) for ${old_appointment.id.slice(0, 8)}…`);
    }
  } catch (err) {
    console.error('[on-booking-rescheduled] Failed to cancel old reminders:', err);
  }

  // ── 1b. Abort queued outbound SMS for the old appointment ─
  try {
    const abortedCount = await smsOutboxRepo.abortByBooking(old_appointment.id, 'booking_rescheduled');
    if (abortedCount > 0) {
      console.log(`[on-booking-rescheduled] Aborted ${abortedCount} queued outbound SMS for ${old_appointment.id.slice(0, 8)}…`);
    }
  } catch (err) {
    console.error('[on-booking-rescheduled] Failed to abort outbox SMS:', err);
  }

  // ── 2. Schedule new SMS reminder (if phone available) ────
  const phone = new_appointment.client_phone ?? old_appointment.client_phone;
  if (!phone) return;

  const startTime = new_appointment.start_time instanceof Date
    ? new_appointment.start_time
    : new Date(new_appointment.start_time);

  const endTime = new_appointment.end_time instanceof Date
    ? new_appointment.end_time
    : new Date(new_appointment.end_time);

  const smsReminder2h = new Date(startTime.getTime() - 2 * 60 * 60 * 1000);

  if (smsReminder2h > new Date()) {
    const firstName = (new_appointment.client_name ?? '').split(/\s+/)[0] || 'there';

    const job = await jobRepo.create({
      tenant_id,
      type: 'send_sms_reminder',
      payload: {
        appointment_id: new_appointment.id,
        reference_code: new_appointment.reference_code,
        phone,
        first_name: firstName,
        service: new_appointment.service ?? 'appointment',
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        timezone: new_appointment.timezone,
      },
      priority: 8,
      run_at: smsReminder2h,
      max_attempts: 3,
      source_event: event.name,
    });

    await appointmentReminderRepo.create({
      appointment_id: new_appointment.id,
      tenant_id,
      job_id: job.id,
      reminder_type: 'sms_2h',
      phone,
      scheduled_at: smsReminder2h,
    });

    console.log(`[on-booking-rescheduled] New SMS reminder scheduled for ${smsReminder2h.toISOString()}`);
  }
}
