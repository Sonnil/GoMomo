/**
 * Voice Conversation Engine
 *
 * State machine that processes each speech turn from Twilio's <Gather>.
 * Returns the next TwiML prompt for the caller.
 *
 * KEY INVARIANT: All booking operations go through voice-tool-executor.ts
 * which calls the SAME executeToolCall() used by web chat. No booking
 * logic is duplicated here.
 */

import type { Tenant, VoiceSession } from '../domain/types.js';
import { env } from '../config/env.js';
import {
  advanceState,
  setIntent,
  incrementRetry,
  incrementTurn,
  isCallExpired,
  isTurnLimitReached,
  isRetryLimitReached,
} from './session-manager.js';
import {
  detectIntent,
  detectYesNo,
  detectService,
  detectDate,
  detectSlotChoice,
  detectEmail,
  detectName,
  detectReferenceCode,
  detectHandoffRequest,
} from './nlu.js';
import {
  voiceCheckAvailability,
  voiceHoldSlot,
  voiceConfirmBooking,
  voiceLookupBooking,
  voiceRescheduleBooking,
  voiceCancelBooking,
} from './voice-tool-executor.js';
import { buildGatherTwiML, buildSayHangupTwiML, buildSayRedirectTwiML } from './twiml-builder.js';
import { createHandoffToken } from './handoff-token.js';
import { sendHandoffSms } from './sms-sender.js';

const BASE_URL = () => env.TWILIO_WEBHOOK_BASE_URL;
const CONTINUE_URL = () => `${BASE_URL()}/twilio/voice/continue`;

// ── Main Entry Point ────────────────────────────────────────────

/**
 * Process one speech turn. Returns TwiML string.
 */
export async function processVoiceTurn(
  session: VoiceSession,
  speechResult: string,
  tenant: Tenant,
  isTimeout: boolean,
): Promise<string> {
  incrementTurn(session);

  // ── Guard Rails ──────────────────────────────────────────────
  if (isCallExpired(session)) {
    advanceState(session, 'completed');
    return buildSayHangupTwiML(
      "I'm sorry, we've reached the time limit for this call. " +
      "Please call back or visit our website to complete your booking. Goodbye!",
    );
  }

  if (isTurnLimitReached(session)) {
    advanceState(session, 'completed');
    return buildSayHangupTwiML(
      "We've been chatting for a while. For the best experience, " +
      "please visit our website to complete your request. Thank you for calling!",
    );
  }

  // Handle silence/timeout
  if (isTimeout && !speechResult) {
    const retries = incrementRetry(session);
    if (isRetryLimitReached(session)) {
      advanceState(session, 'completed');
      return buildSayHangupTwiML(
        "I haven't heard from you, so I'll let you go. " +
        "Please call back anytime. Goodbye!",
      );
    }
    // Re-ask the last prompt
    return buildGatherTwiML({
      prompt: `I didn't catch that. ${session.lastPrompt}`,
      action: CONTINUE_URL(),
    });
  }

  // ── SMS Handoff Detection ────────────────────────────────────
  // If the caller explicitly asks for a text/SMS/online at any point,
  // offer to send them a link.
  if (speechResult && detectHandoffRequest(speechResult)) {
    return handleHandoffRequest(session, tenant);
  }

  // ── State Machine Dispatch ───────────────────────────────────
  switch (session.state) {
    case 'greeting':
    case 'collecting_intent':
      return handleIntentCollection(session, speechResult, tenant);

    case 'collecting_service':
      return handleServiceCollection(session, speechResult, tenant);

    case 'collecting_date':
      return handleDateCollection(session, speechResult, tenant);

    case 'offering_slots':
    case 'collecting_slot_choice':
      return handleSlotChoice(session, speechResult, tenant);

    case 'collecting_name':
      return handleNameCollection(session, speechResult, tenant);

    case 'collecting_email':
      return handleEmailCollection(session, speechResult, tenant);

    case 'confirming_booking':
      return handleBookingConfirmation(session, speechResult, tenant);

    case 'collecting_reference':
      return handleReferenceCollection(session, speechResult, tenant);

    case 'collecting_reschedule_date':
      return handleRescheduleDateCollection(session, speechResult, tenant);

    case 'offering_reschedule_slots':
      return handleRescheduleSlotChoice(session, speechResult, tenant);

    case 'confirming_reschedule':
      return handleRescheduleConfirmation(session, speechResult, tenant);

    case 'confirming_cancel':
      return handleCancelConfirmation(session, speechResult, tenant);

    default:
      return makePrompt(session, "I'm sorry, something went wrong. Let me start over. How can I help you?", 'collecting_intent');
  }
}

