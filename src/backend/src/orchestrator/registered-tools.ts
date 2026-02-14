// ============================================================
// Registered Tools — Whitelist of Autonomous Agent Actions
//
// The orchestrator can ONLY execute actions listed here.
// This is the enforcement boundary for "tool-only actions":
//   ✅ Database operations (via repos)
//   ✅ Notification dispatch (via outbox)
//   ✅ Calendar sync retry (via calendar provider)
//   ❌ No filesystem access
//   ❌ No shell/exec
//   ❌ No network calls to arbitrary URLs
// ============================================================

import type { Job } from '../domain/types.js';
import { auditRepo } from '../repos/audit.repo.js';

/**
 * Format a slot start/end into a human-readable display string.
 * e.g. "Tue Feb 10, 2:00 PM – 3:00 PM"
 */
function formatSlotDisplay(start?: string, end?: string): string {
  if (!start) return 'N/A';
  try {
    const s = new Date(start);
    const e = end ? new Date(end) : null;
    const dateStr = s.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    });
    const startTime = s.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    if (e) {
      const endTime = e.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
      return `${dateStr}, ${startTime} – ${endTime}`;
    }
    return `${dateStr}, ${startTime}`;
  } catch {
    return start ?? 'N/A';
  }
}

/**
 * A registered tool function.
 * Receives the job and returns void (success) or throws (failure).
 */
export type ToolFn = (job: Job) => Promise<void>;

// ── Tool Registry ───────────────────────────────────────────

const toolRegistry = new Map<string, ToolFn>();

/**
 * Register a tool that the autonomous agent is allowed to use.
 */
export function registerTool(name: string, fn: ToolFn): void {
  toolRegistry.set(name, fn);
}

/**
 * Get a registered tool by name. Returns undefined if not registered.
 */
export function getTool(name: string): ToolFn | undefined {
  return toolRegistry.get(name);
}

/**
 * List all registered tool names (for introspection / UI).
 */
export function listRegisteredTools(): string[] {
  return [...toolRegistry.keys()];
}

// ── Built-in Tools ──────────────────────────────────────────

/**
 * Log a confirmation notification to the outbox.
 * (In MVP: writes to notification_outbox table. Real email comes later.)
 */
registerTool('send_confirmation', async (job: Job) => {
  const { query } = await import('../db/client.js');
  const payload = job.payload as {
    reference_code?: string;
    client_email?: string;
    service?: string;
    start_time?: string;
    tenant_name?: string;
  };

  await query(
    `INSERT INTO notification_outbox (tenant_id, job_id, channel, recipient, subject, body, status)
     VALUES ($1, $2, 'email', $3, $4, $5, 'pending')`,
    [
      job.tenant_id,
      job.id,
      payload.client_email ?? 'unknown',
      `Appointment Confirmed — ${payload.reference_code}`,
      [
        `Your appointment has been confirmed.`,
        `Service: ${payload.service ?? 'Consultation'}`,
        `Time: ${payload.start_time ?? 'TBD'}`,
        `Reference: ${payload.reference_code}`,
        `Business: ${payload.tenant_name ?? ''}`,
        '',
        'If you need to reschedule or cancel, please use your reference code.',
      ].join('\n'),
    ],
  );

  await auditRepo.log({
    tenant_id: job.tenant_id,
    event_type: 'notification.queued',
    entity_type: 'notification',
    entity_id: null,
    actor: 'orchestrator',
    payload: {
      channel: 'email',
      reference_code: payload.reference_code,
      type: 'confirmation',
    },
  });
});

/**
 * Log a cancellation notification to the outbox.
 */
registerTool('send_cancellation', async (job: Job) => {
  const { query } = await import('../db/client.js');
  const payload = job.payload as {
    reference_code?: string;
    client_email?: string;
  };

  await query(
    `INSERT INTO notification_outbox (tenant_id, job_id, channel, recipient, subject, body, status)
     VALUES ($1, $2, 'email', $3, $4, $5, 'pending')`,
    [
      job.tenant_id,
      job.id,
      payload.client_email ?? 'unknown',
      `Appointment Cancelled — ${payload.reference_code}`,
      `Your appointment (${payload.reference_code}) has been cancelled. You may book a new appointment at any time.`,
    ],
  );
});

/**
 * Retry a failed calendar sync operation.
 * On success, pushes a confirmation to the user's chat session (Feature 3).
 */
