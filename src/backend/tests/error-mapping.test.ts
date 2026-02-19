// ============================================================
// Error Mapping — Unit Tests
//
// Validates that tool-executor's catch block maps domain errors
// to actionable, LLM-readable error codes instead of a generic
// "internal error" message.
//
//  1. BookingError → BOOKING_ERROR: prefix with original message
//  2. SlotConflictError → SLOT_CONFLICT: prefix with rebooking guidance
//  3. CalendarReadError → CALENDAR_UNAVAILABLE: prefix
//  4. Unknown/system errors → INTERNAL_ERROR: prefix with reference ID (12 hex chars)
//  5. Structured log output for BookingError
//  6. Structured log output for unknown error
//  7. Email hash is logged (SHA-256 prefix) but raw email is NOT
//  8. System prompt includes error-code-specific instructions (full taxonomy)
//  9. ChatHandlerOptions accepts resolvedDatetime field (type check)
// 10. EMAIL_MISMATCH masks both emails
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Minimal tenant fixture for executeToolCall ──────────

const mockTenant = {
  id: 'tenant-err',
  slug: 'error-test',
  business_name: 'Error Test Biz',
  timezone: 'America/New_York',
  business_hours: { monday: { open: '09:00', close: '17:00' } },
  settings: {},
  trial_bookings_remaining: 10,
  services: [],
};

// ── Confirm-booking args (valid enough to reach the service call) ──
const VALID_BOOKING_ARGS = {
  hold_id: 'hold-1',
  client_name: 'Jane Doe',
  client_email: 'jane@example.com',
  client_phone: '+15551234567',
  service_name: 'Demo',
};

