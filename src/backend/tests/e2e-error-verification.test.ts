// ============================================================
// E2E Structured Error Handling — Deterministic Verification
// ============================================================
//
// Exercises the full error-handling pipeline end-to-end:
//   tool-executor → structured log → tool result → system prompt
//
// Each scenario captures:
//   - The tool result (what the LLM sees)
//   - The structured log line (what ops sees)
//   - Key invariants (prefix, ref ID format, no PII, masking)
//
// Scenarios:
//   1. CalendarReadError → CALENDAR_UNAVAILABLE (not INTERNAL_ERROR)
//   2. INTERNAL_ERROR → 12-char hex ref ID matching log line
//   3. EMAIL_MISMATCH → masked emails (ja***@example.com)
//   4. SlotConflictError → SLOT_CONFLICT + rebooking guidance
//   5. BookingError (hold expired) → BOOKING_ERROR + rebook offer
//   6. resolvedDatetime → injected into conversation, LLM does not re-ask
//
// Run:
//   npx vitest run tests/e2e-error-verification.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared fixtures ─────────────────────────────────────────

const MOCK_TENANT = {
  id: 'tenant-e2e',
  slug: 'e2e-test',
  business_name: 'E2E Verification Biz',
  timezone: 'America/New_York',
  business_hours: {
    monday: { start: '09:00', end: '17:00' },
    tuesday: { start: '09:00', end: '17:00' },
    wednesday: { start: '09:00', end: '17:00' },
    thursday: { start: '09:00', end: '17:00' },
    friday: { start: '09:00', end: '17:00' },
    saturday: null,
    sunday: null,
  },
  settings: {},
  trial_bookings_remaining: 10,
  services: [{ name: 'Consultation', duration_minutes: 30, price: 50 }],
} as any;

const BOOKING_ARGS = {
  hold_id: 'hold-e2e-1',
  client_name: 'Jane Doe',
  client_email: 'jane@example.com',
  client_phone: '+15551234567',
  service_name: 'Consultation',
};

/** Standard mocks for all scenarios that go through handleConfirmBooking */
function setupConfirmBookingMocks(overrides: {
  confirmBookingImpl?: () => Promise<any>;
  verifiedEmail?: string;
  sessionEmail?: string;
} = {}) {
  const verifiedEmail = overrides.verifiedEmail ?? 'jane@example.com';

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
        id: 'session-e2e',
        email_verified: true,
        metadata: { fsmContext: { state: 'EMAIL_VERIFIED', verifiedEmail } },
      }),
      findOrCreate: vi.fn(),
    },
  }));
  vi.doMock('../src/agent/chat-fsm.js', () => ({
    getFsmContext: () => ({ state: 'EMAIL_VERIFIED', verifiedEmail }),
  }));

  return { verifiedEmail };
}

// ============================================================
// SCENARIO 1: CalendarReadError → CALENDAR_UNAVAILABLE
// ============================================================
describe('E2E Scenario 1: CalendarReadError → CALENDAR_UNAVAILABLE', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('returns CALENDAR_UNAVAILABLE prefix, NOT INTERNAL_ERROR, and logs CALENDAR_READ_ERROR', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { CalendarReadError } = await import('../src/services/availability.service.js');
    const { BookingError } = await import('../src/services/booking.service.js');

    setupConfirmBookingMocks();
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockRejectedValue(
          new CalendarReadError('Google Calendar API: 503 Service Unavailable'),
        ),
      },
      BookingError,
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class extends Error { constructor(m: string) { super(m); this.name = 'SlotConflictError'; } },
      CalendarReadError,
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall('confirm_booking', BOOKING_ARGS, 'tenant-e2e', 'session-e2e', MOCK_TENANT);

    // ── Tool result assertions ──
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^CALENDAR_UNAVAILABLE:/);
    expect(result.error).toContain('try again');
    expect(result.error).not.toContain('INTERNAL_ERROR');
    expect(result.error).not.toContain('Google Calendar');  // no raw error leak

    // ── Log assertions ──
    expect(logSpy).toHaveBeenCalledOnce();
    const logLine = logSpy.mock.calls[0][0] as string;
    expect(logLine).toContain('[tool-error]');
    expect(logLine).toContain('code=CALENDAR_READ_ERROR');
    expect(logLine).toContain('tool=confirm_booking');
    expect(logLine).toContain('tenant=tenant-e2e');
    expect(logLine).toContain('session=session-e2e');
    // ref= is 12 lowercase hex chars
    expect(logLine).toMatch(/ref=[a-f0-9]{12}/);

    console.log('\n── SCENARIO 1 RESULT ──');
    console.log('Tool result:', JSON.stringify(result, null, 2));
    console.log('Log line:', logLine);
    console.log('VERDICT: ✅ CALENDAR_UNAVAILABLE path exercised, INTERNAL_ERROR avoided');
  });
});