registerTool('retry_calendar_sync', async (job: Job) => {
  const { getCalendarProvider } = await import('../integrations/calendar/index.js');
  const { tenantRepo } = await import('../repos/tenant.repo.js');
  const { getDefaultStore } = await import('../stores/booking-store-factory.js');
  const { pushService } = await import('../services/push-service.js');

  const payload = job.payload as {
    appointment_id?: string;
    reference_code?: string;
    session_id?: string | null;
    service?: string;
    client_name?: string;
    client_email?: string;
    start_time?: string;
    end_time?: string;
    timezone?: string;
  };

  const tenant = await tenantRepo.findById(job.tenant_id);
  if (!tenant) throw new Error('Tenant not found');

  // If the job payload lacks full appointment details, look them up from DB
  let service = payload.service;
  let startTime = payload.start_time;
  let endTime = payload.end_time;
  let sessionId = payload.session_id ?? null;

  if (payload.appointment_id && (!service || !startTime)) {
    const { query } = await import('../db/client.js');
    const { rows } = await query<{
      service: string | null;
      start_time: string;
      end_time: string;
    }>(
      `SELECT service, start_time::text, end_time::text FROM appointments WHERE id = $1`,
      [payload.appointment_id],
    );
    if (rows[0]) {
      service = service ?? rows[0].service ?? undefined;
      startTime = startTime ?? rows[0].start_time;
      endTime = endTime ?? rows[0].end_time;
    }
  }

  const calendar = getCalendarProvider();
  const eventId = await calendar.createEvent(tenant, {
    summary: `${service ?? 'Appointment'} - ${payload.client_name ?? 'Client'}`,
    description: `Retried via Agent Runtime\nRef: ${payload.reference_code}`,
    start: new Date(startTime!),
    end: new Date(endTime!),
    timezone: payload.timezone ?? tenant.timezone,
  });

  // Update the appointment with the calendar event ID
  if (payload.appointment_id) {
    const store = getDefaultStore();
    await store.updateGoogleEventId(payload.appointment_id, eventId);
  }

  // ── Feature 3: Push booking confirmation to the chat session ──
  if (sessionId) {
    const displayTime = formatSlotDisplay(startTime, endTime);
    await pushService.emitPush(sessionId, job.tenant_id, 'calendar_retry_success', {
      type: 'calendar_retry_success',
      reference_code: payload.reference_code ?? '',
      service: service ?? null,
      start_time: startTime ?? '',
      end_time: endTime ?? '',
      display_time: displayTime,
      message: `Your booking is now confirmed! Ref: ${payload.reference_code ?? 'N/A'} — ${displayTime}${service ? ` (${service})` : ''}.`,
    });
  }

  await auditRepo.log({
    tenant_id: job.tenant_id,
    event_type: 'calendar.retry_succeeded',
    entity_type: 'appointment',
    entity_id: payload.appointment_id ?? null,
    actor: 'orchestrator',
    payload: { reference_code: payload.reference_code, google_event_id: eventId },
  });
});

/**
 * Log a reminder notification (scheduled for future).
 */
registerTool('send_reminder', async (job: Job) => {
  const { query } = await import('../db/client.js');
  const payload = job.payload as {
    reference_code?: string;
    client_email?: string;
    start_time?: string;
    service?: string;
    tenant_name?: string;
    reminder_type?: string;       // '24h' | '2h'
  };

  const reminderLabel = payload.reminder_type === '2h'
    ? '2 hours'
    : '24 hours';

  await query(
    `INSERT INTO notification_outbox (tenant_id, job_id, channel, recipient, subject, body, status)
     VALUES ($1, $2, 'email', $3, $4, $5, 'pending')`,
    [
      job.tenant_id,
      job.id,
      payload.client_email ?? 'unknown',
      `Appointment Reminder (${reminderLabel}) — ${payload.reference_code}`,
      [
        `This is a reminder for your upcoming appointment (in ${reminderLabel}).`,
        `Service: ${payload.service ?? 'Consultation'}`,
        `Time: ${payload.start_time ?? 'TBD'}`,
        `Reference: ${payload.reference_code}`,
        '',
        `If you need to reschedule or cancel, please contact us.`,
      ].join('\n'),
    ],
  );
});

// ── SMS Reminder (2h before appointment) ────────────────────

/**
 * Send an SMS reminder 2 hours before the appointment.
 * Format: "Hi {{firstName}} 👋 This is a reminder of your {{service}}
 *          today at {{time}}. Reply HELP if you need to reschedule."
 *
 * Safety checks at execution time:
 *   - Opt-out: skip if customer texted STOP
 *   - Rate limit: respects outbound SMS rate limits
 *   - Appointment status: skip if cancelled since scheduling
 */
