// ============================================================
// Safe Cancellation + SMS Reminder Tests
//
// Part A: Safe Cancellation (reference_code + verification)
//   1. Cancel fails if reference_code missing
//   2. Cancel returns CANCELLATION_NEEDS_IDENTITY when session unverified and no phone_last4
//   3. Cancel fails if reference_code not found (generic error)
//   4. Cancel fails if phone_last4 mismatch (same generic error — no info leak)
//   5. Cancel succeeds via verified session (email match, no phone needed)
//   6. Cancel succeeds via phone_last4 match
//   7. Booking without phone on file + no verified session → generic fail
//
// Part B: SMS Reminders
//   8. onBookingCreated schedules SMS reminder when client_phone is present
//   9. onBookingCreated does NOT schedule SMS reminder when no phone
//  10. onBookingCancelled cancels pending reminders
//  11. send_sms_reminder job skips if appointment is cancelled
//  12. send_sms_reminder job skips if phone opted out
//  13. send_sms_reminder job sends correct message format
//
// Part C: System Prompt
//  14. System prompt includes SAFE CANCELLATION instructions
//  15. System prompt instructs not to use lookup_booking for cancellation
//
// Part D: Tool Definition
//  16. cancel_booking requires reference_code, has optional phone_last4
//
// Part E: Audit Logging
//  17. Emits booking.verification_attempted on each attempt
//  18. Emits booking.verification_failed on failure
//  19. Emits booking.verification_succeeded on success (with method)
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Part A: Safe Cancellation ─────────────────────────────

