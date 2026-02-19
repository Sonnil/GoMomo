import type { ToolName } from './tools.js';
import type { Tenant } from '../domain/types.js';
import { verifyCancellation } from './cancel-verification.js';
import type { CancelVerificationDeps } from './cancel-verification.js';
import { availabilityService, SlotConflictError, getCalendarDebugSnapshot, CalendarReadError } from '../services/availability.service.js';
import { bookingService, BookingError } from '../services/booking.service.js';
import { waitlistRepo } from '../repos/waitlist.repo.js';
import { format } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { daysFromNow } from '../services/clock.js';
import { env } from '../config/env.js';
import { randomUUID, createHash } from 'crypto';

/** Maximum date-range span (in days) allowed for a single check_availability call. */
const MAX_AVAILABILITY_RANGE_DAYS = 14;

/**
 * Mask an email for display in LLM context: keep first 2 chars of local part + "***@domain".
 * Example: "jane@example.com" → "ja***@example.com"
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at); // includes "@"
  const visible = local.slice(0, 2);
  return `${visible}***${domain}`;
}

type ToolResult = {
  success: boolean;
  data?: any;
  error?: string;
};

export async function executeToolCall(
  toolName: ToolName,
  args: Record<string, any>,
  tenantId: string,
  sessionId: string,
  tenant: Tenant,
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'check_availability':
        return await handleCheckAvailability(tenantId, sessionId, tenant, args as any);

      case 'hold_slot':
        return await handleHoldSlot(tenantId, sessionId, tenant, args as any);

      case 'confirm_booking':
        return await handleConfirmBooking(tenantId, sessionId, tenant, args as any);

      case 'lookup_booking':
        return await handleLookupBooking(tenantId, args as any);

      case 'reschedule_booking':
        return await handleRescheduleBooking(tenantId, sessionId, tenant, args as any);

      case 'cancel_booking':
        return await handleCancelBooking(tenantId, sessionId, args as any);

      case 'create_inquiry':
        return await handleCreateInquiry(tenantId, sessionId, args as any);

      case 'schedule_contact_followup':
        return await handleScheduleContactFollowup(tenantId, sessionId, args as any);

      case 'debug_availability':
        return await handleDebugAvailability(tenant, args as any);

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error: any) {
    // ── Structured error logging (safe for prod) ────────────
    const correlationId = randomUUID().replace(/-/g, '').slice(0, 12);
    const emailRaw: string = args?.client_email ?? '';
    const emailHash = emailRaw
      ? createHash('sha256').update(emailRaw.toLowerCase()).digest('hex').slice(0, 12)
      : 'n/a';
    const errorCode = classifyToolError(error);
    const errorMsg = error instanceof Error ? error.message : String(error);

    console.error(
      `[tool-error] ref=${correlationId} tool=${toolName} tenant=${tenantId} ` +
      `session=${sessionId} email_hash=${emailHash} code=${errorCode} msg=${errorMsg}`,
    );

    // ── Known domain errors → actionable user-facing messages ──
    if (error instanceof BookingError) {
      return { success: false, error: `BOOKING_ERROR: ${error.message}` };
    }
    if (error instanceof SlotConflictError) {
      return {
        success: false,
        error: 'SLOT_CONFLICT: That time slot is no longer available — it was just booked by someone else. Please ask the customer to pick a different time, or call check_availability to see what\'s open.',
      };
    }
    if (error instanceof CalendarReadError) {
      return {
        success: false,
        error: 'CALENDAR_UNAVAILABLE: Unable to check the calendar right now. Please ask the customer to try again in a moment.',
      };
    }

    // ── Unknown/system errors → generic message WITH reference id ──
    return {
      success: false,
      error: `INTERNAL_ERROR: Something went wrong while processing this request. ` +
        `Please ask the customer to try again. If the issue persists, reference ID: ${correlationId}`,
    };
  }
}

/**
 * Classify an error into a stable code for logging / metrics.
 * Does NOT expose codes to the user — only used in structured logs.
 */
