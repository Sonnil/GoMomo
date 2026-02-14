// ── on-booking-created handler ─────────────────────────────
// When a booking is confirmed:
// 1. Enqueue confirmation notification (email)
// 2. Enqueue 24h-before reminder
// 3. Enqueue 2h-before reminder
// 4. Enqueue 2h SMS reminder (if phone available)
// 5. Send immediate SMS booking confirmation (if phone available)

import type { BookingCreatedEvent } from '../../domain/events.js';
import { env } from '../../config/env.js';
import { policyEngine } from '../policy-engine.js';
import { jobRepo } from '../../repos/job.repo.js';
import { appointmentReminderRepo } from '../../repos/appointment-reminder.repo.js';
import { smsMetricInc } from '../../voice/sms-metrics.js';
import { auditRepo } from '../../repos/audit.repo.js';
import { tenantRepo } from '../../repos/tenant.repo.js';
import { sendOutboundSms } from '../../voice/outbound-sms.js';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

export async function onBookingCreated(event: BookingCreatedEvent): Promise<void> {
  const { tenant_id, appointment } = event;
  const { reference_code, client_email, client_phone, service, start_time, end_time } = appointment;

  // ── Booking funnel metric (by channel proxy) ─────────────
  smsMetricInc(client_phone ? 'booking_sms' : 'booking_web');

  // ── Confirmation notification ────────────────────────────
  const confirmDecision = await policyEngine.evaluate('send_confirmation', tenant_id, {
    channel: 'email',
  });

  if (confirmDecision.effect === 'allow') {
    await jobRepo.create({
      tenant_id,
      type: 'send_confirmation',
      payload: {
        reference_code,
        client_email: client_email ?? null,
        service,
        start_time: start_time.toISOString(),
      },
      priority: 10,
      run_at: new Date(), // immediately
      max_attempts: 3,
      source_event: event.name,
    });
  }

  // ── Reminder (24h before appointment) ────────────────────
  const reminderDecision = await policyEngine.evaluate('send_reminder', tenant_id, {
    channel: 'email',
  });

  if (reminderDecision.effect === 'allow') {
    const reminder24h = new Date(start_time.getTime() - 24 * 60 * 60 * 1000);

    // Only schedule if reminder time is in the future
    if (reminder24h > new Date()) {
      await jobRepo.create({
        tenant_id,
        type: 'send_reminder',
        payload: {
          reference_code,
          client_email: client_email ?? null,
          service,
          start_time: start_time.toISOString(),
          reminder_type: '24h',
        },
        priority: 5,
        run_at: reminder24h,
        max_attempts: 3,
        source_event: event.name,
      });
    }
  }

  // ── Reminder (2h before appointment) ─────────────────────
  const reminder2hDecision = await policyEngine.evaluate('send_reminder', tenant_id, {
    channel: 'email',
    reminder_type: '2h',
  });

  if (reminder2hDecision.effect === 'allow') {
    const reminder2h = new Date(start_time.getTime() - 2 * 60 * 60 * 1000);

    // Only schedule if reminder time is in the future
    if (reminder2h > new Date()) {
      await jobRepo.create({
        tenant_id,
        type: 'send_reminder',
        payload: {
          reference_code,
          client_email: client_email ?? null,
          service,
          start_time: start_time.toISOString(),
          reminder_type: '2h',
        },
        priority: 7,   // slightly higher than 24h reminder
        run_at: reminder2h,
        max_attempts: 3,
        source_event: event.name,
      });
    }
  }

  // ── SMS Reminder (2h before appointment) ─────────────────
  // Only schedule if the customer provided a phone number AND
  // FEATURE_SMS is enabled. The job will re-check opt-out and
  // rate limits at send time.
  if (env.FEATURE_SMS !== 'false' && client_phone) {
    const smsReminder2h = new Date(start_time.getTime() - 2 * 60 * 60 * 1000);

    if (smsReminder2h > new Date()) {
      // Extract first name for the friendly message
      const firstName = (appointment.client_name ?? '').split(/\s+/)[0] || 'there';

      const job = await jobRepo.create({
        tenant_id,
        type: 'send_sms_reminder',
        payload: {
          appointment_id: appointment.id,
          reference_code,
          phone: client_phone,
          first_name: firstName,
          service: service ?? 'appointment',
          start_time: start_time.toISOString(),
          end_time: end_time.toISOString(),
          timezone: appointment.timezone,
        },
        priority: 8,    // higher than email reminders
        run_at: smsReminder2h,
        max_attempts: 3,
        source_event: event.name,
      });

      // Track the reminder so it can be cancelled
      await appointmentReminderRepo.create({
        appointment_id: appointment.id,
        tenant_id,
        job_id: job.id,
        reminder_type: 'sms_2h',
        phone: client_phone,
        scheduled_at: smsReminder2h,
      });

      console.log(`[on-booking-created] SMS reminder scheduled for ${smsReminder2h.toISOString()} (job: ${job.id.slice(0, 8)}…)`);
    }
  }

  // ── Immediate SMS Booking Confirmation ───────────────────
  // Send a single confirmation SMS right after the booking is created.
  // Uses the outbound SMS gateway (quiet hours + opt-out aware).
  // Idempotent: messageType=confirmation + bookingId ensures no duplicates.
  // Skipped when FEATURE_SMS=false (booking-only mode).
  if (env.FEATURE_SMS !== 'false' && client_phone) {
    const smsPolicyDecision = await policyEngine.evaluate('send_sms_confirmation', tenant_id, {
      channel: 'sms',
    });

    if (smsPolicyDecision.effect === 'allow') {
      try {
        const tenant = await tenantRepo.findById(tenant_id);
        const tz = appointment.timezone || tenant?.timezone || 'America/New_York';

        let dateTimeStr = 'your scheduled time';
        try {
          const startLocal = toZonedTime(new Date(start_time), tz);
          dateTimeStr = `${format(startLocal, 'EEE MMM d')} at ${format(startLocal, 'h:mm a')}`;
        } catch {
          // fallback already set
        }

        const body = `Confirmed: ${dateTimeStr}. Ref: ${reference_code}. Reply CHANGE to reschedule, CANCEL to cancel. HELP for options. STOP to opt out.`;

        const result = await sendOutboundSms(
          {
            tenantId: tenant_id,
            phone: client_phone,
            body,
            messageType: 'confirmation',
            bookingId: appointment.id,
            sourceJobId: null,
          },
          tenant ?? { timezone: tz },
        );

        if (result.sent || result.queued) {
          smsMetricInc('confirmation_sent');
          await auditRepo.log({
            tenant_id,
            event_type: 'sms.booking_confirmation_sent',
            entity_type: 'appointment',
            entity_id: appointment.id,
            actor: 'on_booking_created',
            payload: {
              reference_code,
              queued: result.queued,
              simulated: result.simulated ?? false,
              message_sid_last4: result.messageSidLast4 ?? null,
            },
          });
          console.log(`[on-booking-created] Confirmation SMS ${result.queued ? 'queued' : 'sent'} for ${reference_code}`);
        } else {
          smsMetricInc('confirmation_failed');
          await auditRepo.log({
            tenant_id,
            event_type: 'sms.booking_confirmation_failed',
            entity_type: 'appointment',
            entity_id: appointment.id,
            actor: 'on_booking_created',
            payload: {
              reference_code,
              error: result.error ?? 'unknown',
            },
          });
          console.warn(`[on-booking-created] Confirmation SMS failed for ${reference_code}: ${result.error}`);
        }
      } catch (smsErr) {
        // Best-effort: never fail the booking flow over SMS
        smsMetricInc('confirmation_failed');
        console.error(`[on-booking-created] Confirmation SMS error:`, smsErr);
        try {
          await auditRepo.log({
            tenant_id,
            event_type: 'sms.booking_confirmation_failed',
            entity_type: 'appointment',
            entity_id: appointment.id,
            actor: 'on_booking_created',
            payload: {
              reference_code,
              error: String(smsErr),
            },
          });
        } catch {
          // swallow audit failure too
        }
      }
    }
  }
}