describe('Safe Cancellation (cancel_booking)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Common mocks needed by every cancel_booking test. */
  function setupCancelMocks(opts: {
    appointments?: any[];
    sessionCustomer?: { customer_id: string | null; email_verified: boolean } | null;
    customerContact?: { email: string | null; phone: string | null } | null;
    auditLogMock?: ReturnType<typeof vi.fn>;
    cancelResult?: any;
  }) {
    const appointments = opts.appointments ?? [];
    const auditLogMock = opts.auditLogMock ?? vi.fn().mockResolvedValue(undefined);

    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class extends Error {},
      getCalendarDebugSnapshot: vi.fn(),
      CalendarReadError: class extends Error {},
      isDemoAvailabilityActive: () => false,
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        lookup: vi.fn().mockResolvedValue(appointments),
        cancel: vi.fn().mockResolvedValue(
          opts.cancelResult ?? { ...(appointments[0] ?? {}), status: 'cancelled' },
        ),
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
      auditRepo: { log: auditLogMock },
    }));

    // Session repo mock — findById returns the session
    const session = opts.sessionCustomer
      ? { customer_id: opts.sessionCustomer.customer_id, email_verified: opts.sessionCustomer.email_verified }
      : null;
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue(session),
      },
    }));

    // Customer repo mock
    vi.doMock('../src/repos/customer.repo.js', () => ({
      customerRepo: {
        findById: vi.fn().mockResolvedValue(opts.customerContact ?? null),
      },
    }));

    return { auditLogMock };
  }

  it('fails when reference_code is missing', async () => {
    setupCancelMocks({});

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'cancel_booking',
      { reference_code: '' },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('CANCELLATION_REQUIRES_VERIFICATION');
  });

  it('returns CANCELLATION_NEEDS_IDENTITY when session unverified and no phone_last4', async () => {
    const mockAppointment = {
      id: 'apt-1',
      reference_code: 'APT-12345',
      client_name: 'Jane Doe',
      client_email: 'jane@example.com',
      client_phone: '+15551234567',
      status: 'confirmed',
      start_time: new Date('2025-03-15T10:00:00Z'),
      end_time: new Date('2025-03-15T11:00:00Z'),
    };

    setupCancelMocks({
      appointments: [mockAppointment],
      sessionCustomer: null, // no session customer → not verified
    });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'cancel_booking',
      { reference_code: 'APT-12345' },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('CANCELLATION_NEEDS_IDENTITY');
    expect(result.error).toContain('phone_last4');
  });

  it('fails with generic error when reference_code not found', async () => {
    setupCancelMocks({
      appointments: [], // no appointments found
    });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'cancel_booking',
      { reference_code: 'FAKE-CODE', phone_last4: '1234' },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('CANCELLATION_FAILED');
    // Must NOT reveal that the code was invalid vs phone mismatch
    expect(result.error).not.toContain('not found');
    expect(result.error).not.toContain('invalid code');
  });

  it('fails with same generic error when phone_last4 mismatches (no info leak)', async () => {
    const mockAppointment = {
      id: 'apt-1',
      reference_code: 'APT-12345',
      client_name: 'Jane Smith',
      client_email: 'jane@example.com',
      client_phone: '+15559999999',
      status: 'confirmed',
      start_time: new Date('2025-03-15T10:00:00Z'),
      end_time: new Date('2025-03-15T11:00:00Z'),
    };

    setupCancelMocks({
      appointments: [mockAppointment],
      sessionCustomer: null,
    });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'cancel_booking',
      { reference_code: 'APT-12345', phone_last4: '0000' }, // wrong last4
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('CANCELLATION_FAILED');
    // The error must NOT reveal any specifics
    expect(result.error).not.toContain('mismatch');
    expect(result.error).not.toContain('does not match');
    expect(result.error).not.toContain('incorrect');
  });

  it('succeeds via verified session (email match, no phone_last4 needed)', async () => {
    const mockAppointment = {
      id: 'apt-1',
      reference_code: 'APT-12345',
      client_name: 'Jane Doe',
      client_email: 'jane@example.com',
      client_phone: '+15551234567',
      status: 'confirmed',
      start_time: new Date('2025-03-15T10:00:00Z'),
      end_time: new Date('2025-03-15T11:00:00Z'),
    };

    setupCancelMocks({
      appointments: [mockAppointment],
      sessionCustomer: { customer_id: 'cust-1', email_verified: true },
      customerContact: { email: 'jane@example.com', phone: '+15551234567' },
    });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'cancel_booking',
      { reference_code: 'APT-12345' }, // no phone_last4 needed
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('cancelled');
    expect(result.data?.reference_code).toBe('APT-12345');
    expect(result.data?.message).toContain('cancelled');
  });

  it('succeeds via phone_last4 match', async () => {
    const mockAppointment = {
      id: 'apt-1',
      reference_code: 'APT-12345',
      client_name: 'Jane Doe',
      client_email: 'jane@example.com',
      client_phone: '+15551234567',
      status: 'confirmed',
      start_time: new Date('2025-03-15T10:00:00Z'),
      end_time: new Date('2025-03-15T11:00:00Z'),
    };

    setupCancelMocks({
      appointments: [mockAppointment],
      sessionCustomer: null, // not verified
    });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'cancel_booking',
      { reference_code: 'APT-12345', phone_last4: '4567' },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('cancelled');
    expect(result.data?.reference_code).toBe('APT-12345');
  });

  it('generic fail when booking has no phone and session not verified', async () => {
    const mockAppointment = {
      id: 'apt-1',
      reference_code: 'APT-12345',
      client_name: 'Jane Doe',
      client_email: 'jane@example.com',
      client_phone: null,  // ← no phone on booking
      status: 'confirmed',
      start_time: new Date('2025-03-15T10:00:00Z'),
      end_time: new Date('2025-03-15T11:00:00Z'),
    };

    setupCancelMocks({
      appointments: [mockAppointment],
      sessionCustomer: null,
    });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'cancel_booking',
      { reference_code: 'APT-12345', phone_last4: '1234' },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    expect(result.success).toBe(false);
    // Returns generic fail — no PII leak about whether booking has phone or not
    expect(result.error).toContain('CANCELLATION_FAILED');
  });
});

// ── Part B: SMS Reminders ─────────────────────────────────