function classifyToolError(error: unknown): string {
  if (error instanceof BookingError) return 'BOOKING_ERROR';
  if (error instanceof SlotConflictError) return 'SLOT_CONFLICT';
  if (error instanceof CalendarReadError) return 'CALENDAR_READ_ERROR';
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('calendar') || msg.includes('Calendar')) return 'CALENDAR_WRITE_ERROR';
    if (msg.includes('23P01')) return 'DB_EXCLUSION_CONFLICT';
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'TIMEOUT';
    if (msg.includes('connect') || msg.includes('ECONNREFUSED')) return 'CONNECTION_ERROR';
  }
  return 'UNKNOWN';
}
async function handleCheckAvailability(
  tenantId: string,
  sessionId: string,
  tenant: Tenant,
  args: { start_date: string; end_date: string; service_name?: string },
): Promise<ToolResult> {
  const fromDate = new Date(args.start_date);
  const toDate = new Date(args.end_date);

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return { success: false, error: 'Invalid date format. Use ISO-8601.' };
  }

  // ── Behavioral risk check (excessive availability probing) ──
  // Gracefully degrade: if DB/risk query fails, allow the request through.
  try {
    const { query } = await import('../db/client.js');
    const { buildRiskContext, calculateRiskScore, getRiskDecision } =
      await import('../security/risk-engine.js');
    // No email known yet — use empty string; scoring relies on session-level signals
    const riskCtx = await buildRiskContext({ query }, {
      email: '',
      tenantId,
      sessionId,
    });
    const riskScore = calculateRiskScore(riskCtx);
    const riskDecision = getRiskDecision(riskScore);

    if (riskDecision.action === 'cooldown') {
      const secs = riskDecision.cooldownSeconds ?? 300;
      const mins = Math.ceil(secs / 60);
      return {
        success: false,
        error: `RISK_COOLDOWN: We've noticed unusual activity on this session. Please wait about ${mins} minute${mins === 1 ? '' : 's'} before trying again.`,
      };
    }
  } catch {
    // Risk check is best-effort for availability queries — don't block on failure.
  }

  // ── Guardrail 1a: Service disambiguation ────────────────
  // When a tenant offers multiple services AND uses catalog_only mode,
  // the caller MUST specify which service so the correct duration is used.
  const catalogMode = tenant.service_catalog_mode ?? 'catalog_only';

  if (catalogMode === 'catalog_only') {
    if (tenant.services.length > 1 && !args.service_name) {
      const serviceList = tenant.services.map((s) => s.name).join(', ');
      return {
        success: false,
        error: `SERVICE_REQUIRED: This business offers multiple services (${serviceList}). Please ask the user which service they need, then call check_availability again with the service_name parameter.`,
      };
    }

    // Validate service_name against catalog
    if (args.service_name) {
      const match = tenant.services.find(
        (s) => s.name.toLowerCase() === args.service_name!.toLowerCase(),
      );
      if (!match) {
        const serviceList = tenant.services.map((s) => s.name).join(', ');
        return {
          success: false,
          error: `Unknown service "${args.service_name}". Available services: ${serviceList}. Please ask the user to choose one.`,
        };
      }
    }
  } else if (catalogMode === 'hybrid') {
    // Hybrid: if multiple services and no name provided, still ask
    if (tenant.services.length > 1 && !args.service_name) {
      const serviceList = tenant.services.map((s) => s.name).join(', ');
      return {
        success: false,
        error: `SERVICE_REQUIRED: This business offers multiple services (${serviceList}). Please ask the user which service they need (or they can describe a custom service), then call check_availability again with the service_name parameter.`,
      };
    }
    // In hybrid mode, don't reject unknown service names — accept custom descriptions
  }
  // free_text mode: no service validation at all — accept anything

  // ── Guardrail 1b: Date-range cap ───────────────────────
  // Reject unreasonably wide queries (> MAX_AVAILABILITY_RANGE_DAYS).
  const rangeDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
  if (rangeDays > MAX_AVAILABILITY_RANGE_DAYS) {
    return {
      success: false,
      error: `DATE_RANGE_TOO_WIDE: The requested range spans ${Math.ceil(rangeDays)} days, but the maximum allowed is ${MAX_AVAILABILITY_RANGE_DAYS} days. Please narrow the date range by asking the user for a more specific time window.`,
    };
  }

  const result = await availabilityService.getAvailableSlots(tenant, fromDate, toDate);
  const availableSlots = result.slots.filter((s) => s.available);

  // Format times in tenant timezone for readability
  const formatted = availableSlots.map((s) => {
    const startLocal = toZonedTime(new Date(s.start), tenant.timezone);
    return {
      start: s.start,
      end: s.end,
      display_time: format(startLocal, 'EEEE, MMMM d, yyyy h:mm a'),
    };
  });

  return {
    success: true,
    data: {
      available_slots: formatted,
      total_available: formatted.length,
      timezone: tenant.timezone,
      verified: result.verified,
      ...(result.calendarSource && { calendar_source: result.calendarSource }),
      ...(result.calendarError && { calendar_error: result.calendarError }),
    },
  };
}

