/**
 * Voice Tool Executor
 *
 * Bridges the voice session state machine to the SAME backend tools
 * used by web chat. Every scheduling action goes through the existing
 * tool-executor.ts which calls bookingService / availabilityService.
 *
 * THIS FILE DOES NOT DUPLICATE BOOKING LOGIC. It translates voice
 * session fields into the args that executeToolCall() expects.
 */

import { executeToolCall } from '../agent/tool-executor.js';
import type { Tenant } from '../domain/types.js';
import type { VoiceSession } from '../domain/types.js';

// ── Check Availability ──────────────────────────────────────────

export async function voiceCheckAvailability(
  session: VoiceSession,
  tenant: Tenant,
  dateStr: string, // "2026-02-10"
): Promise<{
  success: boolean;
  slots: Array<{ start: string; end: string; display_time: string }>;
  error?: string;
}> {
  const startDate = `${dateStr}T00:00:00`;
  const endDate = `${dateStr}T23:59:59`;

  const result = await executeToolCall(
    'check_availability',
    { start_date: startDate, end_date: endDate },
    session.tenantId,
    session.sessionId,
    tenant,
  );

  if (!result.success) {
    return { success: false, slots: [], error: result.error };
  }

  const available = result.data?.available_slots ?? [];
  return { success: true, slots: available };
}

// ── Hold Slot ───────────────────────────────────────────────────

export async function voiceHoldSlot(
  session: VoiceSession,
  tenant: Tenant,
  startTime: string,
  endTime: string,
): Promise<{ success: boolean; holdId?: string; error?: string }> {
  const result = await executeToolCall(
    'hold_slot',
    { start_time: startTime, end_time: endTime },
    session.tenantId,
    session.sessionId,
    tenant,
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true, holdId: result.data?.hold_id };
}

// ── Confirm Booking ─────────────────────────────────────────────

export async function voiceConfirmBooking(
  session: VoiceSession,
  tenant: Tenant,
): Promise<{
  success: boolean;
  referenceCode?: string;
  displayTime?: string;
  appointmentId?: string;
  error?: string;
}> {
  if (!session.holdId || !session.clientName || !session.clientEmail) {
    return { success: false, error: 'Missing required booking details.' };
  }

  // Phone is required for all new bookings.
  // Voice path uses the caller's phone; if unavailable the voice state
  // machine must have already prompted for it.
  const phone = session.callerPhone ?? null;
  if (!phone) {
    return { success: false, error: 'Missing phone number. A phone number is required to complete the booking.' };
  }

  const result = await executeToolCall(
    'confirm_booking',
    {
      hold_id: session.holdId,
      client_name: session.clientName,
      client_email: session.clientEmail,
      client_phone: phone,
      client_notes: session.clientNotes ?? undefined,
      service: session.service ?? undefined,
    },
    session.tenantId,
    session.sessionId,
    tenant,
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    referenceCode: result.data?.reference_code,
    displayTime: result.data?.display_time,
    appointmentId: result.data?.appointment_id,
  };
}

// ── Lookup Booking ──────────────────────────────────────────────

export async function voiceLookupBooking(
  session: VoiceSession,
  tenant: Tenant,
  query: { reference_code?: string; email?: string },
): Promise<{
  success: boolean;
  appointments: Array<{
    appointment_id: string;
    reference_code: string;
    service: string | null;
    start_time: string;
    status: string;
  }>;
  error?: string;
}> {
  const result = await executeToolCall(
    'lookup_booking',
    query,
    session.tenantId,
    session.sessionId,
    tenant,
  );

  if (!result.success) {
    return { success: false, appointments: [], error: result.error };
  }

  return {
    success: true,
    appointments: result.data?.appointments ?? [],
  };
}

// ── Reschedule Booking ──────────────────────────────────────────

export async function voiceRescheduleBooking(
  session: VoiceSession,
  tenant: Tenant,
): Promise<{
  success: boolean;
  referenceCode?: string;
  displayTime?: string;
  error?: string;
}> {
  if (!session.appointmentId || !session.holdId) {
    return { success: false, error: 'Missing appointment or hold reference.' };
  }

  const result = await executeToolCall(
    'reschedule_booking',
    {
      appointment_id: session.appointmentId,
      new_hold_id: session.holdId,
    },
    session.tenantId,
    session.sessionId,
    tenant,
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    referenceCode: result.data?.reference_code,
    displayTime: result.data?.display_time,
  };
}

// ── Cancel Booking ──────────────────────────────────────────────

export async function voiceCancelBooking(
  session: VoiceSession,
  tenant: Tenant,
): Promise<{ success: boolean; referenceCode?: string; error?: string }> {
  if (!session.referenceCode) {
    return { success: false, error: 'Missing appointment reference.' };
  }

  if (!session.callerPhone) {
    return { success: false, error: 'Missing phone number for verification.' };
  }

  const result = await executeToolCall(
    'cancel_booking',
    { reference_code: session.referenceCode, phone_number: session.callerPhone },
    session.tenantId,
    session.sessionId,
    tenant,
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    referenceCode: result.data?.reference_code,
  };
}