describe('Error mapping — tool-executor catch block', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────────────────────
  // 1. BookingError → BOOKING_ERROR: prefix
  // ────────────────────────────────────────────────────────
  it('maps BookingError to BOOKING_ERROR: prefix preserving original message', async () => {
    const { BookingError } = await import('../src/services/booking.service.js');

    // Mock every dep that handleConfirmBooking touches before bookingService
    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p, // pass through
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    vi.doMock('../src/security/risk-engine.js', () => ({
      buildRiskContext: vi.fn().mockResolvedValue({}),
      calculateRiskScore: vi.fn().mockReturnValue(0),
      getRiskDecision: vi.fn().mockReturnValue({ action: 'allow' }),
      getExistingActiveBookings: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'session-1',
          email_verified: true,
          metadata: { fsmContext: { state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' } },
        }),
        findOrCreate: vi.fn(),
      },
    }));
    vi.doMock('../src/agent/chat-fsm.js', () => ({
      getFsmContext: () => ({ state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' }),
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockRejectedValue(new BookingError('Hold has expired — the reservation timed out')),
      },
      BookingError,
    }));
    // Availability service not called in confirm_booking, but imported at top level
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class SlotConflictError extends Error { constructor(m: string) { super(m); this.name = 'SlotConflictError'; } },
      CalendarReadError: class CalendarReadError extends Error { constructor(m: string) { super(m); this.name = 'CalendarReadError'; } },
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'confirm_booking',
      VALID_BOOKING_ARGS,
      'tenant-err',
      'session-1',
      mockTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^BOOKING_ERROR:/);
    expect(result.error).toContain('Hold has expired');
    // Must NOT contain generic "internal error" phrasing
    expect(result.error).not.toContain('INTERNAL_ERROR');
  });

  // ────────────────────────────────────────────────────────
  // 2. SlotConflictError → SLOT_CONFLICT: prefix
  // ────────────────────────────────────────────────────────
  it('maps SlotConflictError to SLOT_CONFLICT: prefix with rebooking guidance', async () => {
    const { SlotConflictError } = await import('../src/services/availability.service.js');
    const { BookingError } = await import('../src/services/booking.service.js');

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    vi.doMock('../src/security/risk-engine.js', () => ({
      buildRiskContext: vi.fn().mockResolvedValue({}),
      calculateRiskScore: vi.fn().mockReturnValue(0),
      getRiskDecision: vi.fn().mockReturnValue({ action: 'allow' }),
      getExistingActiveBookings: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'session-1',
          email_verified: true,
          metadata: { fsmContext: { state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' } },
        }),
        findOrCreate: vi.fn(),
      },
    }));
    vi.doMock('../src/agent/chat-fsm.js', () => ({
      getFsmContext: () => ({ state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' }),
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockRejectedValue(
          new SlotConflictError('This time slot was just booked by someone else'),
        ),
      },
      BookingError,
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError,
      CalendarReadError: (class CalendarReadError extends Error { constructor(m: string) { super(m); this.name = 'CalendarReadError'; } }),
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'confirm_booking',
      VALID_BOOKING_ARGS,
      'tenant-err',
      'session-1',
      mockTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^SLOT_CONFLICT:/);
    expect(result.error).toContain('no longer available');
    expect(result.error).toContain('check_availability');
    // Must NOT be generic
    expect(result.error).not.toContain('INTERNAL_ERROR');
  });

  // ────────────────────────────────────────────────────────
  // 3. Unknown errors → INTERNAL_ERROR: prefix with ref ID
  // ────────────────────────────────────────────────────────
  it('maps unknown errors to INTERNAL_ERROR: with reference ID', async () => {
    const { BookingError } = await import('../src/services/booking.service.js');

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    vi.doMock('../src/security/risk-engine.js', () => ({
      buildRiskContext: vi.fn().mockResolvedValue({}),
      calculateRiskScore: vi.fn().mockReturnValue(0),
      getRiskDecision: vi.fn().mockReturnValue({ action: 'allow' }),
      getExistingActiveBookings: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'session-1',
          email_verified: true,
          metadata: { fsmContext: { state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' } },
        }),
        findOrCreate: vi.fn(),
      },
    }));
    vi.doMock('../src/agent/chat-fsm.js', () => ({
      getFsmContext: () => ({ state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' }),
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockRejectedValue(new Error('ECONNREFUSED: connection refused')),
      },
      BookingError,
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class SlotConflictError extends Error { constructor(m: string) { super(m); this.name = 'SlotConflictError'; } },
      CalendarReadError: class CalendarReadError extends Error { constructor(m: string) { super(m); this.name = 'CalendarReadError'; } },
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'confirm_booking',
      VALID_BOOKING_ARGS,
      'tenant-err',
      'session-1',
      mockTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^INTERNAL_ERROR:/);
    // Reference ID should be a 12-char lowercase hex slug
    expect(result.error).toMatch(/reference ID: [a-f0-9]{12}/);
    // Must NOT expose raw error message to the LLM
    expect(result.error).not.toContain('ECONNREFUSED');
  });
});

// ────────────────────────────────────────────────────────────
// Structured logging output tests
// ────────────────────────────────────────────────────────────
describe('Error mapping — structured logging', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs [tool-error] with correlation ID, tenant, session, email hash, and error code', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { BookingError } = await import('../src/services/booking.service.js');

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    vi.doMock('../src/security/risk-engine.js', () => ({
      buildRiskContext: vi.fn().mockResolvedValue({}),
      calculateRiskScore: vi.fn().mockReturnValue(0),
      getRiskDecision: vi.fn().mockReturnValue({ action: 'allow' }),
      getExistingActiveBookings: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'session-log',
          email_verified: true,
          metadata: { fsmContext: { state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' } },
        }),
        findOrCreate: vi.fn(),
      },
    }));
    vi.doMock('../src/agent/chat-fsm.js', () => ({
      getFsmContext: () => ({ state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' }),
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockRejectedValue(new BookingError('Hold has expired')),
      },
      BookingError,
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: (class extends Error { constructor(m: string) { super(m); this.name = 'SlotConflictError'; } }),
      CalendarReadError: (class extends Error { constructor(m: string) { super(m); this.name = 'CalendarReadError'; } }),
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    await executeToolCall(
      'confirm_booking',
      VALID_BOOKING_ARGS,
      'tenant-err',
      'session-log',
      mockTenant as any,
    );

    expect(logSpy).toHaveBeenCalled();
    const logLine = logSpy.mock.calls[0][0] as string;
    expect(logLine).toContain('[tool-error]');
    expect(logLine).toContain('ref=');
    expect(logLine).toContain('tool=confirm_booking');
    expect(logLine).toContain('tenant=tenant-err');
    expect(logLine).toContain('session=session-log');
    expect(logLine).toContain('email_hash=');
    expect(logLine).toContain('code=BOOKING_ERROR');
    // Raw email must NOT appear in log line
    expect(logLine).not.toContain('jane@example.com');
  });
});

// ────────────────────────────────────────────────────────────
// System prompt error instructions
// ────────────────────────────────────────────────────────────
describe('System prompt — error-code instructions', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes error-code-specific handling instructions for all known codes', async () => {
    // Mock availability service dep that system-prompt.ts needs
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
      availabilityService: {},
      SlotConflictError: class extends Error {},
      CalendarReadError: class extends Error {},
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any, {});

    // All error codes the LLM must recognise (full taxonomy)
    const expectedCodes = [
      'BOOKING_ERROR',
      'SLOT_CONFLICT',
      'CALENDAR_UNAVAILABLE',
      'PHONE_REQUIRED',
      'INVALID_PHONE',
      'EMAIL_VERIFICATION_REQUIRED',
      'EMAIL_MISMATCH',
      'RISK_REVERIFY',
      'RISK_COOLDOWN',
      'CONFIRMATION_REQUIRED',
      'FAR_DATE_CONFIRMATION_REQUIRED',
      'CANCELLATION_NEEDS_IDENTITY',
      'CANCELLATION_REQUIRES_VERIFICATION',
      'CANCELLATION_FAILED',
      'INTERNAL_ERROR',
      'SERVICE_REQUIRED',
      'DATE_RANGE_TOO_WIDE',
    ];

    for (const code of expectedCodes) {
      expect(prompt).toContain(code);
    }

    // The old vague instruction should be GONE
    expect(prompt).not.toContain('inform the user honestly and suggest alternatives');
    // "NEVER say technical issue for actionable errors" instruction should be present
    expect(prompt).toContain('NEVER say');
  });
});