registerTool('send_sms_reminder', async (job: Job) => {
  const { sendOutboundSms } = await import('../voice/outbound-sms.js');
  const { smsOptOutRepo } = await import('../repos/sms-opt-out.repo.js');
  const { appointmentReminderRepo } = await import('../repos/appointment-reminder.repo.js');
  const { getDefaultStore } = await import('../stores/booking-store-factory.js');
  const { tenantRepo } = await import('../repos/tenant.repo.js');
  const { format } = await import('date-fns');
  const { toZonedTime } = await import('date-fns-tz');

  const payload = job.payload as {
    appointment_id?: string;
    reference_code?: string;
    phone?: string;
    first_name?: string;
    service?: string;
    start_time?: string;
    end_time?: string;
    timezone?: string;
  };

  const phone = payload.phone;
  if (!phone) {
    console.warn('[sms-reminder] No phone number in job payload — skipping');
    await appointmentReminderRepo.markFailed(job.id);
    return;
  }

  // ── Check appointment is still confirmed ──────────────────
  if (payload.appointment_id) {
    const store = getDefaultStore();
    const apt = await store.findById(payload.appointment_id, job.tenant_id);
    if (!apt || apt.status !== 'confirmed') {
      console.log(`[sms-reminder] Appointment ${payload.appointment_id?.slice(0, 8)}… no longer confirmed — skipping`);
      await appointmentReminderRepo.markCancelled(job.id);
      return;
    }
  }

  // ── Check opt-out ─────────────────────────────────────────
  const optedOut = await smsOptOutRepo.isOptedOut(phone, job.tenant_id);
  if (optedOut) {
    console.log(`[sms-reminder] Phone opted out — skipping reminder`);
    await appointmentReminderRepo.markCancelled(job.id);
    return;
  }

  // ── Build the friendly message ────────────────────────────
  const firstName = payload.first_name || 'there';
  const service = payload.service || 'appointment';
  const tz = payload.timezone || 'America/New_York';

  let dateTimeStr = 'your scheduled time';
  if (payload.start_time) {
    try {
      const startLocal = toZonedTime(new Date(payload.start_time), tz);
      // Include explicit date + time, e.g. "Mon Feb 9 at 2:00 PM"
      dateTimeStr = `${format(startLocal, 'EEE MMM d')} at ${format(startLocal, 'h:mm a')}`;
    } catch {
      dateTimeStr = 'your scheduled time';
    }
  }

  const body = `Hi ${firstName} 👋 Reminder: your ${service} is ${dateTimeStr}. Reply HELP if you need to reschedule.`;

  // ── Send via outbound gateway (quiet hours + retry aware) ─
  const tenant = await tenantRepo.findById(job.tenant_id);
  const result = await sendOutboundSms(
    {
      tenantId: job.tenant_id,
      phone,
      body,
      messageType: 'reminder',
      bookingId: payload.appointment_id ?? null,
      scheduledAt: payload.start_time ? new Date(payload.start_time) : undefined,
      sourceJobId: job.id,
    },
    tenant ?? { timezone: tz },
  );

  if (result.sent) {
    await appointmentReminderRepo.markSent(job.id);
    await auditRepo.log({
      tenant_id: job.tenant_id,
      event_type: 'sms_reminder.sent',
      entity_type: 'appointment',
      entity_id: payload.appointment_id ?? null,
      actor: 'job_runner',
      payload: {
        reference_code: payload.reference_code,
        reminder_type: 'sms_2h',
        // No phone/name in audit (PII)
      },
    });
    console.log(`[sms-reminder] ✅ Sent reminder for ${payload.reference_code ?? 'unknown'}`);
  } else if (result.queued) {
    // Queued for later delivery (quiet hours or retry) — don't mark as failed
    console.log(`[sms-reminder] 📋 Queued for later delivery — ${payload.reference_code ?? 'unknown'}`);
  } else {
    await appointmentReminderRepo.markFailed(job.id);
    throw new Error(`SMS reminder failed: ${result.error}`);
  }
});

// ── Phase 27 Workflow Tools ─────────────────────────────────

/**
 * Workflow A: Send a follow-up message when a hold expires.
 * "Your slot hold expired — want new options?"
 */