async function handleHoldSlot(
  tenantId: string,
  sessionId: string,
  tenant: Tenant,
  args: { start_time: string; end_time: string; far_date_confirmed?: boolean },
): Promise<ToolResult> {
  const startTime = new Date(args.start_time);
  const endTime = new Date(args.end_time);

  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
    return { success: false, error: 'Invalid date format. Use ISO-8601.' };
  }

  // ── Guardrail 2: Far-future date gate ──────────────────
  // Uses tenant timezone so "30 days from today" is computed in the
  // business's local time, not UTC.
  const { env } = await import('../config/env.js');
  const farDays = env.BOOKING_FAR_DATE_CONFIRM_DAYS;
  if (farDays > 0) {
    const tz = tenant.timezone;
    const days = daysFromNow(startTime, tz);

    if (days > farDays && !args.far_date_confirmed) {
      return {
        success: false,
        error: `FAR_DATE_CONFIRMATION_REQUIRED: The requested date is ${days} days from today, which exceeds the ${farDays}-day threshold. Before holding this slot, you MUST ask the user: "Just to confirm — you'd like to book on ${format(startTime, 'MMMM d, yyyy')}, which is about ${days} days from now. Shall I go ahead?" If they confirm, call hold_slot again with far_date_confirmed=true.`,
      };
    }
  }

  const hold = await availabilityService.holdSlot(
    tenantId,
    sessionId,
    startTime,
    endTime,
  );

  return {
    success: true,
    data: {
      hold_id: hold.id,
      start_time: hold.start_time,
      end_time: hold.end_time,
      expires_at: hold.expires_at,
      message: 'Slot held for 5 minutes. Please collect client details and confirm.',
    },
  };
}