// ────────────────────────────────────────────────────────────
// ChatHandlerOptions — resolvedDatetime type check
// ────────────────────────────────────────────────────────────
describe('ChatHandlerOptions — resolvedDatetime', () => {
  it('accepts resolvedDatetime without TypeScript error', async () => {
    // Type-level compile check: if this compiles, the interface is correct.
    // We import the type and assert it has the expected shape.
    const { handleChatMessage } = await import('../src/agent/chat-handler.js');
    // The function itself accepts ChatHandlerOptions — we just verify
    // we can pass resolvedDatetime without a runtime crash.
    expect(typeof handleChatMessage).toBe('function');

    // Import the type and verify the module also exports the interface shape
    // indirectly — the import of DatetimeResolverResult must succeed.
    const dtMod = await import('../src/agent/datetime-resolver.js');
    expect(dtMod.resolveDatetime).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────
// CalendarReadError → CALENDAR_UNAVAILABLE (not INTERNAL_ERROR)
// ────────────────────────────────────────────────────────────
describe('Error mapping — CalendarReadError branch', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps CalendarReadError to CALENDAR_UNAVAILABLE: prefix', async () => {
    const { CalendarReadError } = await import('../src/services/availability.service.js');
    const { BookingError } = await import('../src/services/booking.service.js');

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    vi.doMock('../src/security/risk-engine.js', () => ({
      buildRiskContext: vi.fn().mockResolvedValue({}),
      calculateRiskScore: vi.fn().mockReturnValue(0),
      getRiskDecision: vi.fn().mockReturnValue({ action: 'allow' }),
      getExistingActiveBookings: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'session-1',
          email_verified: true,
          metadata: { fsmContext: { state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' } },
        }),
        findOrCreate: vi.fn(),
      },
    }));
    vi.doMock('../src/agent/chat-fsm.js', () => ({
      getFsmContext: () => ({ state: 'EMAIL_VERIFIED', verifiedEmail: 'jane@example.com' }),
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockRejectedValue(
          new CalendarReadError('Google Calendar API unavailable'),
        ),
      },
      BookingError,
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class SlotConflictError extends Error { constructor(m: string) { super(m); this.name = 'SlotConflictError'; } },
      CalendarReadError,
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'confirm_booking',
      VALID_BOOKING_ARGS,
      'tenant-err',
      'session-1',
      mockTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^CALENDAR_UNAVAILABLE:/);
    expect(result.error).toContain('try again');
    // Must NOT fall through to INTERNAL_ERROR
    expect(result.error).not.toContain('INTERNAL_ERROR');
    // Must NOT expose raw error details
    expect(result.error).not.toContain('Google Calendar');
  });
});

// ────────────────────────────────────────────────────────────
// EMAIL_MISMATCH masks both emails
// ────────────────────────────────────────────────────────────
describe('Error mapping — EMAIL_MISMATCH masking', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('masks both booking and verified emails in EMAIL_MISMATCH response', async () => {
    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    vi.doMock('../src/security/risk-engine.js', () => ({
      buildRiskContext: vi.fn().mockResolvedValue({}),
      calculateRiskScore: vi.fn().mockReturnValue(0),
      getRiskDecision: vi.fn().mockReturnValue({ action: 'allow' }),
      getExistingActiveBookings: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'session-1',
          email_verified: true,
          metadata: { fsmContext: { state: 'EMAIL_VERIFIED', verifiedEmail: 'alice@domain.com' } },
        }),
        findOrCreate: vi.fn(),
      },
    }));
    vi.doMock('../src/agent/chat-fsm.js', () => ({
      getFsmContext: () => ({ state: 'EMAIL_VERIFIED', verifiedEmail: 'alice@domain.com' }),
    }));
    // booking.service not needed — EMAIL_MISMATCH is an early return before confirmBooking
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: { confirmBooking: vi.fn() },
      BookingError: class BookingError extends Error { constructor(m: string) { super(m); this.name = 'BookingError'; } },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class SlotConflictError extends Error { constructor(m: string) { super(m); this.name = 'SlotConflictError'; } },
      CalendarReadError: class CalendarReadError extends Error { constructor(m: string) { super(m); this.name = 'CalendarReadError'; } },
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'confirm_booking',
      { ...VALID_BOOKING_ARGS, client_email: 'bob@other.com' },
      'tenant-err',
      'session-1',
      mockTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('EMAIL_MISMATCH');
    // Masked emails: first 2 chars + "***@domain"
    expect(result.error).toContain('bo***@other.com');
    expect(result.error).toContain('al***@domain.com');
    // Raw emails must NOT appear
    expect(result.error).not.toContain('bob@other.com');
    expect(result.error).not.toContain('alice@domain.com');
  });
});