describe('SMS Reminder — onBookingCreated', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules SMS reminder when client_phone is present', async () => {
    const mockJobCreate = vi.fn().mockResolvedValue({ id: 'job-sms-1' });
    const mockReminderCreate = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({ effect: 'deny' }), // deny email to isolate SMS path
      },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: mockJobCreate },
    }));
    vi.doMock('../src/repos/appointment-reminder.repo.js', () => ({
      appointmentReminderRepo: { create: mockReminderCreate },
    }));

    const { onBookingCreated } = await import(
      '../src/orchestrator/handlers/on-booking-created.js'
    );

    // Appointment 3 hours from now (so 2h reminder is in the future)
    const startTime = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

    await onBookingCreated({
      name: 'BookingCreated',
      tenant_id: 'tenant-1',
      appointment: {
        id: 'apt-1',
        tenant_id: 'tenant-1',
        reference_code: 'APT-99999',
        client_name: 'Sarah Connor',
        client_email: 'sarah@example.com',
        client_phone: '+15551234567',
        client_notes: null,
        service: 'General Consultation',
        start_time: startTime,
        end_time: endTime,
        timezone: 'America/New_York',
        status: 'confirmed',
        google_event_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      session_id: 'session-1',
      timestamp: new Date().toISOString(),
    });

    // Should have created the SMS reminder job
    const smsCalls = mockJobCreate.mock.calls.filter(
      (call: any[]) => call[0].type === 'send_sms_reminder',
    );
    expect(smsCalls.length).toBe(1);

    const jobPayload = smsCalls[0][0].payload;
    expect(jobPayload.phone).toBe('+15551234567');
    expect(jobPayload.first_name).toBe('Sarah');
    expect(jobPayload.service).toBe('General Consultation');
    expect(jobPayload.appointment_id).toBe('apt-1');

    // Should track the reminder
    expect(mockReminderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        appointment_id: 'apt-1',
        tenant_id: 'tenant-1',
        job_id: 'job-sms-1',
        reminder_type: 'sms_2h',
        phone: '+15551234567',
      }),
    );
  });

  it('does NOT schedule SMS reminder when no phone', async () => {
    const mockJobCreate = vi.fn().mockResolvedValue({ id: 'job-1' });
    const mockReminderCreate = vi.fn();

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({ effect: 'deny' }),
      },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: mockJobCreate },
    }));
    vi.doMock('../src/repos/appointment-reminder.repo.js', () => ({
      appointmentReminderRepo: { create: mockReminderCreate },
    }));

    const { onBookingCreated } = await import(
      '../src/orchestrator/handlers/on-booking-created.js'
    );

    const startTime = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

    await onBookingCreated({
      name: 'BookingCreated',
      tenant_id: 'tenant-1',
      appointment: {
        id: 'apt-2',
        tenant_id: 'tenant-1',
        reference_code: 'APT-88888',
        client_name: 'John Doe',
        client_email: 'john@example.com',
        client_phone: null, // no phone
        client_notes: null,
        service: 'Follow-up Appointment',
        start_time: startTime,
        end_time: endTime,
        timezone: 'America/New_York',
        status: 'confirmed',
        google_event_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      session_id: 'session-2',
      timestamp: new Date().toISOString(),
    });

    // No send_sms_reminder jobs should be created
    const smsCalls = mockJobCreate.mock.calls.filter(
      (call: any[]) => call[0].type === 'send_sms_reminder',
    );
    expect(smsCalls.length).toBe(0);
    expect(mockReminderCreate).not.toHaveBeenCalled();
  });
});

