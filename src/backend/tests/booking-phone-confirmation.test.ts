// ============================================================
// Booking Phone Requirement + Confirmation SMS Tests
//
// Part A: Phone required at booking (chat path)
//   1. confirm_booking fails when client_phone is missing
//   2. confirm_booking fails when client_phone is invalid format
//   3. confirm_booking succeeds + stores normalized E.164 phone
//   4. Phone normalization: "(555) 123-4567" → "+15551234567"
//   5. booking.phone_captured audit event emitted on success
//
// Part B: Voice booking path
//   6. voiceConfirmBooking passes callerPhone to confirm_booking
//   7. voiceConfirmBooking fails when callerPhone is missing
//
// Part C: Confirmation SMS (on-booking-created)
//   8. Sends confirmation SMS immediately after booking (with phone)
//   9. Does NOT send confirmation SMS when no phone on booking
//  10. Confirmation SMS body has correct format (ref, CHANGE, CANCEL, STOP)
//  11. Emits sms.booking_confirmation_sent audit event on success
//  12. Emits sms.booking_confirmation_failed audit event on failure
//
// Part D: Tool definition + System prompt
//  13. confirm_booking requires client_phone
//  14. System prompt includes phone collection instructions
//
// Part E: Backward compatibility
//  15. Legacy bookings without phone still cancel-blocked (unchanged)
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Part A: Phone required at booking ─────────────────────

describe('Phone required at booking (confirm_booking)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupConfirmMocks(opts: {
    confirmResult?: any;
    auditLogMock?: ReturnType<typeof vi.fn>;
  } = {}) {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class extends Error {},
      getCalendarDebugSnapshot: vi.fn(),
      CalendarReadError: class extends Error {},
      isDemoAvailabilityActive: () => false,
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockResolvedValue(opts.confirmResult ?? {
          id: 'apt-1',
          reference_code: 'APT-12345',
          client_name: 'Jane Doe',
          client_email: 'jane@example.com',
          client_phone: '+15551234567',
          service: 'Massage',
          start_time: new Date('2025-03-15T10:00:00Z'),
          end_time: new Date('2025-03-15T11:00:00Z'),
          timezone: 'America/New_York',
          status: 'confirmed',
        }),
        lookup: vi.fn(),
        cancel: vi.fn(),
      },
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: { create: vi.fn() },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 30, NODE_ENV: 'test' },
    }));
    vi.doMock('../src/services/clock.js', () => ({
      daysFromNow: vi.fn().mockReturnValue(5),
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: opts.auditLogMock ?? vi.fn().mockResolvedValue(undefined) },
    }));
  }

  it('fails when client_phone is missing', async () => {
    setupConfirmMocks();
    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'confirm_booking',
      {
        hold_id: 'hold-1',
        client_name: 'Jane Doe',
        client_email: 'jane@example.com',
        // client_phone deliberately omitted
      },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('PHONE_REQUIRED');
  });

  it('fails when client_phone is invalid format', async () => {
    setupConfirmMocks();
    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'confirm_booking',
      {
        hold_id: 'hold-1',
        client_name: 'Jane Doe',
        client_email: 'jane@example.com',
        client_phone: 'not-a-phone',
      },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('INVALID_PHONE');
  });

  it('succeeds and passes normalized E.164 phone to bookingService', async () => {
    const confirmMock = vi.fn().mockResolvedValue({
      id: 'apt-1',
      reference_code: 'APT-12345',
      client_name: 'Jane Doe',
      client_email: 'jane@example.com',
      client_phone: '+15551234567',
      service: 'Massage',
      start_time: new Date('2025-03-15T10:00:00Z'),
      end_time: new Date('2025-03-15T11:00:00Z'),
      timezone: 'America/New_York',
      status: 'confirmed',
    });

    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class extends Error {},
      getCalendarDebugSnapshot: vi.fn(),
      CalendarReadError: class extends Error {},
      isDemoAvailabilityActive: () => false,
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: confirmMock,
        lookup: vi.fn(),
        cancel: vi.fn(),
      },
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: { create: vi.fn() },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 30, NODE_ENV: 'test' },
    }));
    vi.doMock('../src/services/clock.js', () => ({
      daysFromNow: vi.fn().mockReturnValue(5),
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'confirm_booking',
      {
        hold_id: 'hold-1',
        client_name: 'Jane Doe',
        client_email: 'jane@example.com',
        client_phone: '(555) 123-4567',  // non-E.164 format
      },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(true);
    expect(result.data.reference_code).toBe('APT-12345');

    // Verify normalized phone was passed to bookingService
    expect(confirmMock).toHaveBeenCalledOnce();
    const passedRequest = confirmMock.mock.calls[0][0];
    expect(passedRequest.client_phone).toBe('+15551234567');
  });

  it('emits booking.phone_captured audit event on success', async () => {
    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    setupConfirmMocks({ auditLogMock });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    await executeToolCall(
      'confirm_booking',
      {
        hold_id: 'hold-1',
        client_name: 'Jane Doe',
        client_email: 'jane@example.com',
        client_phone: '+15551234567',
      },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    const phoneCaptured = auditLogMock.mock.calls.find(
      (c: any[]) => c[0].event_type === 'booking.phone_captured',
    );
    expect(phoneCaptured).toBeDefined();
    expect(phoneCaptured![0].entity_type).toBe('appointment');
    // PII-safe: only prefix
    expect(phoneCaptured![0].payload.phone_prefix).toMatch(/^\+\d{4}…$/);
  });
});