// ── State Handlers ──────────────────────────────────────────────

async function handleIntentCollection(
  session: VoiceSession,
  speech: string,
  _tenant: Tenant,
): Promise<string> {
  const intent = detectIntent(speech);

  if (intent === 'unknown') {
    const retries = incrementRetry(session);
    if (isRetryLimitReached(session)) {
      return makePrompt(session,
        "I can help you book, reschedule, or cancel an appointment. Which would you like?",
        'collecting_intent',
      );
    }
    return makePrompt(session,
      "I didn't quite get that. Would you like to book a new appointment, reschedule an existing one, or cancel?",
      'collecting_intent',
    );
  }

  setIntent(session, intent);

  if (intent === 'book') {
    return makePrompt(session,
      `Great, let's book an appointment! What service are you looking for?`,
      'collecting_service',
    );
  }

  if (intent === 'reschedule' || intent === 'cancel') {
    return makePrompt(session,
      `Sure, I can help you ${intent} an appointment. ` +
      `Could you tell me your booking reference code? It starts with A P T.`,
      'collecting_reference',
    );
  }

  // Shouldn't reach here
  return makePrompt(session, "How can I help you today?", 'collecting_intent');
}

async function handleServiceCollection(
  session: VoiceSession,
  speech: string,
  tenant: Tenant,
): Promise<string> {
  const services = (tenant.services ?? []).map((s) => s.name);
  const detected = detectService(speech, services);

  if (!detected) {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      // Default to first service
      session.service = services[0] ?? 'General Appointment';
      return makePrompt(session,
        `I'll go ahead with ${session.service}. What date works best for you?`,
        'collecting_date',
      );
    }
    const list = services.map((s, i) => `${i + 1}. ${s}`).join('. ');
    return makePrompt(session,
      `I didn't catch the service. We offer: ${list}. Which would you like?`,
      'collecting_service',
    );
  }

  session.service = detected;
  return makePrompt(session,
    `${detected}, perfect! What date would you prefer?`,
    'collecting_date',
  );
}

async function handleDateCollection(
  session: VoiceSession,
  speech: string,
  tenant: Tenant,
): Promise<string> {
  const date = detectDate(speech, tenant.timezone);

  if (!date) {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      advanceState(session, 'completed');
      return buildSayHangupTwiML(
        "I'm having trouble understanding the date. Please try calling back or use our website. Goodbye!",
      );
    }
    return makePrompt(session,
      "I didn't catch that date. You can say something like tomorrow, next Monday, or February tenth.",
      'collecting_date',
    );
  }

  session.date = date;

  // Call the SAME availability engine used by web chat
  const result = await voiceCheckAvailability(session, tenant, date);

  if (!result.success) {
    return makePrompt(session,
      `I ran into an issue checking availability. ${result.error ?? 'Please try a different date.'}`,
      'collecting_date',
    );
  }

  if (result.slots.length === 0) {
    return makePrompt(session,
      `I'm sorry, there are no available slots on that date. Would you like to try a different date?`,
      'collecting_date',
    );
  }

  session.availableSlots = result.slots;

  // Present up to 5 slots
  const slotsToOffer = result.slots.slice(0, 5);
  const slotList = slotsToOffer
    .map((s, i) => `${i + 1}. ${s.display_time}`)
    .join('. ');

  const more = result.slots.length > 5
    ? ` I have ${result.slots.length} total slots available.`
    : '';

  return makePrompt(session,
    `Here are the available times: ${slotList}.${more} Which time works for you?`,
    'offering_slots',
  );
}

async function handleSlotChoice(
  session: VoiceSession,
  speech: string,
  tenant: Tenant,
): Promise<string> {
  const slotsToOffer = session.availableSlots.slice(0, 5);
  const chosen = detectSlotChoice(speech, slotsToOffer);

  if (!chosen) {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      // Default to first slot
      const first = slotsToOffer[0];
      if (!first) {
        return makePrompt(session, "Let's try again. What date would you prefer?", 'collecting_date');
      }
      session.selectedSlot = first;
    } else {
      return makePrompt(session,
        "I didn't catch which time you'd like. You can say the number, like 'the first one', or the time like '10 AM'.",
        'collecting_slot_choice',
      );
    }
  } else {
    session.selectedSlot = chosen;
  }

  // Hold the slot via the SAME backend
  const holdResult = await voiceHoldSlot(
    session,
    tenant,
    session.selectedSlot!.start,
    session.selectedSlot!.end,
  );

  if (!holdResult.success) {
    return makePrompt(session,
      `I'm sorry, that slot was just taken. ${holdResult.error ?? 'Let me check again.'}` +
      " Would you like to pick a different time?",
      'offering_slots',
    );
  }

  session.holdId = holdResult.holdId!;

  return makePrompt(session,
    `I've held that slot for you for 5 minutes. Now I need a few details. What is your full name?`,
    'collecting_name',
  );
}