async function handleConfirmBooking(
  tenantId: string,
  sessionId: string,
  tenant: Tenant,
  args: {
    hold_id: string;
    client_name: string;
    client_email: string;
    client_phone: string;
    client_notes?: string;
    service?: string;
  },
): Promise<ToolResult> {
  const { normalizePhone } = await import('../voice/phone-normalizer.js');
  const { auditRepo: auditLog } = await import('../repos/audit.repo.js');
  const { query } = await import('../db/client.js');
  const { buildRiskContext, getRiskDecision, calculateRiskScore, getExistingActiveBookings } =
    await import('../security/risk-engine.js');

  // ── Email Verification Gate ────────────────────────────
  // Booking requires a verified email session. If the user
  // hasn't verified, or the booking email differs from the
  // verified email, reject and ask to verify first.
  const { sessionRepo: sessRepo } = await import('../repos/session.repo.js');
  const { getFsmContext: getFsm } = await import('./chat-fsm.js');

  const sess = await sessRepo.findById(sessionId);
  if (sess) {
    const fsm = getFsm((sess.metadata ?? {}) as Record<string, unknown>);
    const isVerified = sess.email_verified || fsm.verifiedEmail !== null;
    const verifiedEmail = fsm.verifiedEmail;

    // Gate 1: session not verified at all
    if (!isVerified) {
      return {
        success: false,
        error: 'EMAIL_VERIFICATION_REQUIRED: The customer must verify their email before booking. Ask them to provide their email so we can send a verification code.',
      };
    }

    // Gate 2: booking email doesn't match verified email → force re-verify
    if (verifiedEmail && args.client_email.toLowerCase() !== verifiedEmail.toLowerCase()) {
      return {
        success: false,
        error: `EMAIL_MISMATCH: The booking email (${maskEmail(args.client_email)}) does not match the verified email (${maskEmail(verifiedEmail)}). The customer must verify the new email before booking. Ask them to verify their new email first.`,
      };
    }
  }

  // ── Behavioral Risk Assessment ─────────────────────────
  const riskCtx = await buildRiskContext({ query }, {
    email: args.client_email,
    tenantId,
    sessionId,
  });
  const riskScore = calculateRiskScore(riskCtx);
  const riskDecision = getRiskDecision(riskScore);

  // Audit the risk decision regardless of outcome
  await auditLog.log({
    tenant_id: tenantId,
    event_type: 'booking.risk_assessed',
    entity_type: 'session',
    entity_id: sessionId,
    actor: 'confirm_booking',
    payload: {
      email: args.client_email,
      score: riskScore,
      action: riskDecision.action,
      reason: riskDecision.reason,
    },
  });

  if (riskDecision.action === 'cooldown') {
    const secs = riskDecision.cooldownSeconds ?? 300;
    const mins = Math.ceil(secs / 60);
    return {
      success: false,
      error: `RISK_COOLDOWN: We've noticed unusual activity on this session. For your security, please wait about ${mins} minute${mins === 1 ? '' : 's'} before trying again.`,
    };
  }

  if (riskDecision.action === 'reverify') {
    return {
      success: false,
      error: 'RISK_REVERIFY: For your security, we need to re-verify your email address before completing this booking. Please confirm your email so we can send a new verification code.',
    };
  }

  // ── Existing-booking awareness (informational, not blocking) ──
  const existingBookings = await getExistingActiveBookings({ query }, args.client_email, tenantId);
  let existingBookingSummary: string | undefined;
  if (existingBookings.length > 0) {
    const summaryLines = existingBookings.map(
      (b) => `  • ${b.reference_code} on ${b.start_time}${b.service ? ` (${b.service})` : ''}`,
    );
    existingBookingSummary =
      `Note: This client already has ${existingBookings.length} upcoming booking(s):\n` +
      summaryLines.join('\n');
  }

  // ── Guardrail: phone is REQUIRED for all new bookings ──
  if (!args.client_phone) {
    return {
      success: false,
      error: 'PHONE_REQUIRED: A phone number is required to complete the booking. Please ask the customer for their phone number before confirming.',
    };
  }

  // ── Normalize phone to E.164 ──
  const normalizedPhone = normalizePhone(args.client_phone);
  if (!normalizedPhone) {
    return {
      success: false,
      error: 'INVALID_PHONE: The phone number provided is not valid. Please ask the customer to re-enter their phone number (e.g., (555) 123-4567 or +15551234567).',
    };
  }

  const appointment = await bookingService.confirmBooking({
    tenant_id: tenantId,
    session_id: sessionId,
    hold_id: args.hold_id,
    client_name: args.client_name,
    client_email: args.client_email,
    client_notes: args.client_notes,
    client_phone: normalizedPhone,
    service: args.service,
    timezone: tenant.timezone,
  });

  // ── Audit: phone captured (PII-safe — only prefix) ──
  await auditLog.log({
    tenant_id: tenantId,
    event_type: 'booking.phone_captured',
    entity_type: 'appointment',
    entity_id: appointment.id,
    actor: 'confirm_booking',
    payload: {
      reference_code: appointment.reference_code,
      phone_prefix: normalizedPhone.slice(0, 5) + '…',
    },
  });

  const startLocal = toZonedTime(new Date(appointment.start_time), tenant.timezone);

  // ── Generate "Add to Calendar" .ics download URL ──
  const { buildIcsDataUrl } = await import('../utils/add-to-calendar.js');
  const addToCalendarUrl = buildIcsDataUrl({
    title: `${appointment.service ?? 'Appointment'}`,
    startUtc: new Date(appointment.start_time),
    endUtc: new Date(appointment.end_time),
    description: `Ref: ${appointment.reference_code}\nPhone: ${normalizedPhone}\nBooked via gomomo.ai`,
  });

  // ── Determine SMS delivery status hint ──
  // The actual SMS fires asynchronously via on-booking-created event,
  // so we can't know the result yet. We report what WILL happen.
  const { env: envConfig } = await import('../config/env.js');
  const { getTwilioVerifyResult } = await import('../voice/sms-sender.js');
  const twilioConfigured = !!envConfig.TWILIO_ACCOUNT_SID &&
    !!envConfig.TWILIO_AUTH_TOKEN &&
    (!!envConfig.TWILIO_PHONE_NUMBER || !!envConfig.TWILIO_MESSAGING_SERVICE_SID);

  // Check live verification result — if auth failed, SMS won't work even if configured
  const verifyResult = getTwilioVerifyResult();
  const authFailed = verifyResult && !verifyResult.verified && verifyResult.credentialMode === 'invalid';

  const smsStatus = !normalizedPhone
    ? 'no_phone'
    : envConfig.FEATURE_SMS === 'false'
      ? 'disabled'
      : authFailed
        ? 'unavailable'
        : twilioConfigured
          ? 'will_send'
          : 'simulator';

  return {
    success: true,
    data: {
      appointment_id: appointment.id,
      reference_code: appointment.reference_code,
      client_name: appointment.client_name,
      client_email: appointment.client_email,
      service: appointment.service,
      start_time: appointment.start_time,
      end_time: appointment.end_time,
      display_time: format(startLocal, 'EEEE, MMMM d, yyyy h:mm a'),
      timezone: tenant.timezone,
      add_to_calendar_url: addToCalendarUrl,
      sms_status: smsStatus,
      ...(existingBookingSummary ? { existing_booking_note: existingBookingSummary } : {}),
      message: smsStatus === 'will_send'
        ? 'Appointment confirmed! A confirmation SMS is being sent to the phone number provided.'
        : smsStatus === 'unavailable'
          ? 'Appointment confirmed! SMS is currently unavailable — the confirmation will be sent once the issue is resolved.'
          : smsStatus === 'simulator'
            ? 'Appointment confirmed! (SMS delivery is in demo mode — no real text message will be sent.)'
            : 'Appointment confirmed successfully!',
    },
  };
}