describe('SMS Reminder — onBookingCancelled', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cancels pending reminders when booking is cancelled', async () => {
    const mockCancelByAppointment = vi.fn().mockResolvedValue(1);

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({ effect: 'deny' }),
      },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-x' }) },
    }));
    vi.doMock('../src/repos/appointment-reminder.repo.js', () => ({
      appointmentReminderRepo: {
        cancelByAppointment: mockCancelByAppointment,
      },
    }));

    const { onBookingCancelled } = await import(
      '../src/orchestrator/handlers/on-booking-cancelled.js'
    );

    await onBookingCancelled({
      name: 'BookingCancelled',
      tenant_id: 'tenant-1',
      appointment: {
        id: 'apt-1',
        tenant_id: 'tenant-1',
        reference_code: 'APT-99999',
        client_name: 'Sarah Connor',
        client_email: 'sarah@example.com',
        client_phone: '+15551234567',
        client_notes: null,
        service: 'General Consultation',
        start_time: new Date('2025-03-15T14:00:00Z'),
        end_time: new Date('2025-03-15T15:00:00Z'),
        timezone: 'America/New_York',
        status: 'cancelled',
        google_event_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      timestamp: new Date().toISOString(),
    });

    expect(mockCancelByAppointment).toHaveBeenCalledWith('apt-1');
  });
});

// ── Part C: System Prompt ─────────────────────────────────

describe('System Prompt — Safe Cancellation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes SAFE CANCELLATION instructions', async () => {
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
      formatNow: () => '2025-03-15 10:00 AM',
      getTodayISO: () => '2025-03-15',
      getNow: () => new Date('2025-03-15T10:00:00'),
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');

    const prompt = buildSystemPrompt(
      {
        id: 'tenant-1',
        name: 'Test Spa',
        timezone: 'America/New_York',
        business_hours: {},
        services: [],
      } as any,
    );

    // Must contain safe cancellation rules
    expect(prompt).toContain('SAFE CANCELLATION');
    expect(prompt).toContain('CONFIRMATION NUMBER');
    expect(prompt).toContain('CANCELLATION_FAILED');
    // New: mentions phone_last4 as fallback
    expect(prompt).toContain('phone_last4');
    expect(prompt).toContain('CANCELLATION_NEEDS_IDENTITY');
  });

  it('instructs to NOT use lookup_booking for cancellation', async () => {
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
      formatNow: () => '2025-03-15 10:00 AM',
      getTodayISO: () => '2025-03-15',
      getNow: () => new Date('2025-03-15T10:00:00'),
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');

    const prompt = buildSystemPrompt(
      {
        id: 'tenant-1',
        name: 'Test Spa',
        timezone: 'America/New_York',
        business_hours: {},
        services: [],
      } as any,
    );

    expect(prompt).toContain('Do NOT use lookup_booking to find the appointment first');
  });
});

// ── Part D: Tool Definition ───────────────────────────────

describe('cancel_booking tool definition', () => {
  it('requires reference_code and has optional phone_last4', async () => {
    const { agentTools } = await import('../src/agent/tools.js');

    const cancelTool = agentTools.find(
      (t: any) => t.function.name === 'cancel_booking',
    );

    expect(cancelTool).toBeDefined();

    const params = cancelTool!.function.parameters as any;
    expect(params.required).toContain('reference_code');
    // phone_last4 is optional — NOT in required
    expect(params.required).not.toContain('phone_last4');
    expect(params.properties.reference_code).toBeDefined();
    expect(params.properties.phone_last4).toBeDefined();

    // Should NOT have old phone_number parameter
    expect(params.properties.phone_number).toBeUndefined();
    // Should NOT have appointment_id or client_name as parameters
    expect(params.properties.appointment_id).toBeUndefined();
    expect(params.properties.client_name).toBeUndefined();
  });
});

// ── Part E: Audit Logging ─────────────────────────────────