async function handleNameCollection(
  session: VoiceSession,
  speech: string,
  _tenant: Tenant,
): Promise<string> {
  const name = detectName(speech);

  if (!name) {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      // Use raw speech as name
      session.clientName = speech.trim();
    } else {
      return makePrompt(session,
        "Could you please say your full name clearly?",
        'collecting_name',
      );
    }
  } else {
    session.clientName = name;
  }

  return makePrompt(session,
    `Got it, ${session.clientName}. And what's your email address?`,
    'collecting_email',
    'example at email dot com',
  );
}

async function handleEmailCollection(
  session: VoiceSession,
  speech: string,
  _tenant: Tenant,
): Promise<string> {
  const email = detectEmail(speech);

  if (!email) {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      // Offer SMS handoff instead of just hanging up — email is hard over the phone
      const handoffOffer = buildHandoffOfferPrompt(
        session,
        "I'm having trouble with the email. Please try our website to complete the booking. Goodbye!",
      );
      if (session.callerPhone && env.SMS_HANDOFF_ENABLED === 'true') {
        return makePrompt(session,
          "I'm having a hard time catching that email address. " +
          "Would you like me to text you a link so you can finish booking online? " +
          "Just say 'text me' or try the email again.",
          'collecting_email',
          'text me, send a text, example at email dot com',
        );
      }
      advanceState(session, 'completed');
      return buildSayHangupTwiML(handoffOffer);
    }
    return makePrompt(session,
      "I didn't catch that email. Please say it slowly, like 'alex at example dot com'.",
      'collecting_email',
      'example at email dot com',
    );
  }

  session.clientEmail = email;

  // Summarize and ask for confirmation
  const slot = session.selectedSlot;
  const displayTime = slot ? (session.availableSlots.find(
    (s) => s.start === slot.start,
  )?.display_time ?? slot.start) : 'the selected time';

  return makePrompt(session,
    `Let me confirm: ${session.clientName}, ` +
    `${session.service ?? 'appointment'} on ${displayTime}, ` +
    `email ${session.clientEmail}. ` +
    `Shall I go ahead and book this?`,
    'confirming_booking',
  );
}

async function handleBookingConfirmation(
  session: VoiceSession,
  speech: string,
  tenant: Tenant,
): Promise<string> {
  const answer = detectYesNo(speech);

  if (answer === 'no') {
    session.holdId = null;
    session.selectedSlot = null;
    session.clientName = null;
    session.clientEmail = null;
    return makePrompt(session,
      "No problem! Would you like to start over, or is there anything else I can help with?",
      'collecting_intent',
    );
  }

  if (answer !== 'yes') {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      // Treat as yes
    } else {
      return makePrompt(session,
        "Just to confirm — would you like me to book this appointment? Please say yes or no.",
        'confirming_booking',
      );
    }
  }

  // Confirm via the SAME booking service
  const result = await voiceConfirmBooking(session, tenant);

  if (!result.success) {
    return makePrompt(session,
      `I'm sorry, there was an issue completing the booking. ${result.error ?? ''} Would you like to try again?`,
      'collecting_intent',
    );
  }

  session.bookingId = result.appointmentId ?? null;
  session.referenceCode = result.referenceCode ?? null;
  advanceState(session, 'completed');

  const refSpelled = result.referenceCode
    ? spellOut(result.referenceCode)
    : 'your reference code';

  return buildSayHangupTwiML(
    `Your appointment is confirmed! ` +
    `Your reference code is ${refSpelled}. ` +
    `We've booked you for ${result.displayTime ?? 'the selected time'}. ` +
    `Thank you for calling, and have a wonderful day!`,
  );
}

// ── Reschedule / Cancel Handlers ────────────────────────────────

