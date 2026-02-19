// ============================================================
// Chat FSM — Hybrid FSM + LLM Architecture Tests
// ============================================================
// Verifies:
//   1. Deterministic intents (greeting, FAQ, email/OTP) do NOT call LLM
//   2. Cannot book without verified email (booking gate)
//   3. Switching email forces re-verification
//   4. Intent classifier correctness
//   5. FSM state transitions
//   6. Template rendering
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helpers ─────────────────────────────────────────────────

const mockTenant = {
  id: 'tenant-test',
  slug: 'test-biz',
  name: 'Test Business',
  timezone: 'America/New_York',
  business_type: 'service',
  services: [{ name: 'Consultation', duration_minutes: 30, price: 50 }],
  business_hours: {
    monday: { start: '09:00', end: '17:00' },
    tuesday: { start: '09:00', end: '17:00' },
    wednesday: { start: '09:00', end: '17:00' },
    thursday: { start: '09:00', end: '17:00' },
    friday: { start: '09:00', end: '17:00' },
    saturday: null,
    sunday: null,
  },
} as any;

function makeSession(overrides: Partial<{
  metadata: Record<string, unknown>;
  email_verified: boolean;
  conversation: any[];
}> = {}) {
  return {
    id: 'sess-fsm-test',
    tenant_id: mockTenant.id,
    customer_id: null,
    channel: 'web' as const,
    conversation: overrides.conversation ?? [],
    metadata: overrides.metadata ?? {},
    email_verified: overrides.email_verified ?? false,
    message_count: 0,
    user_message_count: 0,
    booking_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

// ── Standard mocks ──────────────────────────────────────────

function setupBaseMocks(sessionOverrides?: Parameters<typeof makeSession>[0]) {
  const session = makeSession(sessionOverrides);

  vi.doMock('../src/repos/session.repo.js', () => ({
    sessionRepo: {
      findOrCreate: vi.fn().mockResolvedValue(session),
      findById: vi.fn().mockResolvedValue(session),
      updateConversation: vi.fn().mockResolvedValue(undefined),
      updateMetadata: vi.fn().mockResolvedValue(undefined),
      markEmailVerified: vi.fn().mockResolvedValue(undefined),
      linkCustomer: vi.fn().mockResolvedValue(undefined),
      isEmailVerified: vi.fn().mockResolvedValue(session.email_verified),
      getCustomerIdentity: vi.fn().mockResolvedValue(null),
      incrementMessageCount: vi.fn().mockResolvedValue(1),
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
      EMAIL_VERIFICATION_RATE_LIMIT: '5',
      EMAIL_VERIFICATION_TTL_MINUTES: '15',
      REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: 'false',
    },
  }));

  vi.doMock('../src/repos/email-verification.repo.js', () => ({
    emailVerificationRepo: {
      create: vi.fn().mockResolvedValue({ code: '123456' }),
      verify: vi.fn().mockResolvedValue(true),
      countRecent: vi.fn().mockResolvedValue(0),
    },
    validateEmail: vi.fn().mockReturnValue(null), // null = valid
  }));

  vi.doMock('../src/email/transport.js', () => ({
    sendVerificationEmail: vi.fn().mockResolvedValue({ success: true }),
  }));

  vi.doMock('../src/services/customer.service.js', () => ({
    customerService: {
      resolveByEmail: vi.fn().mockResolvedValue({ customer: { id: 'cust-1' }, created: false }),
      resolveByPhone: vi.fn().mockResolvedValue({ customer: { id: 'cust-1' }, created: false }),
      getReturningContext: vi.fn().mockResolvedValue(null),
    },
  }));

  vi.doMock('../src/services/availability.service.js', () => ({
    isDemoAvailabilityActive: () => false,
  }));

  vi.doMock('../src/agent/response-post-processor.js', () => ({
    postProcessResponse: (text: string) => text,
  }));

  vi.doMock('../src/voice/phone-normalizer.js', () => ({
    normalizePhone: (p: string) => p,
  }));

  vi.doMock('../src/storefront/faq-repo.js', () => ({
    findApprovedAnswer: async () => null,
    logUnansweredFaq: async () => ({}),
  }));
}

// ============================================================
// A. Pure unit tests — intent classifier, FSM, templates
//    (no mocks needed, direct imports)
// ============================================================

describe('Intent Classifier — pure', () => {
  it('classifies greetings', async () => {
    const { classifyIntent } = await import('../src/agent/intent-classifier.js');

    expect(classifyIntent('hello').intent).toBe('GREETING');
    expect(classifyIntent('Hi!').intent).toBe('GREETING');
    expect(classifyIntent('Hey').intent).toBe('GREETING');
    expect(classifyIntent('Good morning').intent).toBe('GREETING');
    expect(classifyIntent("what's up").intent).toBe('GREETING');
  });

  it('classifies booking intents', async () => {
    const { classifyIntent } = await import('../src/agent/intent-classifier.js');

    expect(classifyIntent('I want to book an appointment').intent).toBe('BOOK_DEMO');
    expect(classifyIntent('Can I schedule a demo?').intent).toBe('BOOK_DEMO');
    expect(classifyIntent('Book me a session').intent).toBe('BOOK_DEMO');
    expect(classifyIntent("let's try").intent).toBe('BOOK_DEMO');
  });

  it('classifies email inputs', async () => {
    const { classifyIntent } = await import('../src/agent/intent-classifier.js');

    expect(classifyIntent('user@example.com').intent).toBe('PROVIDE_EMAIL');
    expect(classifyIntent('test.user+tag@domain.co').intent).toBe('PROVIDE_EMAIL');
  });

  it('classifies OTP in OTP_SENT state', async () => {
    const { classifyIntent } = await import('../src/agent/intent-classifier.js');

    // Without context, 6 digits is just an OTP
    expect(classifyIntent('123456', 'OTP_SENT').intent).toBe('PROVIDE_OTP');
    // With context, even shorter messages that look like digits
    expect(classifyIntent('  654321  ', 'OTP_SENT').intent).toBe('PROVIDE_OTP');
  });

  it('classifies change-email intents', async () => {
    const { classifyIntent } = await import('../src/agent/intent-classifier.js');

    expect(classifyIntent('I want to change my email').intent).toBe('CHANGE_EMAIL');
    expect(classifyIntent('use a different email').intent).toBe('CHANGE_EMAIL');
    expect(classifyIntent("that's not my email").intent).toBe('CHANGE_EMAIL');
  });

  it('classifies FAQ booking intents', async () => {
    const { classifyIntent } = await import('../src/agent/intent-classifier.js');

    expect(classifyIntent('how does booking work?').intent).toBe('FAQ_BOOKING');
    expect(classifyIntent('what services do you offer?').intent).toBe('FAQ_BOOKING');
    expect(classifyIntent('what are your business hours?').intent).toBe('FAQ_BOOKING');
  });

  it('classifies general sales questions', async () => {
    const { classifyIntent } = await import('../src/agent/intent-classifier.js');

    expect(classifyIntent('what is your pricing?').intent).toBe('GENERAL_SALES_Q');
    expect(classifyIntent('tell me about gomomo').intent).toBe('GENERAL_SALES_Q');
    expect(classifyIntent('what features do you have?').intent).toBe('GENERAL_SALES_Q');
  });

  it('extracts email addresses', async () => {
    const { extractEmail } = await import('../src/agent/intent-classifier.js');

    expect(extractEmail('my email is user@example.com')).toBe('user@example.com');
    expect(extractEmail('user@example.com')).toBe('user@example.com');
    expect(extractEmail('no email here')).toBeNull();
  });

  it('extracts OTP codes', async () => {
    const { extractOtp } = await import('../src/agent/intent-classifier.js');

    expect(extractOtp('123456')).toBe('123456');
    expect(extractOtp('  654321  ')).toBe('654321');
    expect(extractOtp('12-34-56')).toBe('123456'); // strips dashes
    expect(extractOtp('hi')).toBeNull();
    expect(extractOtp('my code is 123456')).toBeNull(); // strict: full message must be digits
  });
});

describe('FSM Transitions — pure', () => {
  it('GREETING in ANON → stays/moves to SALES_CHAT, returns TEMPLATE', async () => {
    const { transition, defaultFsmContext } = await import('../src/agent/chat-fsm.js');
    const ctx = defaultFsmContext();

    const action = transition('GREETING', ctx);
    expect(action.type).toBe('TEMPLATE');
    expect(action.nextState).toBe('SALES_CHAT');
    if (action.type === 'TEMPLATE') {
      expect(action.template).toBe('GREETING');
    }
  });

  it('BOOK_DEMO in ANON without verified email → ASK_EMAIL', async () => {
    const { transition, defaultFsmContext } = await import('../src/agent/chat-fsm.js');
    const ctx = defaultFsmContext();

    const action = transition('BOOK_DEMO', ctx);
    expect(action.type).toBe('TEMPLATE');
    expect(action.nextState).toBe('EMAIL_REQUESTED');
    if (action.type === 'TEMPLATE') {
      expect(action.template).toBe('ASK_EMAIL');
    }
  });

  it('PROVIDE_EMAIL in EMAIL_REQUESTED → SEND_OTP', async () => {
    const { transition, defaultFsmContext } = await import('../src/agent/chat-fsm.js');
    const ctx = { ...defaultFsmContext(), state: 'EMAIL_REQUESTED' as const };

    const action = transition('PROVIDE_EMAIL', ctx, { email: 'user@test.com' });
    expect(action.type).toBe('SEND_OTP');
    expect(action.nextState).toBe('OTP_SENT');
    if (action.type === 'SEND_OTP') {
      expect(action.email).toBe('user@test.com');
    }
  });

  it('PROVIDE_OTP in OTP_SENT → VERIFY_OTP', async () => {
    const { transition, defaultFsmContext } = await import('../src/agent/chat-fsm.js');
    const ctx = {
      ...defaultFsmContext(),
      state: 'OTP_SENT' as const,
      pendingEmail: 'user@test.com',
      otpAttempts: 0,
    };

    const action = transition('PROVIDE_OTP', ctx, { otpCode: '123456' });
    expect(action.type).toBe('VERIFY_OTP');
    expect(action.nextState).toBe('EMAIL_VERIFIED');
    if (action.type === 'VERIFY_OTP') {
      expect(action.code).toBe('123456');
    }
  });

  it('BOOK_DEMO in EMAIL_VERIFIED → PASS_TO_LLM', async () => {
    const { transition, defaultFsmContext } = await import('../src/agent/chat-fsm.js');
    const ctx = {
      ...defaultFsmContext(),
      state: 'EMAIL_VERIFIED' as const,
      verifiedEmail: 'user@test.com',
    };

    const action = transition('BOOK_DEMO', ctx);
    expect(action.type).toBe('PASS_TO_LLM');
    expect(action.nextState).toBe('BOOKING_FLOW');
  });

  it('GENERAL_SALES_Q always → PASS_TO_LLM', async () => {
    const { transition, defaultFsmContext } = await import('../src/agent/chat-fsm.js');
    const ctx = defaultFsmContext();

    const action = transition('GENERAL_SALES_Q', ctx);
    expect(action.type).toBe('PASS_TO_LLM');
  });

  it('CHANGE_EMAIL → EMAIL_REQUESTED (re-verify flow)', async () => {
    const { transition, defaultFsmContext } = await import('../src/agent/chat-fsm.js');
    const ctx = {
      ...defaultFsmContext(),
      state: 'EMAIL_VERIFIED' as const,
      verifiedEmail: 'old@test.com',
    };

    const action = transition('CHANGE_EMAIL', ctx);
    expect(action.type).toBe('TEMPLATE');
    expect(action.nextState).toBe('EMAIL_REQUESTED');
    if (action.type === 'TEMPLATE') {
      expect(action.template).toBe('ASK_NEW_EMAIL');
    }
  });

  it('PROVIDE_EMAIL with different email in EMAIL_VERIFIED → SEND_OTP (re-verify)', async () => {
    const { transition, defaultFsmContext } = await import('../src/agent/chat-fsm.js');
    const ctx = {
      ...defaultFsmContext(),
      state: 'EMAIL_VERIFIED' as const,
      verifiedEmail: 'old@test.com',
    };

    const action = transition('PROVIDE_EMAIL', ctx, { email: 'new@test.com' });
    expect(action.type).toBe('SEND_OTP');
    if (action.type === 'SEND_OTP') {
      expect(action.email).toBe('new@test.com');
    }
  });

  it('OTP max attempts → EMAIL_REQUESTED (reset flow)', async () => {
    const { transition, defaultFsmContext } = await import('../src/agent/chat-fsm.js');
    const ctx = {
      ...defaultFsmContext(),
      state: 'OTP_SENT' as const,
      pendingEmail: 'user@test.com',
      otpAttempts: 10, // maxed out
    };

    const action = transition('PROVIDE_OTP', ctx, { otpCode: '000000' });
    expect(action.type).toBe('TEMPLATE');
    expect(action.nextState).toBe('EMAIL_REQUESTED');
    if (action.type === 'TEMPLATE') {
      expect(action.template).toBe('OTP_MAX_ATTEMPTS');
    }
  });
});

describe('FSM Context Persistence — pure', () => {
  it('getFsmContext returns default for empty metadata', async () => {
    const { getFsmContext, defaultFsmContext } = await import('../src/agent/chat-fsm.js');

    const ctx = getFsmContext({});
    expect(ctx).toEqual(defaultFsmContext());
  });

  it('setFsmContext round-trips correctly', async () => {
    const { getFsmContext, setFsmContext, defaultFsmContext } = await import('../src/agent/chat-fsm.js');

    const original = {
      ...defaultFsmContext(),
      state: 'EMAIL_VERIFIED' as const,
      verifiedEmail: 'user@test.com',
    };

    const metadata = setFsmContext({}, original);
    const restored = getFsmContext(metadata);

    expect(restored.state).toBe('EMAIL_VERIFIED');
    expect(restored.verifiedEmail).toBe('user@test.com');
  });
});

describe('Deterministic Templates — pure', () => {
  it('renders all template IDs without error', async () => {
    const { renderTemplate } = await import('../src/agent/deterministic-templates.js');

    const ids = [
      'GREETING', 'GREETING_VERIFIED', 'FAQ_BOOKING', 'ASK_EMAIL',
      'ASK_EMAIL_AGAIN', 'ASK_NEW_EMAIL', 'INVALID_EMAIL', 'OTP_SENT',
      'OTP_PENDING', 'OTP_VERIFIED', 'OTP_FAILED', 'OTP_MAX_ATTEMPTS',
      'OTP_NOT_EXPECTED', 'INVALID_OTP', 'ALREADY_VERIFIED',
      'BOOKING_REQUIRES_EMAIL', 'EMAIL_CHANGE_REVERIFY',
    ] as const;

    for (const id of ids) {
      const result = renderTemplate(id, { email: 'test@example.com', verifiedEmail: 'test@example.com', attemptsLeft: 3 });
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    }
  });

  it('OTP_SENT template includes the email', async () => {
    const { renderTemplate } = await import('../src/agent/deterministic-templates.js');

    const result = renderTemplate('OTP_SENT', { email: 'user@example.com' });
    expect(result).toContain('user@example.com');
    expect(result).toContain('6-digit');
  });

  it('GREETING template includes Gomomo name', async () => {
    const { renderTemplate } = await import('../src/agent/deterministic-templates.js');

    const result = renderTemplate('GREETING');
    expect(result).toContain('Gomomo');
  });
});

// ============================================================
// B. Integration tests — routeChat with mocked dependencies
// ============================================================

describe('routeChat — deterministic intents do NOT call LLM', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('"hello" returns deterministic greeting, no LLM call', async () => {
    setupBaseMocks();

    // Mock OpenAI — should NOT be called
    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { routeChat } = await import('../src/agent/chat-router.js');

    const result = await routeChat('sess-1', mockTenant.id, 'Hello!', mockTenant);

    expect(result.deterministic).toBe(true);
    expect(result.response).toContain('Gomomo');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('"how does booking work?" returns deterministic FAQ, no LLM call', async () => {
    setupBaseMocks();

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { routeChat } = await import('../src/agent/chat-router.js');

    const result = await routeChat('sess-1', mockTenant.id, 'how does booking work?', mockTenant);

    expect(result.deterministic).toBe(true);
    expect(result.response).toContain('how it works');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('"I want to book" asks for email (deterministic, no LLM)', async () => {
    setupBaseMocks();

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { routeChat } = await import('../src/agent/chat-router.js');

    const result = await routeChat('sess-1', mockTenant.id, 'I want to book an appointment', mockTenant);

    expect(result.deterministic).toBe(true);
    expect(result.response).toContain('email');
    expect(result.fsmContext.state).toBe('EMAIL_REQUESTED');
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('routeChat — email OTP flow', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('providing email in EMAIL_REQUESTED state sends OTP', async () => {
    setupBaseMocks({
      metadata: { fsm: { state: 'EMAIL_REQUESTED', pendingEmail: null, verifiedEmail: null, otpAttempts: 0, otpSentAt: null } },
    });

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { routeChat } = await import('../src/agent/chat-router.js');

    const result = await routeChat('sess-1', mockTenant.id, 'user@test.com', mockTenant);

    expect(result.deterministic).toBe(true);
    expect(result.response).toContain('user@test.com');
    expect(result.response).toContain('6-digit');
    expect(result.fsmContext.state).toBe('OTP_SENT');
    expect(result.fsmContext.pendingEmail).toBe('user@test.com');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('providing correct OTP in OTP_SENT state verifies email', async () => {
    setupBaseMocks({
      metadata: { fsm: { state: 'OTP_SENT', pendingEmail: 'user@test.com', verifiedEmail: null, otpAttempts: 0, otpSentAt: new Date().toISOString() } },
    });

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { routeChat } = await import('../src/agent/chat-router.js');

    const result = await routeChat('sess-1', mockTenant.id, '123456', mockTenant);

    expect(result.deterministic).toBe(true);
    expect(result.response).toContain('verified');
    expect(result.fsmContext.state).toBe('EMAIL_VERIFIED');
    expect(result.fsmContext.verifiedEmail).toBe('user@test.com');
    expect(createMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// C. Booking gate tests (tool-executor level)
// ============================================================

describe('Booking Gate — cannot book without verified email', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects confirm_booking when session has no verified email', async () => {
    // Session with NO email_verified and NO fsm.verifiedEmail
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue(makeSession({
          email_verified: false,
          metadata: { fsm: { state: 'SALES_CHAT', pendingEmail: null, verifiedEmail: null, otpAttempts: 0, otpSentAt: null } },
        })),
      },
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: { NODE_ENV: 'test' },
    }));

    // We need to mock the DB query import used in tool-executor
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn() },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'confirm_booking',
      {
        client_name: 'Test User',
        client_email: 'user@test.com',
        client_phone: '+1234567890',
        start_time: '2025-03-01T10:00:00Z',
        service_name: 'Consultation',
      },
      mockTenant.id,
      'sess-no-verify',
      mockTenant,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('EMAIL_VERIFICATION_REQUIRED');
  });

  it('rejects confirm_booking when booking email != verified email', async () => {
    // Session IS verified but for a DIFFERENT email
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue(makeSession({
          email_verified: true,
          metadata: { fsm: { state: 'EMAIL_VERIFIED', pendingEmail: null, verifiedEmail: 'verified@test.com', otpAttempts: 0, otpSentAt: null } },
        })),
      },
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: { NODE_ENV: 'test' },
    }));

    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn() },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');

    const result = await executeToolCall(
      'confirm_booking',
      {
        client_name: 'Test User',
        client_email: 'different@test.com',  // Different from verified!
        client_phone: '+1234567890',
        start_time: '2025-03-01T10:00:00Z',
        service_name: 'Consultation',
      },
      mockTenant.id,
      'sess-mismatch',
      mockTenant,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('EMAIL_MISMATCH');
    // Emails are now masked: first 2 chars + "***@domain"
    expect(result.error).toContain('di***@test.com');
    expect(result.error).toContain('ve***@test.com');
  });
});

// ============================================================
// D. Email change forces re-verify
// ============================================================

describe('Email change forces re-verification', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('providing a different email in EMAIL_VERIFIED triggers re-verify OTP', async () => {
    // Session is already verified with one email
    setupBaseMocks({
      metadata: { fsm: { state: 'EMAIL_VERIFIED', pendingEmail: null, verifiedEmail: 'old@test.com', otpAttempts: 0, otpSentAt: null } },
      email_verified: true,
    });

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { routeChat } = await import('../src/agent/chat-router.js');

    const result = await routeChat('sess-1', mockTenant.id, 'new@test.com', mockTenant);

    expect(result.deterministic).toBe(true);
    expect(result.fsmContext.state).toBe('OTP_SENT');
    expect(result.response).toContain('new@test.com');
    expect(result.response).toContain('6-digit');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('"change email" in EMAIL_VERIFIED → ask for new email', async () => {
    setupBaseMocks({
      metadata: { fsm: { state: 'EMAIL_VERIFIED', pendingEmail: null, verifiedEmail: 'old@test.com', otpAttempts: 0, otpSentAt: null } },
      email_verified: true,
    });

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { routeChat } = await import('../src/agent/chat-router.js');

    const result = await routeChat('sess-1', mockTenant.id, 'I want to change my email', mockTenant);

    expect(result.deterministic).toBe(true);
    expect(result.fsmContext.state).toBe('EMAIL_REQUESTED');
    expect(result.response).toContain('old@test.com');
    expect(createMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// E. Full flow integration — ANON → booking request → verified
// ============================================================

describe('Full FSM Flow — end-to-end (mocked)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ANON → greeting → book → email → OTP → verified (all deterministic)', async () => {
    // Step 1: Greeting (ANON → SALES_CHAT)
    setupBaseMocks();
    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    let routeChat = (await import('../src/agent/chat-router.js')).routeChat;

    let result = await routeChat('sess-e2e', mockTenant.id, 'Hi!', mockTenant);
    expect(result.deterministic).toBe(true);
    expect(result.fsmContext.state).toBe('SALES_CHAT');

    // Step 2: Book demo (SALES_CHAT → EMAIL_REQUESTED)
    vi.resetModules();
    setupBaseMocks({
      metadata: { fsm: { ...result.fsmContext } },
    });
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    routeChat = (await import('../src/agent/chat-router.js')).routeChat;
    result = await routeChat('sess-e2e', mockTenant.id, 'I want to book a demo', mockTenant);
    expect(result.deterministic).toBe(true);
    expect(result.fsmContext.state).toBe('EMAIL_REQUESTED');
    expect(result.response).toContain('email');

    // Step 3: Provide email (EMAIL_REQUESTED → OTP_SENT)
    vi.resetModules();
    setupBaseMocks({
      metadata: { fsm: { ...result.fsmContext } },
    });
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    routeChat = (await import('../src/agent/chat-router.js')).routeChat;
    result = await routeChat('sess-e2e', mockTenant.id, 'user@demo.com', mockTenant);
    expect(result.deterministic).toBe(true);
    expect(result.fsmContext.state).toBe('OTP_SENT');
    expect(result.response).toContain('user@demo.com');

    // Step 4: Provide OTP (OTP_SENT → EMAIL_VERIFIED)
    vi.resetModules();
    setupBaseMocks({
      metadata: { fsm: { ...result.fsmContext } },
    });
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    routeChat = (await import('../src/agent/chat-router.js')).routeChat;
    result = await routeChat('sess-e2e', mockTenant.id, '123456', mockTenant);
    expect(result.deterministic).toBe(true);
    expect(result.fsmContext.state).toBe('EMAIL_VERIFIED');
    expect(result.fsmContext.verifiedEmail).toBe('user@demo.com');
    expect(result.response).toContain('verified');

    // LLM was NEVER called across all 4 steps
    expect(createMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// F. Datetime resolver fires in EMAIL_VERIFIED state
//    Regression: after OTP verification, "4pm on friday" was NOT
//    resolved because the gating condition only checked BOOKING_FLOW.
// ============================================================

describe('routeChat — datetime resolver fires in EMAIL_VERIFIED state', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('"4pm on friday" in EMAIL_VERIFIED state → resolveDatetime is called', async () => {
    // Session already in EMAIL_VERIFIED state (post-OTP)
    const verifiedSession = makeSession({
      metadata: {
        fsm: {
          state: 'EMAIL_VERIFIED',
          pendingEmail: null,
          verifiedEmail: 'user@demo.com',
          otpAttempts: 1,
          otpSentAt: new Date().toISOString(),
        },
      },
      email_verified: true,
      conversation: [
        { role: 'system', content: 'system prompt', timestamp: new Date().toISOString() },
      ],
    });

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findOrCreate: vi.fn().mockResolvedValue(verifiedSession),
        findById: vi.fn().mockResolvedValue(verifiedSession),
        updateConversation: vi.fn().mockResolvedValue(undefined),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
        markEmailVerified: vi.fn().mockResolvedValue(undefined),
        linkCustomer: vi.fn().mockResolvedValue(undefined),
        isEmailVerified: vi.fn().mockResolvedValue(true),
        getCustomerIdentity: vi.fn().mockResolvedValue(null),
        incrementMessageCount: vi.fn().mockResolvedValue(2),
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
        EMAIL_VERIFICATION_RATE_LIMIT: '5',
        EMAIL_VERIFICATION_TTL_MINUTES: '15',
        REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: 'false',
      },
    }));

    vi.doMock('../src/repos/email-verification.repo.js', () => ({
      emailVerificationRepo: {
        create: vi.fn().mockResolvedValue({ code: '123456' }),
        verify: vi.fn().mockResolvedValue(true),
        countRecent: vi.fn().mockResolvedValue(0),
      },
      validateEmail: vi.fn().mockReturnValue(null),
    }));

    vi.doMock('../src/email/transport.js', () => ({
      sendVerificationEmail: vi.fn().mockResolvedValue({ success: true }),
    }));

    vi.doMock('../src/services/customer.service.js', () => ({
      customerService: {
        resolveByEmail: vi.fn().mockResolvedValue({ customer: { id: 'cust-1' }, created: false }),
        resolveByPhone: vi.fn().mockResolvedValue({ customer: { id: 'cust-1' }, created: false }),
        getReturningContext: vi.fn().mockResolvedValue(null),
      },
    }));

    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    vi.doMock('../src/agent/response-post-processor.js', () => ({
      postProcessResponse: (text: string) => text,
    }));

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));

    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));

    // Spy on resolveDatetime — this is the function under test
    const resolveDatetimeSpy = vi.fn().mockReturnValue({
      start_iso: '2026-02-20T21:00:00.000Z',  // Friday 4pm ET
      end_iso: '2026-02-20T22:00:00.000Z',
      confidence: 'high' as const,
      reasons: ['day=friday', 'time=16:00'],
    });
    vi.doMock('../src/agent/datetime-resolver.js', () => ({
      resolveDatetime: resolveDatetimeSpy,
    }));

    // Mock OpenAI streaming response (PASS_TO_LLM path)
    const { createMockStream } = await import('./helpers/mock-openai-stream.js');
    vi.doMock('openai', () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue(
              createMockStream('Sure! Let me check availability for Friday at 4 PM.'),
            ),
          },
        };
      },
    }));

    const { routeChat } = await import('../src/agent/chat-router.js');

    const result = await routeChat('sess-dt-test', mockTenant.id, '4pm on friday', mockTenant);

    // The message should have gone through LLM (not deterministic)
    expect(result.deterministic).toBe(false);

    // resolveDatetime MUST have been called — this is the regression test
    expect(resolveDatetimeSpy).toHaveBeenCalledTimes(1);
    expect(resolveDatetimeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: '4pm on friday',
        tenantTimezone: 'America/New_York',
      }),
    );
  });

  it('"4pm on friday" in BOOKING_FLOW state → resolveDatetime is also called', async () => {
    // Verify the existing BOOKING_FLOW path still works
    const bookingSession = makeSession({
      metadata: {
        fsm: {
          state: 'BOOKING_FLOW',
          pendingEmail: null,
          verifiedEmail: 'user@demo.com',
          otpAttempts: 1,
          otpSentAt: new Date().toISOString(),
        },
      },
      email_verified: true,
      conversation: [
        { role: 'system', content: 'system prompt', timestamp: new Date().toISOString() },
      ],
    });

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findOrCreate: vi.fn().mockResolvedValue(bookingSession),
        findById: vi.fn().mockResolvedValue(bookingSession),
        updateConversation: vi.fn().mockResolvedValue(undefined),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
        markEmailVerified: vi.fn().mockResolvedValue(undefined),
        linkCustomer: vi.fn().mockResolvedValue(undefined),
        isEmailVerified: vi.fn().mockResolvedValue(true),
        getCustomerIdentity: vi.fn().mockResolvedValue(null),
        incrementMessageCount: vi.fn().mockResolvedValue(3),
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
        EMAIL_VERIFICATION_RATE_LIMIT: '5',
        EMAIL_VERIFICATION_TTL_MINUTES: '15',
        REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: 'false',
      },
    }));

    vi.doMock('../src/repos/email-verification.repo.js', () => ({
      emailVerificationRepo: {
        create: vi.fn().mockResolvedValue({ code: '123456' }),
        verify: vi.fn().mockResolvedValue(true),
        countRecent: vi.fn().mockResolvedValue(0),
      },
      validateEmail: vi.fn().mockReturnValue(null),
    }));

    vi.doMock('../src/email/transport.js', () => ({
      sendVerificationEmail: vi.fn().mockResolvedValue({ success: true }),
    }));

    vi.doMock('../src/services/customer.service.js', () => ({
      customerService: {
        resolveByEmail: vi.fn().mockResolvedValue({ customer: { id: 'cust-1' }, created: false }),
        resolveByPhone: vi.fn().mockResolvedValue({ customer: { id: 'cust-1' }, created: false }),
        getReturningContext: vi.fn().mockResolvedValue(null),
      },
    }));

    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    vi.doMock('../src/agent/response-post-processor.js', () => ({
      postProcessResponse: (text: string) => text,
    }));

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));

    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));

    const resolveDatetimeSpy = vi.fn().mockReturnValue({
      start_iso: '2026-02-20T21:00:00.000Z',
      end_iso: '2026-02-20T22:00:00.000Z',
      confidence: 'high' as const,
      reasons: ['day=friday', 'time=16:00'],
    });
    vi.doMock('../src/agent/datetime-resolver.js', () => ({
      resolveDatetime: resolveDatetimeSpy,
    }));

    const { createMockStream } = await import('./helpers/mock-openai-stream.js');
    vi.doMock('openai', () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue(
              createMockStream('Checking Friday 4 PM availability...'),
            ),
          },
        };
      },
    }));

    const { routeChat } = await import('../src/agent/chat-router.js');

    const result = await routeChat('sess-dt-bf', mockTenant.id, '4pm on friday', mockTenant);

    expect(result.deterministic).toBe(false);
    expect(resolveDatetimeSpy).toHaveBeenCalledTimes(1);
  });
});