async function handleLookupBooking(
  tenantId: string,
  args: { reference_code?: string; email?: string },
): Promise<ToolResult> {
  if (!args.reference_code && !args.email) {
    return { success: false, error: 'Please provide a reference code or email address.' };
  }

  const appointments = await bookingService.lookup(tenantId, {
    reference: args.reference_code,
    email: args.email,
  });

  if (appointments.length === 0) {
    return {
      success: true,
      data: {
        appointments: [],
        message: 'No active appointments found with the provided information.',
      },
    };
  }

  return {
    success: true,
    data: {
      appointments: appointments.map((a) => ({
        appointment_id: a.id,
        reference_code: a.reference_code,
        client_name: a.client_name,
        client_email: a.client_email,
        service: a.service,
        start_time: a.start_time,
        end_time: a.end_time,
        status: a.status,
        timezone: a.timezone,
      })),
    },
  };
}

async function handleRescheduleBooking(
  tenantId: string,
  sessionId: string,
  tenant: Tenant,
  args: { appointment_id: string; new_hold_id: string },
): Promise<ToolResult> {
  const newAppointment = await bookingService.reschedule({
    appointment_id: args.appointment_id,
    tenant_id: tenantId,
    session_id: sessionId,
    new_hold_id: args.new_hold_id,
    timezone: tenant.timezone,
  });

  const startLocal = toZonedTime(new Date(newAppointment.start_time), tenant.timezone);

  return {
    success: true,
    data: {
      appointment_id: newAppointment.id,
      reference_code: newAppointment.reference_code,
      start_time: newAppointment.start_time,
      end_time: newAppointment.end_time,
      display_time: format(startLocal, 'EEEE, MMMM d, yyyy h:mm a'),
      timezone: tenant.timezone,
      message: 'Appointment rescheduled successfully!',
    },
  };
}