async function handleReferenceCollection(
  session: VoiceSession,
  speech: string,
  tenant: Tenant,
): Promise<string> {
  const refCode = detectReferenceCode(speech);
  const email = detectEmail(speech);

  if (!refCode && !email) {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      advanceState(session, 'completed');
      return buildSayHangupTwiML(
        "I couldn't find your booking. Please try our website or call back with your reference code. Goodbye!",
      );
    }
    return makePrompt(session,
      "I didn't catch that. Please say your reference code, like A P T dash A B C 1 2 3. Or say your email address.",
      'collecting_reference',
    );
  }

  const result = await voiceLookupBooking(session, tenant, {
    reference_code: refCode ?? undefined,
    email: email ?? undefined,
  });

  if (!result.success || result.appointments.length === 0) {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      advanceState(session, 'completed');
      return buildSayHangupTwiML(
        "I couldn't find any active appointments with that information. Please check and call back. Goodbye!",
      );
    }
    return makePrompt(session,
      "I couldn't find an active appointment with that information. Could you try again?",
      'collecting_reference',
    );
  }

  session.lookupResults = result.appointments;
  const apt = result.appointments[0];
  session.appointmentId = apt.appointment_id;
  session.referenceCode = apt.reference_code;

  if (session.intent === 'cancel') {
    return makePrompt(session,
      `I found your appointment: ${apt.reference_code}, ` +
      `${apt.service ?? 'appointment'}. ` +
      `Are you sure you want to cancel it?`,
      'confirming_cancel',
    );
  }

  // Reschedule
  return makePrompt(session,
    `I found your appointment: ${apt.reference_code}, ` +
    `${apt.service ?? 'appointment'}. ` +
    `What new date would you like to reschedule to?`,
    'collecting_reschedule_date',
  );
}

async function handleRescheduleDateCollection(
  session: VoiceSession,
  speech: string,
  tenant: Tenant,
): Promise<string> {
  const date = detectDate(speech, tenant.timezone);
  if (!date) {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      advanceState(session, 'completed');
      return buildSayHangupTwiML("I couldn't understand the date. Please try our website. Goodbye!");
    }
    return makePrompt(session,
      "I didn't catch that date. You can say tomorrow, next Monday, or a specific date.",
      'collecting_reschedule_date',
    );
  }

  session.date = date;
  const result = await voiceCheckAvailability(session, tenant, date);

  if (!result.success || result.slots.length === 0) {
    return makePrompt(session,
      "No slots available on that date. Would you like to try another date?",
      'collecting_reschedule_date',
    );
  }

  session.availableSlots = result.slots;
  const slotsToOffer = result.slots.slice(0, 5);
  const slotList = slotsToOffer.map((s, i) => `${i + 1}. ${s.display_time}`).join('. ');

  return makePrompt(session,
    `Available times: ${slotList}. Which time would you like?`,
    'offering_reschedule_slots',
  );
}

async function handleRescheduleSlotChoice(
  session: VoiceSession,
  speech: string,
  tenant: Tenant,
): Promise<string> {
  const slotsToOffer = session.availableSlots.slice(0, 5);
  const chosen = detectSlotChoice(speech, slotsToOffer);

  if (!chosen) {
    incrementRetry(session);
    if (isRetryLimitReached(session)) {
      advanceState(session, 'completed');
      return buildSayHangupTwiML("I couldn't understand your choice. Please try our website. Goodbye!");
    }
    return makePrompt(session,
      "I didn't catch that. Say the number or the time you'd like.",
      'offering_reschedule_slots',
    );
  }

  session.selectedSlot = chosen;
  const holdResult = await voiceHoldSlot(session, tenant, chosen.start, chosen.end);

  if (!holdResult.success) {
    return makePrompt(session,
      `That slot was just taken. Would you like to pick a different time?`,
      'offering_reschedule_slots',
    );
  }

  session.holdId = holdResult.holdId!;
  const displayTime = session.availableSlots.find((s) => s.start === chosen.start)?.display_time ?? chosen.start;

  return makePrompt(session,
    `I'll reschedule your appointment to ${displayTime}. Shall I confirm?`,
    'confirming_reschedule',
  );
}

async function handleRescheduleConfirmation(
  session: VoiceSession,
  speech: string,
  tenant: Tenant,
): Promise<string> {
  const answer = detectYesNo(speech);

  if (answer === 'no') {
    advanceState(session, 'completed');
    return buildSayHangupTwiML("Okay, I won't reschedule. Your original appointment remains. Goodbye!");
  }

  if (answer !== 'yes') {
    incrementRetry(session);
    if (!isRetryLimitReached(session)) {
      return makePrompt(session, "Please say yes to confirm or no to cancel.", 'confirming_reschedule');
    }
  }

  const result = await voiceRescheduleBooking(session, tenant);

  if (!result.success) {
    return makePrompt(session,
      `There was an issue rescheduling: ${result.error ?? 'Unknown error'}. Would you like to try again?`,
      'collecting_intent',
    );
  }

  advanceState(session, 'completed');
  return buildSayHangupTwiML(
    `Your appointment has been rescheduled! ` +
    `New time: ${result.displayTime ?? 'confirmed'}. ` +
    `Reference code: ${result.referenceCode ? spellOut(result.referenceCode) : session.referenceCode}. ` +
    `Thank you for calling!`,
  );
}