// ============================================================
// SCENARIO 2: INTERNAL_ERROR with 12-char hex ref ID
// ============================================================
describe('E2E Scenario 2: INTERNAL_ERROR — 12-char hex ref matching logs', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('returns INTERNAL_ERROR with 12-char hex ref ID that matches log line ref=', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { BookingError } = await import('../src/services/booking.service.js');

    setupConfirmBookingMocks();
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockRejectedValue(new Error('ECONNREFUSED: connection refused')),
      },
      BookingError,
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class extends Error { constructor(m: string) { super(m); this.name = 'SlotConflictError'; } },
      CalendarReadError: class extends Error { constructor(m: string) { super(m); this.name = 'CalendarReadError'; } },
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall('confirm_booking', BOOKING_ARGS, 'tenant-e2e', 'session-e2e', MOCK_TENANT);

    // ── Tool result: INTERNAL_ERROR with ref ID ──
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^INTERNAL_ERROR:/);
    const refMatch = result.error!.match(/reference ID: ([a-f0-9]{12})/);
    expect(refMatch).not.toBeNull();
    const refFromResult = refMatch![1];

    // ── Must NOT leak raw error ──
    expect(result.error).not.toContain('ECONNREFUSED');

    // ── Log line: same ref ID ──
    expect(logSpy).toHaveBeenCalledOnce();
    const logLine = logSpy.mock.calls[0][0] as string;
    const logRefMatch = logLine.match(/ref=([a-f0-9]{12})/);
    expect(logRefMatch).not.toBeNull();
    const refFromLog = logRefMatch![1];

    // ── Critical: ref IDs match between user message and log ──
    expect(refFromResult).toBe(refFromLog);

    // ── Log has all structured fields ──
    expect(logLine).toContain('code=CONNECTION_ERROR');
    expect(logLine).toContain('tool=confirm_booking');
    expect(logLine).toContain('email_hash=');
    expect(logLine).not.toContain('jane@example.com');

    console.log('\n── SCENARIO 2 RESULT ──');
    console.log('Tool result ref:', refFromResult);
    console.log('Log line ref:', refFromLog);
    console.log('Match:', refFromResult === refFromLog ? '✅ MATCH' : '❌ MISMATCH');
    console.log('Log line:', logLine);
    console.log('VERDICT: ✅ 12-char hex ref ID matches between user message and log');
  });
});

// ============================================================
// SCENARIO 3: EMAIL_MISMATCH with masked emails
// ============================================================
describe('E2E Scenario 3: EMAIL_MISMATCH — masked emails', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('masks both booking and verified emails; raw emails never exposed', async () => {
    setupConfirmBookingMocks({ verifiedEmail: 'alice@domain.com' });

    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: { confirmBooking: vi.fn() },
      BookingError: class extends Error { constructor(m: string) { super(m); this.name = 'BookingError'; } },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class extends Error { constructor(m: string) { super(m); this.name = 'SlotConflictError'; } },
      CalendarReadError: class extends Error { constructor(m: string) { super(m); this.name = 'CalendarReadError'; } },
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'confirm_booking',
      { ...BOOKING_ARGS, client_email: 'bob@other.com' },
      'tenant-e2e',
      'session-e2e',
      MOCK_TENANT,
    );

    // ── Tool result: EMAIL_MISMATCH with masked emails ──
    expect(result.success).toBe(false);
    expect(result.error).toContain('EMAIL_MISMATCH');

    // Masked forms present
    expect(result.error).toContain('bo***@other.com');
    expect(result.error).toContain('al***@domain.com');

    // Raw emails NOT present
    expect(result.error).not.toContain('bob@other.com');
    expect(result.error).not.toContain('alice@domain.com');

    console.log('\n── SCENARIO 3 RESULT ──');
    console.log('Tool result:', JSON.stringify(result, null, 2));
    console.log('VERDICT: ✅ Emails masked — raw addresses never reach LLM context');
  });
});