async function handleCancelBooking(
  tenantId: string,
  sessionId: string,
  args: { reference_code: string; phone_last4?: string },
): Promise<ToolResult> {
  const { auditRepo } = await import('../repos/audit.repo.js');
  const { sessionRepo } = await import('../repos/session.repo.js');
  const { customerRepo } = await import('../repos/customer.repo.js');

  const GENERIC_FAIL = "CANCELLATION_FAILED: I can't find a booking with that information. Please double-check your confirmation number and try again.";

  // ── Guardrail: reference_code is always required ──
  if (!args.reference_code) {
    return {
      success: false,
      error: 'CANCELLATION_REQUIRES_VERIFICATION: To cancel an appointment, you MUST collect the confirmation number from the customer first. Ask for it before trying again.',
    };
  }

  // ── Audit: verification attempted ──
  await auditRepo.log({
    tenant_id: tenantId,
    event_type: 'booking.verification_attempted',
    entity_type: 'appointment',
    entity_id: null,
    actor: 'cancel_booking_guard',
    payload: { action: 'cancel' },
  });

  // ── Build deps for the pure verification function ──
  const deps: CancelVerificationDeps = {
    lookupByReference: async (refCode, tid) => {
      const results = await bookingService.lookup(tid, { reference: refCode });
      return results[0] ?? null;
    },
    getSessionCustomer: async (sid) => {
      const session = await sessionRepo.findById(sid);
      if (!session) return null;
      return {
        customerId: session.customer_id,
        emailVerified: session.email_verified,
      };
    },
    getCustomerContact: async (customerId) => {
      const customer = await customerRepo.findById(customerId);
      if (!customer) return null;
      return { email: customer.email, phone: customer.phone };
    },
  };

  // ── Run verification ──
  const result = await verifyCancellation(
    {
      referenceCode: args.reference_code,
      tenantId,
      sessionId,
      phoneLast4: args.phone_last4,
    },
    deps,
  );

  if (!result.ok) {
    const reason = result.reason;
    console.log(`[cancel-guard] Failed cancellation attempt — ${reason} (tenant: ${tenantId.slice(0, 8)}…)`);
    await auditRepo.log({
      tenant_id: tenantId,
      event_type: 'booking.verification_failed',
      entity_type: 'appointment',
      entity_id: null,
      actor: 'cancel_booking_guard',
      payload: { reason, action: 'cancel' },
    });

    // All failures return the same generic message — no PII leaks
    if (reason === 'missing_ref_code') {
      return {
        success: false,
        error: 'CANCELLATION_REQUIRES_VERIFICATION: To cancel an appointment, you MUST collect the confirmation number from the customer first. Ask for it before trying again.',
      };
    }

    if (reason === 'missing_verification') {
      return {
        success: false,
        error: 'CANCELLATION_NEEDS_IDENTITY: The session could not automatically verify the customer. Ask the customer for the last 4 digits of the phone number on their booking, then call cancel_booking again with phone_last4.',
      };
    }

    return { success: false, error: GENERIC_FAIL };
  }

  // ── Verified — proceed with cancellation ──
  await auditRepo.log({
    tenant_id: tenantId,
    event_type: 'booking.verification_succeeded',
    entity_type: 'appointment',
    entity_id: result.booking.id,
    actor: 'cancel_booking_guard',
    payload: { action: 'cancel', method: result.method },
  });

  const cancelled = await bookingService.cancel(result.booking.id, tenantId);

  return {
    success: true,
    data: {
      appointment_id: cancelled.id,
      reference_code: cancelled.reference_code,
      status: 'cancelled',
      message: 'Appointment cancelled successfully.',
    },
  };
}

async function handleCreateInquiry(
  tenantId: string,
  sessionId: string,
  args: {
    client_name: string;
    client_email: string;
    preferred_service?: string;
    preferred_days?: string[];
    preferred_time_start?: string;
    preferred_time_end?: string;
  },
): Promise<ToolResult> {
  if (!args.client_name || !args.client_email) {
    return { success: false, error: 'Client name and email are required for the waitlist.' };
  }

  const entry = await waitlistRepo.create({
    tenant_id: tenantId,
    session_id: sessionId,
    client_name: args.client_name,
    client_email: args.client_email,
    preferred_service: args.preferred_service,
    preferred_days: args.preferred_days,
    preferred_time_range: (args.preferred_time_start || args.preferred_time_end)
      ? { start: args.preferred_time_start, end: args.preferred_time_end }
      : undefined,
  });

  return {
    success: true,
    data: {
      waitlist_entry_id: entry.id,
      client_name: entry.client_name,
      client_email: entry.client_email,
      preferred_service: entry.preferred_service,
      status: 'waiting',
      message: 'You\'ve been added to our waitlist! We\'ll notify you by email as soon as a matching time slot opens up.',
    },
  };
}