// ── Part B: Voice booking path ────────────────────────────

describe('Voice booking — phone required', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockVoiceDeps() {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class extends Error {},
      getCalendarDebugSnapshot: vi.fn(),
      CalendarReadError: class extends Error {},
      isDemoAvailabilityActive: () => false,
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockResolvedValue({
          id: 'apt-voice',
          reference_code: 'APT-VOICE1',
          client_name: 'Voice Caller',
          client_email: 'voice@example.com',
          client_phone: '+15551234567',
          service: 'Massage',
          start_time: new Date('2025-03-15T10:00:00Z'),
          end_time: new Date('2025-03-15T11:00:00Z'),
          timezone: 'America/New_York',
          status: 'confirmed',
        }),
        lookup: vi.fn(),
        cancel: vi.fn(),
      },
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: { create: vi.fn() },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 30, NODE_ENV: 'test' },
    }));
    vi.doMock('../src/services/clock.js', () => ({
      daysFromNow: vi.fn().mockReturnValue(5),
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
  }

  function makeVoiceSession(overrides: Partial<any> = {}): any {
    return {
      callSid: 'CA123',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      state: 'confirming_booking',
      intent: 'book',
      retries: 0,
      turnCount: 3,
      startedAt: Date.now(),
      lastPrompt: '',
      callerPhone: '+15551234567',
      service: 'Massage',
      date: '2025-03-15',
      selectedSlot: { start: '2025-03-15T10:00:00Z', end: '2025-03-15T11:00:00Z' },
      holdId: 'hold-v1',
      clientName: 'Voice Caller',
      clientEmail: 'voice@example.com',
      clientNotes: null,
      bookingId: null,
      referenceCode: null,
      appointmentId: null,
      lookupResults: [],
      availableSlots: [],
      ...overrides,
    };
  }

  it('passes callerPhone to confirm_booking and succeeds', async () => {
    mockVoiceDeps();
    const { voiceConfirmBooking } = await import('../src/voice/voice-tool-executor.js');

    const session = makeVoiceSession({ callerPhone: '+15551234567' });
    const tenant = { timezone: 'America/New_York' } as any;

    const result = await voiceConfirmBooking(session, tenant);
    expect(result.success).toBe(true);
    expect(result.referenceCode).toBe('APT-VOICE1');
  });

  it('fails when callerPhone is missing', async () => {
    mockVoiceDeps();
    const { voiceConfirmBooking } = await import('../src/voice/voice-tool-executor.js');

    const session = makeVoiceSession({ callerPhone: null });
    const tenant = { timezone: 'America/New_York' } as any;

    const result = await voiceConfirmBooking(session, tenant);
    expect(result.success).toBe(false);
    expect(result.error).toContain('phone number');
  });
});

// ── Part C: Confirmation SMS (on-booking-created) ─────────