// ============================================================
// SCENARIO 4: SlotConflictError → SLOT_CONFLICT
// ============================================================
describe('E2E Scenario 4: SlotConflictError → SLOT_CONFLICT', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('returns SLOT_CONFLICT with rebooking guidance mentioning check_availability', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { SlotConflictError } = await import('../src/services/availability.service.js');
    const { BookingError } = await import('../src/services/booking.service.js');

    setupConfirmBookingMocks();
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockRejectedValue(
          new SlotConflictError('exclusion_violation: 23P01'),
        ),
      },
      BookingError,
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError,
      CalendarReadError: class extends Error { constructor(m: string) { super(m); this.name = 'CalendarReadError'; } },
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall('confirm_booking', BOOKING_ARGS, 'tenant-e2e', 'session-e2e', MOCK_TENANT);

    // ── Tool result: SLOT_CONFLICT prefix ──
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^SLOT_CONFLICT:/);
    expect(result.error).toContain('no longer available');
    expect(result.error).toContain('check_availability');
    expect(result.error).not.toContain('INTERNAL_ERROR');
    expect(result.error).not.toContain('23P01');  // no raw DB error

    // ── Log: code=SLOT_CONFLICT ──
    const logLine = logSpy.mock.calls[0][0] as string;
    expect(logLine).toContain('code=SLOT_CONFLICT');
    expect(logLine).toMatch(/ref=[a-f0-9]{12}/);

    console.log('\n── SCENARIO 4 RESULT ──');
    console.log('Tool result:', JSON.stringify(result, null, 2));
    console.log('Log line:', logLine);
    console.log('VERDICT: ✅ SLOT_CONFLICT path — LLM instructed to call check_availability');
  });
});

// ============================================================
// SCENARIO 5: BookingError (hold expired) → BOOKING_ERROR
// ============================================================
describe('E2E Scenario 5: Hold expired → BOOKING_ERROR', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('returns BOOKING_ERROR with original message, not generic technical issue', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { BookingError } = await import('../src/services/booking.service.js');

    setupConfirmBookingMocks();
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {
        confirmBooking: vi.fn().mockRejectedValue(
          new BookingError('Hold has expired — the 10-minute reservation window has passed'),
        ),
      },
      BookingError,
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {},
      SlotConflictError: class extends Error { constructor(m: string) { super(m); this.name = 'SlotConflictError'; } },
      CalendarReadError: class extends Error { constructor(m: string) { super(m); this.name = 'CalendarReadError'; } },
      getCalendarDebugSnapshot: vi.fn(),
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall('confirm_booking', BOOKING_ARGS, 'tenant-e2e', 'session-e2e', MOCK_TENANT);

    // ── Tool result: BOOKING_ERROR with original message preserved ──
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^BOOKING_ERROR:/);
    expect(result.error).toContain('Hold has expired');
    expect(result.error).toContain('10-minute reservation');
    expect(result.error).not.toContain('INTERNAL_ERROR');
    expect(result.error).not.toContain('technical issue');  // no generic fallback

    // ── Log: code=BOOKING_ERROR ──
    const logLine = logSpy.mock.calls[0][0] as string;
    expect(logLine).toContain('code=BOOKING_ERROR');
    expect(logLine).toMatch(/ref=[a-f0-9]{12}/);
    expect(logLine).not.toContain('jane@example.com');

    console.log('\n── SCENARIO 5 RESULT ──');
    console.log('Tool result:', JSON.stringify(result, null, 2));
    console.log('Log line:', logLine);
    console.log('VERDICT: ✅ BOOKING_ERROR — original message preserved, LLM can relay to customer');
  });
});