registerTool('send_hold_followup', async (job: Job) => {
  const { query } = await import('../db/client.js');
  const payload = job.payload as {
    client_email?: string;
    client_name?: string;
    slot_start?: string;
    slot_end?: string;
    session_id?: string;
  };

  await query(
    `INSERT INTO notification_outbox (tenant_id, job_id, channel, recipient, subject, body, status)
     VALUES ($1, $2, 'email', $3, $4, $5, 'pending')`,
    [
      job.tenant_id,
      job.id,
      payload.client_email ?? 'unknown',
      'Your held time slot has expired',
      [
        `Hi ${payload.client_name ?? 'there'},`,
        '',
        `The time slot you were holding (${payload.slot_start ?? 'N/A'}) has expired.`,
        '',
        `Would you like to see new available options? Simply reply to this message`,
        `or start a new chat session to find another time that works for you.`,
        '',
        'We look forward to assisting you!',
      ].join('\n'),
    ],
  );

  await auditRepo.log({
    tenant_id: job.tenant_id,
    event_type: 'notification.queued',
    entity_type: 'notification',
    entity_id: null,
    actor: 'orchestrator',
    payload: {
      channel: 'email',
      type: 'hold_followup',
      session_id: payload.session_id,
    },
  });
});

/**
 * Workflow B: Notify a waitlisted user that a matching slot opened.
 * Also pushes a proactive message to the user's active chat session (Feature 3).
 */
registerTool('send_waitlist_notification', async (job: Job) => {
  const { query } = await import('../db/client.js');
  const { pushService } = await import('../services/push-service.js');
  const payload = job.payload as {
    waitlist_entry_id?: string;
    client_email?: string;
    client_name?: string;
    slot_start?: string;
    slot_end?: string;
    service?: string;
  };

  await query(
    `INSERT INTO notification_outbox (tenant_id, job_id, channel, recipient, subject, body, status)
     VALUES ($1, $2, 'email', $3, $4, $5, 'pending')`,
    [
      job.tenant_id,
      job.id,
      payload.client_email ?? 'unknown',
      'A time slot matching your preferences just opened!',
      [
        `Hi ${payload.client_name ?? 'there'},`,
        '',
        `Great news! A time slot matching your preferences has become available:`,
        `Time: ${payload.slot_start ?? 'N/A'}`,
        payload.service ? `Service: ${payload.service}` : '',
        '',
        `This slot may fill quickly — start a chat to book it now!`,
        '',
        'Best regards,',
        'The Scheduling Team',
      ].filter(Boolean).join('\n'),
    ],
  );

  // Mark the waitlist entry as notified
  if (payload.waitlist_entry_id) {
    await query(
      `UPDATE waitlist_entries
       SET status = 'notified', notified_at = NOW(),
           matched_slot = $2
       WHERE id = $1 AND status = 'waiting'`,
      [
        payload.waitlist_entry_id,
        JSON.stringify({ start: payload.slot_start, end: payload.slot_end }),
      ],
    );
  }

  // ── Feature 3: Push proactive message to the chat session ──
  if (payload.waitlist_entry_id) {
    const { rows: entryRows } = await query<{ session_id: string }>(
      `SELECT session_id FROM waitlist_entries WHERE id = $1`,
      [payload.waitlist_entry_id],
    );
    const sessionId = entryRows[0]?.session_id;

    if (sessionId) {
      const displayTime = formatSlotDisplay(payload.slot_start, payload.slot_end);
      await pushService.emitPush(sessionId, job.tenant_id, 'waitlist_match', {
        type: 'waitlist_match',
        slots: [{
          start: payload.slot_start ?? '',
          end: payload.slot_end ?? '',
          display_time: displayTime,
          service: payload.service ?? null,
        }],
        service: payload.service ?? null,
        message: `Good news — I found a new opening! ${displayTime}${payload.service ? ` for ${payload.service}` : ''}. Would you like to book it?`,
      });
    }
  }

  await auditRepo.log({
    tenant_id: job.tenant_id,
    event_type: 'notification.queued',
    entity_type: 'notification',
    entity_id: null,
    actor: 'orchestrator',
    payload: {
      channel: 'email',
      type: 'waitlist_notification',
      waitlist_entry_id: payload.waitlist_entry_id,
    },
  });
});

/**
 * Workflow C: Escalate a calendar failure after retries are exhausted.
 * Creates an inquiry record + notifies the user their booking may need attention.
 */