async function handleScheduleContactFollowup(
  tenantId: string,
  sessionId: string,
  args: {
    client_name: string;
    client_email: string;
    client_phone?: string;
    preferred_contact: 'email' | 'sms' | 'either';
    reason: string;
    preferred_service?: string;
    notes?: string;
  },
): Promise<ToolResult> {
  if (!args.client_name || !args.client_email) {
    return { success: false, error: 'Client name and email are required to schedule a follow-up.' };
  }

  if (args.preferred_contact === 'sms' && !args.client_phone) {
    return { success: false, error: 'A phone number is required when preferred contact method is SMS. Please ask the user for their phone number.' };
  }

  // ── Import dependencies (lazy to keep top-level light) ────
  const { policyEngine } = await import('../orchestrator/policy-engine.js');
  const { jobRepo } = await import('../repos/job.repo.js');
  const { auditRepo } = await import('../repos/audit.repo.js');
  const { followupTrackingRepo } = await import('../repos/followup-tracking.repo.js');
  const { eventBus } = await import('../orchestrator/event-bus.js');
  const { env } = await import('../config/env.js');

  const channel = args.preferred_contact === 'sms' ? 'sms' : 'email';

  // ── Guardrail 1: Per-session follow-up limit ──────────────
  const currentCount = await followupTrackingRepo.countBySession(sessionId);
  const maxAllowed = env.FOLLOWUP_MAX_PER_BOOKING;

  if (currentCount >= maxAllowed) {
    // Emit audit event
    await eventBus.emit({
      name: 'FollowupLimitReached' as const,
      tenant_id: tenantId,
      session_id: sessionId,
      current_count: currentCount,
      max_allowed: maxAllowed,
      channel,
      client_email: args.client_email,
      timestamp: new Date().toISOString(),
    });

    await auditRepo.log({
      tenant_id: tenantId,
      event_type: 'followup.limit_reached',
      entity_type: 'session',
      entity_id: sessionId,
      actor: 'agent',
      payload: {
        current_count: currentCount,
        max_allowed: maxAllowed,
        channel,
      },
    });

    return {
      success: false,
      error: `Follow-up limit reached: ${currentCount} of ${maxAllowed} follow-ups already scheduled for this conversation. The user has already been contacted the maximum number of times. Please let them know and suggest they call directly if they need further assistance.`,
    };
  }

  // ── Guardrail 2: Cooldown enforcement ─────────────────────
  const cooldownMinutes = env.FOLLOWUP_COOLDOWN_MINUTES;
  if (cooldownMinutes > 0) {
    const lastFollowup = await followupTrackingRepo.lastFollowupTo(args.client_email);
    if (lastFollowup) {
      const lastTime = new Date(lastFollowup.created_at).getTime();
      const cooldownMs = cooldownMinutes * 60 * 1000;
      const now = Date.now();

      if (now - lastTime < cooldownMs) {
        const minutesRemaining = Math.ceil((cooldownMs - (now - lastTime)) / 60000);

        await eventBus.emit({
          name: 'FollowupCooldownBlocked' as const,
          tenant_id: tenantId,
          session_id: sessionId,
          channel,
          client_email: args.client_email,
          cooldown_minutes: cooldownMinutes,
          last_followup_at: lastFollowup.created_at.toISOString(),
          timestamp: new Date().toISOString(),
        });

        await auditRepo.log({
          tenant_id: tenantId,
          event_type: 'followup.cooldown_blocked',
          entity_type: 'session',
          entity_id: sessionId,
          actor: 'agent',
          payload: {
            channel,
            cooldown_minutes: cooldownMinutes,
            minutes_remaining: minutesRemaining,
          },
        });

        return {
          success: false,
          error: `A follow-up was recently sent to this contact (cooldown: ${cooldownMinutes} minutes, ~${minutesRemaining} min remaining). Please let the user know we'll be in touch soon and to check their ${channel === 'sms' ? 'messages' : 'inbox'}.`,
        };
      }
    }
  }

  // ── Guardrail 3: Confirmation for additional contacts ─────
  // If there's already at least one follow-up, the tool result
  // tells the model to ask for confirmation. The model will
  // re-call the tool after user confirms.
  if (currentCount > 0 && !args.notes?.includes('__confirmed_additional__')) {
    await auditRepo.log({
      tenant_id: tenantId,
      event_type: 'followup.additional_confirmation_required',
      entity_type: 'session',
      entity_id: sessionId,
      actor: 'agent',
      payload: {
        current_count: currentCount,
        max_allowed: maxAllowed,
        channel,
        reason: args.reason,
      },
    });

    return {
      success: false,
      error: `CONFIRMATION_REQUIRED: There is already ${currentCount} follow-up scheduled for this conversation (max: ${maxAllowed}). Before scheduling another, you MUST ask the user: "I've already scheduled ${currentCount === 1 ? 'a' : currentCount} follow-up${currentCount > 1 ? 's' : ''}. Do you also want me to ${channel === 'sms' ? 'send a text to this number' : 'send another email'}?" If they confirm, call schedule_contact_followup again with "__confirmed_additional__" appended to the notes field.`,
    };
  }

  // ── Policy engine check ───────────────────────────────────
  const decision = await policyEngine.evaluate('send_contact_followup', tenantId, {
    channel,
    reason: args.reason,
    max_followup_count: maxAllowed,
    current_followup_count: currentCount,
  });

  if (decision.effect === 'deny') {
    return {
      success: false,
      error: `Follow-up not permitted by policy: ${decision.reason}. Please try again later or use a different contact method.`,
    };
  }

  // ── Enqueue follow-up job ─────────────────────────────────
  const cleanNotes = (args.notes ?? '').replace('__confirmed_additional__', '').trim() || null;

  const job = await jobRepo.create({
    tenant_id: tenantId,
    type: 'send_contact_followup',
    payload: {
      session_id: sessionId,
      client_name: args.client_name,
      client_email: args.client_email,
      client_phone: args.client_phone ?? null,
      preferred_contact: args.preferred_contact,
      reason: args.reason,
      preferred_service: args.preferred_service ?? null,
      notes: cleanNotes,
    },
    priority: 5,
    run_at: new Date(),
    max_attempts: 3,
    source_event: 'chat.followup_requested',
  });

  // ── Track the follow-up ───────────────────────────────────
  await followupTrackingRepo.record({
    tenant_id: tenantId,
    session_id: sessionId,
    client_email: args.client_email,
    client_phone: args.client_phone ?? null,
    channel,
    reason: args.reason,
    job_id: job.id,
  });

  // ── Audit the scheduling ──────────────────────────────────
  await auditRepo.log({
    tenant_id: tenantId,
    event_type: 'followup.scheduled',
    entity_type: 'job',
    entity_id: job.id,
    actor: 'agent',
    payload: {
      session_id: sessionId,
      preferred_contact: args.preferred_contact,
      reason: args.reason,
      channel,
      followup_number: currentCount + 1,
      max_allowed: maxAllowed,
    },
  });

  const remainingFollowups = maxAllowed - (currentCount + 1);

  return {
    success: true,
    data: {
      followup_id: job.id,
      followup_scheduled: true,
      contact_method: channel,
      expected_timeframe: 'shortly',
      client_name: args.client_name,
      client_email: args.client_email,
      reason: args.reason,
      followup_number: currentCount + 1,
      remaining_followups: remainingFollowups,
      message: `We've scheduled a follow-up. We'll ${channel === 'sms' ? 'text' : 'email'} you with available options shortly.${remainingFollowups === 0 ? ' (This is the last follow-up available for this conversation.)' : ''}`,
    },
  };
}