describe('Cancellation Audit Logging', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupMocks(opts: {
    appointments: any[];
    auditLogMock: ReturnType<typeof vi.fn>;
    sessionCustomer?: { customer_id: string | null; email_verified: boolean } | null;
    customerContact?: { email: string | null; phone: string | null } | null;
  }) {
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class extends Error {},
      getCalendarDebugSnapshot: vi.fn(),
      CalendarReadError: class extends Error {},
      isDemoAvailabilityActive: () => false,
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        lookup: vi.fn().mockResolvedValue(opts.appointments),
        cancel: vi.fn().mockResolvedValue({
          ...(opts.appointments[0] ?? {}),
          status: 'cancelled',
        }),
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
      auditRepo: { log: opts.auditLogMock },
    }));

    const session = opts.sessionCustomer
      ? { customer_id: opts.sessionCustomer.customer_id, email_verified: opts.sessionCustomer.email_verified }
      : null;
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: { findById: vi.fn().mockResolvedValue(session) },
    }));
    vi.doMock('../src/repos/customer.repo.js', () => ({
      customerRepo: { findById: vi.fn().mockResolvedValue(opts.customerContact ?? null) },
    }));
  }

  it('emits booking.verification_attempted + booking.verification_succeeded on success', async () => {
    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    setupMocks({
      appointments: [{
        id: 'apt-1',
        reference_code: 'APT-12345',
        client_name: 'Jane Doe',
        client_email: 'jane@example.com',
        client_phone: '+15551234567',
        status: 'confirmed',
        start_time: new Date('2025-03-15T10:00:00Z'),
        end_time: new Date('2025-03-15T11:00:00Z'),
      }],
      auditLogMock,
      sessionCustomer: null,
    });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    await executeToolCall(
      'cancel_booking',
      { reference_code: 'APT-12345', phone_last4: '4567' },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    const eventTypes = auditLogMock.mock.calls.map((c: any[]) => c[0].event_type);
    expect(eventTypes).toContain('booking.verification_attempted');
    expect(eventTypes).toContain('booking.verification_succeeded');
    expect(eventTypes).not.toContain('booking.verification_failed');

    // Check that method is recorded in success audit
    const successCall = auditLogMock.mock.calls.find((c: any[]) => c[0].event_type === 'booking.verification_succeeded');
    expect(successCall![0].payload.method).toBe('phone_last4');
  });

  it('emits booking.verification_attempted + booking.verification_failed on phone_last4 mismatch', async () => {
    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    setupMocks({
      appointments: [{
        id: 'apt-1',
        reference_code: 'APT-12345',
        client_name: 'Jane Doe',
        client_email: 'jane@example.com',
        client_phone: '+15559999999',
        status: 'confirmed',
        start_time: new Date('2025-03-15T10:00:00Z'),
        end_time: new Date('2025-03-15T11:00:00Z'),
      }],
      auditLogMock,
      sessionCustomer: null,
    });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    await executeToolCall(
      'cancel_booking',
      { reference_code: 'APT-12345', phone_last4: '0000' },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    const eventTypes = auditLogMock.mock.calls.map((c: any[]) => c[0].event_type);
    expect(eventTypes).toContain('booking.verification_attempted');
    expect(eventTypes).toContain('booking.verification_failed');

    // Check that the failure reason is recorded (PII-safe)
    const failCall = auditLogMock.mock.calls.find((c: any[]) => c[0].event_type === 'booking.verification_failed');
    expect(failCall).toBeDefined();
    expect(failCall![0].payload.reason).toBe('phone_last4_mismatch');
  });

  it('emits booking.verification_succeeded with method=verified_session on session match', async () => {
    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    setupMocks({
      appointments: [{
        id: 'apt-session',
        reference_code: 'APT-SESSION',
        client_name: 'Verified User',
        client_email: 'verified@example.com',
        client_phone: '+15551234567',
        status: 'confirmed',
        start_time: new Date('2025-03-15T10:00:00Z'),
        end_time: new Date('2025-03-15T11:00:00Z'),
      }],
      auditLogMock,
      sessionCustomer: { customer_id: 'cust-1', email_verified: true },
      customerContact: { email: 'verified@example.com', phone: '+15551234567' },
    });

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    await executeToolCall(
      'cancel_booking',
      { reference_code: 'APT-SESSION' },
      'tenant-1',
      'session-1',
      { timezone: 'America/New_York' } as any,
    );

    const eventTypes = auditLogMock.mock.calls.map((c: any[]) => c[0].event_type);
    expect(eventTypes).toContain('booking.verification_succeeded');

    const successCall = auditLogMock.mock.calls.find((c: any[]) => c[0].event_type === 'booking.verification_succeeded');
    expect(successCall![0].payload.method).toBe('verified_session');
  });
});