registerTool('escalate_calendar_failure', async (job: Job) => {
  const { query } = await import('../db/client.js');
  const payload = job.payload as {
    appointment_id?: string;
    reference_code?: string;
    client_email?: string;
    client_name?: string;
    attempts?: number;
    last_error?: string;
  };

  // Notify the user
  await query(
    `INSERT INTO notification_outbox (tenant_id, job_id, channel, recipient, subject, body, status)
     VALUES ($1, $2, 'email', $3, $4, $5, 'pending')`,
    [
      job.tenant_id,
      job.id,
      payload.client_email ?? 'unknown',
      `Calendar Sync Issue — ${payload.reference_code}`,
      [
        `Hi ${payload.client_name ?? 'there'},`,
        '',
        `Your appointment (${payload.reference_code}) has been confirmed in our system,`,
        `but we encountered an issue syncing it to the calendar.`,
        '',
        `Our team has been notified and will ensure your appointment appears`,
        `on the calendar shortly. No action is needed from you.`,
        '',
        `If you have questions, please reply to this message.`,
      ].join('\n'),
    ],
  );

  await auditRepo.log({
    tenant_id: job.tenant_id,
    event_type: 'calendar.escalated',
    entity_type: 'appointment',
    entity_id: payload.appointment_id ?? null,
    actor: 'orchestrator',
    payload: {
      reference_code: payload.reference_code,
      attempts: payload.attempts,
      last_error: payload.last_error,
      type: 'calendar_escalation',
    },
  });
});

// ── Feature 2: Async Contact Follow-up ──────────────────────

/**
 * Send a follow-up contact message (email or SMS) with available options.
 * Triggered when: no slots match, calendar retry is queued, or user requests contact.
 */
registerTool('send_contact_followup', async (job: Job) => {
  const { query } = await import('../db/client.js');
  const payload = job.payload as {
    session_id?: string;
    client_name?: string;
    client_email?: string;
    client_phone?: string;
    preferred_contact?: 'email' | 'sms' | 'either';
    reason?: string;
    preferred_service?: string;
    notes?: string;
  };

  const channel: 'email' | 'sms' =
    payload.preferred_contact === 'sms' && payload.client_phone ? 'sms' : 'email';

  const recipient = channel === 'sms'
    ? (payload.client_phone ?? 'unknown')
    : (payload.client_email ?? 'unknown');

  const reasonLabel =
    payload.reason === 'no_availability' ? 'no available slots matched your preferences'
    : payload.reason === 'calendar_retry_queued' ? 'we are finalizing your calendar booking'
    : 'you asked us to follow up';

  const serviceNote = payload.preferred_service
    ? `\nService of interest: ${payload.preferred_service}`
    : '';

  const body = [
    `Hi ${payload.client_name ?? 'there'},`,
    '',
    `Thank you for chatting with us! Since ${reasonLabel}, we wanted to reach out with updated options.`,
    serviceNote,
    '',
    `We'll be checking availability and will share the best times with you.`,
    `In the meantime, feel free to start a new chat anytime to check live availability.`,
    '',
    payload.notes ? `Your note: ${payload.notes}\n` : '',
    'Best regards,',
    'The Scheduling Team',
  ].filter(Boolean).join('\n');

  const subject = channel === 'email'
    ? 'Follow-up: Available appointment options'
    : null;

  await query(
    `INSERT INTO notification_outbox (tenant_id, job_id, channel, recipient, subject, body, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [
      job.tenant_id,
      job.id,
      channel,
      recipient,
      subject,
      body,
    ],
  );

  await auditRepo.log({
    tenant_id: job.tenant_id,
    event_type: 'notification.queued',
    entity_type: 'notification',
    entity_id: null,
    actor: 'orchestrator',
    payload: {
      channel,
      type: 'contact_followup',
      reason: payload.reason,
      session_id: payload.session_id,
    },
  });
});

// ── Outbound SMS Outbox Processor ───────────────────────────

/**
 * Process queued outbound SMS messages (quiet hours deferred + retries).
 * Called periodically by the job runner. Flushes messages whose
 * scheduled_at has passed, checking abort conditions before each send.
 */
registerTool('process_sms_outbox', async (_job: Job) => {
  const { processOutbox } = await import('../voice/outbound-sms.js');
  const { tenantRepo } = await import('../repos/tenant.repo.js');

  const result = await processOutbox(5, async (tenantId) => {
    return tenantRepo.findById(tenantId);
  });

  if (result.processed > 0) {
    console.log(
      `[sms-outbox] Processed ${result.processed}: ` +
      `sent=${result.sent} aborted=${result.aborted} retried=${result.retried} failed=${result.failed}`,
    );
  }
});