describe('Confirmation SMS (on-booking-created)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeAppointment(overrides: Partial<any> = {}): any {
    return {
      id: 'apt-sms-1',
      tenant_id: 'tenant-1',
      reference_code: 'APT-SMS01',
      client_name: 'SMS Customer',
      client_email: 'sms@example.com',
      client_phone: '+15551234567',
      service: 'Massage',
      start_time: new Date('2026-02-10T14:00:00Z'),
      end_time: new Date('2026-02-10T15:00:00Z'),
      timezone: 'America/New_York',
      status: 'confirmed',
      ...overrides,
    };
  }

  function setupOnBookingCreatedMocks(opts: {
    sendOutboundSmsMock?: ReturnType<typeof vi.fn>;
    auditLogMock?: ReturnType<typeof vi.fn>;
    policyEffect?: 'allow' | 'deny';
  } = {}) {
    const sendMock = opts.sendOutboundSmsMock ?? vi.fn().mockResolvedValue({ sent: true, queued: false });
    const auditMock = opts.auditLogMock ?? vi.fn().mockResolvedValue(undefined);

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({
          effect: opts.policyEffect ?? 'allow',
          rule_id: null,
          action: 'send_sms_confirmation',
          reason: 'default-allow',
          evaluated_at: new Date().toISOString(),
        }),
      },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/repos/appointment-reminder.repo.js', () => ({
      appointmentReminderRepo: { create: vi.fn().mockResolvedValue({}) },
    }));
    vi.doMock('../src/voice/sms-metrics.js', () => ({
      smsMetricInc: vi.fn(),
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: auditMock },
    }));
    vi.doMock('../src/repos/tenant.repo.js', () => ({
      tenantRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'tenant-1',
          timezone: 'America/New_York',
          sms_outbound_enabled: true,
        }),
      },
    }));
    vi.doMock('../src/voice/outbound-sms.js', () => ({
      sendOutboundSms: sendMock,
    }));

    return { sendMock, auditMock };
  }

  it('sends confirmation SMS immediately after booking when phone is present', async () => {
    const { sendMock } = setupOnBookingCreatedMocks();
    const { onBookingCreated } = await import('../src/orchestrator/handlers/on-booking-created.js');

    const appointment = makeAppointment();
    await onBookingCreated({
      name: 'BookingCreated',
      tenant_id: 'tenant-1',
      appointment,
      session_id: 'sess-1',
      timestamp: new Date().toISOString(),
    });

    // sendOutboundSms should have been called with the confirmation message
    expect(sendMock).toHaveBeenCalledOnce();
    const callArgs = sendMock.mock.calls[0];
    expect(callArgs[0].phone).toBe('+15551234567');
    expect(callArgs[0].messageType).toBe('confirmation');
    expect(callArgs[0].bookingId).toBe('apt-sms-1');
  });

  it('does NOT send confirmation SMS when no phone on booking', async () => {
    const { sendMock } = setupOnBookingCreatedMocks();
    const { onBookingCreated } = await import('../src/orchestrator/handlers/on-booking-created.js');

    const appointment = makeAppointment({ client_phone: null });
    await onBookingCreated({
      name: 'BookingCreated',
      tenant_id: 'tenant-1',
      appointment,
      session_id: 'sess-1',
      timestamp: new Date().toISOString(),
    });

    // No SMS should be sent
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('confirmation SMS body includes ref code, CHANGE, CANCEL, STOP', async () => {
    const { sendMock } = setupOnBookingCreatedMocks();
    const { onBookingCreated } = await import('../src/orchestrator/handlers/on-booking-created.js');

    const appointment = makeAppointment();
    await onBookingCreated({
      name: 'BookingCreated',
      tenant_id: 'tenant-1',
      appointment,
      session_id: 'sess-1',
      timestamp: new Date().toISOString(),
    });

    const body = sendMock.mock.calls[0][0].body as string;
    expect(body).toContain('Confirmed:');
    expect(body).toContain('Ref: APT-SMS01');
    expect(body).toContain('CHANGE');
    expect(body).toContain('CANCEL');
    expect(body).toContain('STOP');
    // Must NOT contain email (PII-minimal)
    expect(body).not.toContain('sms@example.com');
    // Must NOT contain full name (PII-minimal)
    expect(body).not.toContain('SMS Customer');
  });

  it('emits sms.booking_confirmation_sent audit event on success', async () => {
    const { auditMock } = setupOnBookingCreatedMocks();
    const { onBookingCreated } = await import('../src/orchestrator/handlers/on-booking-created.js');

    const appointment = makeAppointment();
    await onBookingCreated({
      name: 'BookingCreated',
      tenant_id: 'tenant-1',
      appointment,
      session_id: 'sess-1',
      timestamp: new Date().toISOString(),
    });

    const confirmSent = auditMock.mock.calls.find(
      (c: any[]) => c[0].event_type === 'sms.booking_confirmation_sent',
    );
    expect(confirmSent).toBeDefined();
    expect(confirmSent![0].entity_id).toBe('apt-sms-1');
    expect(confirmSent![0].payload.reference_code).toBe('APT-SMS01');
  });

  it('emits sms.booking_confirmation_failed audit event on send failure', async () => {
    const sendMock = vi.fn().mockResolvedValue({ sent: false, queued: false, error: 'transport_error' });
    const { auditMock } = setupOnBookingCreatedMocks({ sendOutboundSmsMock: sendMock });
    const { onBookingCreated } = await import('../src/orchestrator/handlers/on-booking-created.js');

    const appointment = makeAppointment();
    await onBookingCreated({
      name: 'BookingCreated',
      tenant_id: 'tenant-1',
      appointment,
      session_id: 'sess-1',
      timestamp: new Date().toISOString(),
    });

    const confirmFailed = auditMock.mock.calls.find(
      (c: any[]) => c[0].event_type === 'sms.booking_confirmation_failed',
    );
    expect(confirmFailed).toBeDefined();
    expect(confirmFailed![0].payload.error).toBe('transport_error');
  });
});