// ── Debug Availability (DEV ONLY) ───────────────────────────────
async function handleDebugAvailability(
  tenant: Tenant,
  args: { date: string; start?: string; end?: string },
): Promise<ToolResult> {
  if (env.CALENDAR_DEBUG !== 'true') {
    return { success: false, error: 'Debug tool is disabled (CALENDAR_DEBUG is not true).' };
  }

  const { date, start = '00:00', end = '23:59' } = args;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { success: false, error: 'date must be in YYYY-MM-DD format.' };
  }

  const tz = tenant.timezone;
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const [year, month, day] = date.split('-').map(Number);

  const fromDate = fromZonedTime(new Date(year, month - 1, day, startH, startM, 0), tz);
  const toDate = fromZonedTime(new Date(year, month - 1, day, endH, endM, 0), tz);

  try {
    const result = await availabilityService.getAvailableSlots(tenant, fromDate, toDate);
    const snapshot = getCalendarDebugSnapshot(tenant.id);

    const availableSlots = result.slots.filter(s => s.available);
    const excludedSlots = result.slots.filter(s => !s.available);

    return {
      success: true,
      data: {
        query: { date, start, end, timezone: tz },
        total_slots: result.slots.length,
        available: availableSlots.length,
        excluded: excludedSlots.length,
        verified: result.verified,
        calendar_source: result.calendarSource ?? 'none',
        busy_ranges: snapshot?.busy_ranges_fetched ?? [],
        available_times: availableSlots.map(s => {
          const z = toZonedTime(new Date(s.start), tz);
          return format(z, 'h:mm a');
        }),
        excluded_times: excludedSlots.map(s => {
          const z = toZonedTime(new Date(s.start), tz);
          return { time: format(z, 'h:mm a'), reason: 'busy_overlap' };
        }),
        exclusion_breakdown: snapshot ? {
          by_busy: snapshot.slots_excluded_by_busy,
          by_appointments: snapshot.slots_excluded_by_appointments,
          by_holds: snapshot.slots_excluded_by_holds,
          by_past: snapshot.slots_excluded_by_past,
        } : null,
      },
    };
  } catch (err: unknown) {
    if (err instanceof CalendarReadError) {
      return { success: false, error: `Calendar read failed: ${(err as CalendarReadError).message}` };
    }
    throw err;
  }
}