async function handleCancelConfirmation(
  session: VoiceSession,
  speech: string,
  tenant: Tenant,
): Promise<string> {
  const answer = detectYesNo(speech);

  if (answer === 'no') {
    advanceState(session, 'completed');
    return buildSayHangupTwiML("Okay, I won't cancel. Your appointment remains. Goodbye!");
  }

  if (answer !== 'yes') {
    incrementRetry(session);
    if (!isRetryLimitReached(session)) {
      return makePrompt(session, "Please say yes to confirm the cancellation, or no to keep your appointment.", 'confirming_cancel');
    }
  }

  const result = await voiceCancelBooking(session, tenant);

  if (!result.success) {
    return makePrompt(session,
      `There was an issue cancelling: ${result.error ?? 'Unknown error'}. Would you like to try again?`,
      'collecting_intent',
    );
  }

  advanceState(session, 'completed');
  return buildSayHangupTwiML(
    `Your appointment has been cancelled. ` +
    `If you need to book again in the future, just give us a call. Goodbye!`,
  );
}

// ── Helpers ─────────────────────────────────────────────────────

import type { VoiceCallState } from '../domain/types.js';

function makePrompt(
  session: VoiceSession,
  prompt: string,
  nextState: VoiceCallState,
  hints?: string,
): string {
  advanceState(session, nextState);
  session.lastPrompt = prompt;
  return buildGatherTwiML({
    prompt,
    action: CONTINUE_URL(),
    hints,
  });
}

// ── SMS Handoff Helpers ─────────────────────────────────────────

/**
 * Handle an explicit handoff request from the caller.
 * Creates a token, sends SMS, and tells the caller to check their phone.
 */
async function handleHandoffRequest(
  session: VoiceSession,
  tenant: Tenant,
): Promise<string> {
  if (env.SMS_HANDOFF_ENABLED !== 'true') {
    return makePrompt(session,
      "I'm sorry, the text message feature isn't available right now. Let's continue here. " +
      session.lastPrompt,
      session.state,
    );
  }

  const callerPhone = session.callerPhone;
  if (!callerPhone) {
    return makePrompt(session,
      "I don't have your phone number on file to send a text. Let's continue over the phone. " +
      session.lastPrompt,
      session.state,
    );
  }

  const token = createHandoffToken(session);
  const frontendBaseUrl = env.SMS_HANDOFF_WEB_URL || env.CORS_ORIGIN.split(',')[0].trim();
  const resumeUrl = `${frontendBaseUrl}?handoff=${encodeURIComponent(token)}`;
  const tenantName = tenant.name ?? 'Your booking agent';

  const smsResult = await sendHandoffSms(callerPhone, tenantName, resumeUrl);

  if (!smsResult.success) {
    console.warn(`[voice] SMS handoff failed for ${session.callSid}: ${smsResult.error}`);
    return makePrompt(session,
      "I wasn't able to send the text message right now. Let's continue over the phone. " +
      session.lastPrompt,
      session.state,
    );
  }

  console.log(`[voice] SMS handoff sent for call ${session.callSid} to ${callerPhone}`);

  advanceState(session, 'completed');
  return buildSayHangupTwiML(
    "I've just sent you a text message with a link to continue online. " +
    "Tap the link to pick up right where we left off. " +
    "The link is good for 15 minutes. Thank you for calling!",
  );
}

/**
 * Offer SMS handoff proactively when the caller is struggling
 * (e.g., email parsing failed multiple times).
 * Returns TwiML that offers the choice, or null if handoff isn't available.
 */
export function buildHandoffOfferPrompt(
  session: VoiceSession,
  fallbackPrompt: string,
): string {
  if (env.SMS_HANDOFF_ENABLED !== 'true' || !session.callerPhone) {
    return fallbackPrompt;
  }
  return (
    "Would you like me to text you a link so you can finish this online? " +
    "Just say 'text me' or we can keep going over the phone."
  );
}

/**
 * Spell out a reference code character by character for voice clarity.
 * APT-ABC123 → "A. P. T. dash. A. B. C. 1. 2. 3."
 */
function spellOut(code: string): string {
  return code
    .split('')
    .map((c) => {
      if (c === '-') return 'dash';
      return c;
    })
    .join('. ');
}