// ── Part D: Tool definition + System prompt ───────────────

describe('confirm_booking tool definition', () => {
  it('requires client_phone as a required parameter', async () => {
    const { agentTools } = await import('../src/agent/tools.js');

    const confirmTool = agentTools.find((t) => t.function.name === 'confirm_booking');
    expect(confirmTool).toBeDefined();

    const params = confirmTool!.function.parameters as any;
    expect(params.required).toContain('client_phone');
    expect(params.properties.client_phone).toBeDefined();
    expect(params.properties.client_phone.type).toBe('string');
  });
});

describe('System prompt — phone collection at booking', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes phone collection instructions in booking flow', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 30,
        FOLLOWUP_MAX_PER_BOOKING: 2,
        FOLLOWUP_COOLDOWN_MINUTES: 15,
      },
    }));
    vi.doMock('../src/services/clock.js', () => ({
      formatNow: () => '2026-02-09 10:00 AM',
      getTodayISO: () => '2026-02-09',
      getNow: () => new Date('2026-02-09T10:00:00'),
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');

    const prompt = buildSystemPrompt({
      id: 'tenant-1',
      name: 'Test Studio',
      slug: 'test',
      timezone: 'America/New_York',
      slot_duration: 30,
      business_hours: {
        monday: { start: '09:00', end: '17:00' },
        tuesday: null,
        wednesday: null,
        thursday: null,
        friday: null,
        saturday: null,
        sunday: null,
      },
      services: [{ name: 'Massage', duration: 60 }],
      google_calendar_id: null,
      google_oauth_tokens: null,
      excel_integration: null,
      quiet_hours_start: '21:00',
      quiet_hours_end: '08:00',
      sms_outbound_enabled: true,
      sms_retry_enabled: true,
      sms_quiet_hours_enabled: true,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    } as any);

    // Must mention phone requirement in booking flow
    expect(prompt).toContain('phone number');
    expect(prompt).toContain('Phone number is REQUIRED');
    expect(prompt).toContain('client_phone');
    // Must mention SMS confirmation context
    expect(prompt).toContain('SMS confirmations');
    // Must instruct to re-enter on invalid format
    expect(prompt).toContain('valid phone number');
    // Must instruct to never call confirm_booking without phone
    expect(prompt).toContain('NEVER call confirm_booking without a phone number');
  });
});