// ============================================================
// SCENARIO 6: resolvedDatetime injection → no re-ask
// ============================================================
describe('E2E Scenario 6: resolvedDatetime continuity', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('injects RESOLVED DATE/TIME system message into conversation when resolvedDatetime is provided', async () => {
    // This scenario tests the chat-handler.ts injection path (step 3a).
    // We verify that when resolvedDatetime is passed via ChatHandlerOptions,
    // it gets injected as a system message with the exact ISO timestamps,
    // and the instruction "Do NOT re-ask the customer for the date/time."

    // Track what conversation gets saved
    let savedConversation: any[] = [];

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findOrCreate: vi.fn().mockResolvedValue({
          id: 'session-dt',
          tenant_id: MOCK_TENANT.id,
          customer_id: null,
          channel: 'web',
          conversation: [],
          metadata: {},
          email_verified: false,
          message_count: 0,
          user_message_count: 0,
          booking_count: 0,
          created_at: new Date(),
          updated_at: new Date(),
        }),
        updateConversation: vi.fn().mockImplementation((_id: string, convo: any[]) => {
          savedConversation = convo;
          return Promise.resolve(undefined);
        }),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: undefined,
        OPENAI_MODEL: 'gpt-4o',
        CALENDAR_DEBUG: 'false',
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
        NODE_ENV: 'test',
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    vi.doMock('../src/storefront/router.js', () => ({
      routeStorefrontQuestion: vi.fn().mockResolvedValue(null),
      buildStorefrontContextPrompt: vi.fn().mockReturnValue(''),
    }));
    vi.doMock('../src/storefront/gomomo-facts.js', () => ({
      GOMOMO_FACTS: { agent_identity_statement: 'I am your AI assistant.' },
    }));
    vi.doMock('../src/agent/response-post-processor.js', () => ({
      postProcessResponse: (text: string) => text,
    }));
    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));
    vi.doMock('../src/services/clock.js', () => ({
      formatNow: () => 'Wednesday, February 18, 2026 3:00 PM',
      getTodayISO: () => '2026-02-18',
      getNow: () => new Date('2026-02-18T15:00:00-05:00'),
    }));

    // Mock OpenAI to return a simple streaming response (no tool calls).
    // handleChatMessage uses stream: true, so we return an async iterable of chunks.
    vi.doMock('openai', () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              [Symbol.asyncIterator]: async function* () {
                yield {
                  choices: [{
                    delta: {
                      content: 'Great, I see you want 3 PM today. Let me check availability for that time.',
                      tool_calls: undefined,
                    },
                    finish_reason: 'stop',
                  }],
                };
              },
            }),
          },
        };
      },
    }));

    const { handleChatMessage } = await import('../src/agent/chat-handler.js');

    const { response } = await handleChatMessage(
      'session-dt',
      MOCK_TENANT.id,
      'I want to book a consultation today at 3pm',
      MOCK_TENANT,
      {
        resolvedDatetime: {
          start_iso: '2026-02-18T15:00:00-05:00',
          end_iso: '2026-02-18T15:30:00-05:00',
          confidence: 'high' as const,
          reasons: ['Resolved "today at 3pm" using client timezone America/New_York'],
        },
      },
    );

    // ── The saved conversation must include the RESOLVED DATE/TIME system message ──
    const dtMessages = savedConversation.filter(
      (m: any) => m.role === 'system' && m.content.includes('RESOLVED DATE/TIME'),
    );
    expect(dtMessages).toHaveLength(1);

    const dtMsg = dtMessages[0].content;
    expect(dtMsg).toContain('start=2026-02-18T15:00:00-05:00');
    expect(dtMsg).toContain('end=2026-02-18T15:30:00-05:00');
    expect(dtMsg).toContain('confidence: high');
    expect(dtMsg).toContain('Do NOT re-ask the customer for the date/time');

    // ── The LLM should have received the message and responded (no re-ask) ──
    expect(response).toBeTruthy();
    expect(typeof response).toBe('string');

    console.log('\n── SCENARIO 6 RESULT ──');
    console.log('RESOLVED DATE/TIME message:', dtMsg);
    console.log('LLM response:', response);
    console.log('VERDICT: ✅ resolvedDatetime injected — LLM instructed not to re-ask');
  });
});

// ============================================================
// BONUS: System prompt rule 4 — full taxonomy verification
// ============================================================
describe('E2E Bonus: System prompt rule 4 — full taxonomy', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('system prompt contains all 17 error codes with action instructions', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(MOCK_TENANT as any, {});

    // Full taxonomy — every code that tool-executor can return
    const allCodes = [
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

    const missing: string[] = [];
    for (const code of allCodes) {
      if (!prompt.includes(code)) missing.push(code);
    }

    expect(missing).toEqual([]);

    // The NEVER constraint must be present
    expect(prompt).toContain('NEVER say "a technical issue occurred"');
    expect(prompt).toContain('Only use that phrasing for INTERNAL_ERROR');

    console.log('\n── BONUS: SYSTEM PROMPT TAXONOMY ──');
    console.log(`All ${allCodes.length} error codes present in rule 4: ✅`);
    console.log('NEVER constraint present: ✅');
  });
});
