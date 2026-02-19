// ============================================================
// Verified Identity Context — No Re-Ask Tests
//
// After the email gate verifies a user's email, the agent
// must NOT re-ask for the email during the booking flow.
// When phone or name are on file, the agent must not re-ask those either.
//
// Verifies:
//  1. buildVerifiedEmailSection — returns empty for null/undefined (legacy compat)
//  2. buildVerifiedEmailSection — returns instruction block with email (legacy compat)
//  3. buildIdentityContextSection — returns empty when no identity fields present
//  4. buildIdentityContextSection — email only → marker + email instructions
//  5. buildIdentityContextSection — email + phone → no re-ask for either
//  6. buildIdentityContextSection — email + phone + name → nothing missing
//  7. buildIdentityContextSection — email only → still need name + phone
//  8. buildIdentityContextSection — falls back to bare verifiedEmail when no identity
//  9. buildSystemPrompt — includes identity section when customerIdentity provided
// 10. buildSystemPrompt — includes identity section via verifiedEmail fallback
// 11. buildSystemPrompt — excludes identity section when nothing provided
// 12. buildSystemPrompt — both returning-customer AND identity sections
// 13. chat-handler — injects mid-conversation system msg for customerIdentity
// 14. chat-handler — does NOT duplicate system msg on subsequent messages
// 15. chat-handler — passes customerIdentity into initial system prompt
// 16. chat-handler — deduplicates against legacy VERIFIED EMAIL marker
// 17. sessionRepo.getVerifiedEmail — returns email for verified session
// 18. sessionRepo.getVerifiedEmail — returns null for unverified session
// 19. sessionRepo.getCustomerIdentity — returns full identity for verified session
// 20. sessionRepo.getCustomerIdentity — returns null for unverified session
// 21. sessionRepo.getCustomerIdentity — returns identity with null fields
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Shared mock tenant ────────────────────────────────────

const mockTenant = {
  id: '00000000-0000-4000-a000-000000000001',
  name: 'Test Clinic',
  slug: 'test-clinic',
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
  services: [{ name: 'Consultation', duration: 30, description: 'General consultation' }],
  created_at: new Date(),
  updated_at: new Date(),
};

// ── 1–2. buildVerifiedEmailSection ────────────────────────

describe('buildVerifiedEmailSection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns empty string when verifiedEmail is null', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    const { buildVerifiedEmailSection } = await import('../src/agent/system-prompt.js');
    expect(buildVerifiedEmailSection(null)).toBe('');
  });

  it('returns empty string when verifiedEmail is undefined', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    const { buildVerifiedEmailSection } = await import('../src/agent/system-prompt.js');
    expect(buildVerifiedEmailSection(undefined)).toBe('');
    expect(buildVerifiedEmailSection()).toBe('');
  });

  it('returns instruction block containing the verified email', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    const { buildVerifiedEmailSection } = await import('../src/agent/system-prompt.js');
    const section = buildVerifiedEmailSection('jane@example.com');

    expect(section).toContain('VERIFIED EMAIL (EMAIL GATE)');
    expect(section).toContain('jane@example.com');
    expect(section).toContain('Do NOT ask for their email address');
    expect(section).toContain('confirm_booking');
    expect(section).toContain('full name');
    expect(section).toContain('phone number');
  });
});

// ── 3–4. buildSystemPrompt with verifiedEmail ─────────────

describe('buildSystemPrompt — verified email', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('includes VERIFIED IDENTITY CONTEXT section when customerIdentity is provided', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any, {
      customerIdentity: { verifiedEmail: 'verified@test.com', displayName: null, phone: null },
    });

    expect(prompt).toContain('VERIFIED IDENTITY CONTEXT');
    expect(prompt).toContain('verified@test.com');
    expect(prompt).toContain('Do NOT ask for their email address');
  });

  it('includes VERIFIED IDENTITY CONTEXT section via verifiedEmail fallback', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any, {
      verifiedEmail: 'fallback@test.com',
    });

    expect(prompt).toContain('VERIFIED IDENTITY CONTEXT');
    expect(prompt).toContain('fallback@test.com');
    expect(prompt).toContain('Do NOT ask for their email address');
  });

  it('excludes VERIFIED IDENTITY CONTEXT section when verifiedEmail is null', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any, {
      verifiedEmail: null,
    });

    expect(prompt).not.toContain('VERIFIED IDENTITY CONTEXT');
  });

  it('excludes VERIFIED IDENTITY CONTEXT section when no options provided', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any);

    expect(prompt).not.toContain('VERIFIED IDENTITY CONTEXT');
  });

  it('includes both returning-customer AND identity sections when both present', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any, {
      customerIdentity: { verifiedEmail: 'combo@test.com', displayName: 'Jane', phone: '+15551234567' },
      returningCustomer: {
        customer_id: 'cust-1',
        display_name: 'Jane',
        booking_count: 2,
        preferences: {},
        previous_sessions: 3,
      },
    });

    expect(prompt).toContain('RETURNING CUSTOMER');
    expect(prompt).toContain('Jane');
    expect(prompt).toContain('VERIFIED IDENTITY CONTEXT');
    expect(prompt).toContain('combo@test.com');
    expect(prompt).toContain('+15551234567');
  });
});

// ── 5–7. Chat handler — mid-conversation injection ───────

describe('handleChatMessage — verified identity injection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const sessionWithConversation = (conversation: any[]) => ({
    id: 'sess-1',
    tenant_id: mockTenant.id,
    customer_id: null,
    channel: 'web' as const,
    conversation,
    metadata: {},
    email_verified: true,
    message_count: 2,
    created_at: new Date(),
    updated_at: new Date(),
  });

  it('injects mid-conversation system message when customerIdentity provided and conversation exists', async () => {
    const existingConvo = [
      { role: 'system', content: 'You are a professional agent...', timestamp: new Date().toISOString() },
      { role: 'user', content: 'Hi, I want to book', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Sure! What service would you like?', timestamp: new Date().toISOString() },
    ];

    // Track what gets saved
    let savedConversation: any[] = [];

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findOrCreate: vi.fn().mockResolvedValue(sessionWithConversation(existingConvo)),
        updateConversation: vi.fn().mockImplementation((_id: string, convo: any[]) => {
          savedConversation = convo;
          return Promise.resolve();
        }),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: undefined,
        CALENDAR_DEBUG: 'false',
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));

    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    // Mock OpenAI to return a simple response
    vi.doMock('openai', () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{
                message: { role: 'assistant', content: 'Great, I have your email. What is your name?', tool_calls: undefined },
                finish_reason: 'stop',
              }],
            }),
          },
        };
      },
    }));

    vi.doMock('../src/agent/response-post-processor.js', () => ({
      postProcessResponse: (text: string) => text,
    }));

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));

    const { handleChatMessage } = await import('../src/agent/chat-handler.js');

    await handleChatMessage('sess-1', mockTenant.id, 'I want to book a consultation', mockTenant as any, {
      customerIdentity: { verifiedEmail: 'verified@test.com', displayName: null, phone: null },
    });

    // The saved conversation should contain a mid-conversation system message with new marker
    const systemMsgs = savedConversation.filter(
      (m: any) => m.role === 'system' && m.content.includes('VERIFIED IDENTITY CONTEXT'),
    );
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('verified@test.com');
    expect(systemMsgs[0].content).toContain('Do NOT ask for their email address');
  });

  it('does NOT duplicate identity system message on subsequent calls', async () => {
    const existingConvo = [
      { role: 'system', content: 'You are a professional agent...', timestamp: new Date().toISOString() },
      { role: 'user', content: 'Hi', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Hello!', timestamp: new Date().toISOString() },
      // Already injected from previous call
      { role: 'system', content: 'VERIFIED IDENTITY CONTEXT:\nThe user\'s verified email address is: verified@test.com', timestamp: new Date().toISOString() },
      { role: 'user', content: 'I need a consultation', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Sure thing!', timestamp: new Date().toISOString() },
    ];

    let savedConversation: any[] = [];

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findOrCreate: vi.fn().mockResolvedValue(sessionWithConversation(existingConvo)),
        updateConversation: vi.fn().mockImplementation((_id: string, convo: any[]) => {
          savedConversation = convo;
          return Promise.resolve();
        }),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: undefined,
        CALENDAR_DEBUG: 'false',
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));

    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    vi.doMock('openai', () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{
                message: { role: 'assistant', content: 'Let me check availability.', tool_calls: undefined },
                finish_reason: 'stop',
              }],
            }),
          },
        };
      },
    }));

    vi.doMock('../src/agent/response-post-processor.js', () => ({
      postProcessResponse: (text: string) => text,
    }));

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));

    const { handleChatMessage } = await import('../src/agent/chat-handler.js');

    await handleChatMessage('sess-1', mockTenant.id, 'What times are available?', mockTenant as any, {
      customerIdentity: { verifiedEmail: 'verified@test.com', displayName: null, phone: null },
    });

    // Should still have exactly ONE identity system message (the existing one)
    const systemMsgs = savedConversation.filter(
      (m: any) => m.role === 'system' && m.content.includes('VERIFIED IDENTITY CONTEXT'),
    );
    expect(systemMsgs).toHaveLength(1);
  });

  it('deduplicates against legacy VERIFIED EMAIL (EMAIL GATE) marker', async () => {
    const existingConvo = [
      { role: 'system', content: 'You are a professional agent...', timestamp: new Date().toISOString() },
      { role: 'user', content: 'Hi', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Hello!', timestamp: new Date().toISOString() },
      // Legacy marker from a previous version
      { role: 'system', content: 'VERIFIED EMAIL (EMAIL GATE):\nThe user\'s email address is: verified@test.com', timestamp: new Date().toISOString() },
      { role: 'user', content: 'I need a consultation', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Sure thing!', timestamp: new Date().toISOString() },
    ];

    let savedConversation: any[] = [];

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findOrCreate: vi.fn().mockResolvedValue(sessionWithConversation(existingConvo)),
        updateConversation: vi.fn().mockImplementation((_id: string, convo: any[]) => {
          savedConversation = convo;
          return Promise.resolve();
        }),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: undefined,
        CALENDAR_DEBUG: 'false',
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));

    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    vi.doMock('openai', () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{
                message: { role: 'assistant', content: 'Let me check.', tool_calls: undefined },
                finish_reason: 'stop',
              }],
            }),
          },
        };
      },
    }));

    vi.doMock('../src/agent/response-post-processor.js', () => ({
      postProcessResponse: (text: string) => text,
    }));

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));

    const { handleChatMessage } = await import('../src/agent/chat-handler.js');

    await handleChatMessage('sess-1', mockTenant.id, 'Check times', mockTenant as any, {
      customerIdentity: { verifiedEmail: 'verified@test.com', displayName: null, phone: null },
    });

    // Should NOT inject a new VERIFIED IDENTITY CONTEXT because legacy marker exists
    const identityMsgs = savedConversation.filter(
      (m: any) => m.role === 'system' && m.content.includes('VERIFIED IDENTITY CONTEXT'),
    );
    expect(identityMsgs).toHaveLength(0);

    // Legacy marker should still be there
    const legacyMsgs = savedConversation.filter(
      (m: any) => m.role === 'system' && m.content.includes('VERIFIED EMAIL (EMAIL GATE)'),
    );
    expect(legacyMsgs).toHaveLength(1);
  });

  it('includes customerIdentity in initial system prompt when conversation is new', async () => {
    let savedConversation: any[] = [];

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findOrCreate: vi.fn().mockResolvedValue(sessionWithConversation([])), // empty conversation
        updateConversation: vi.fn().mockImplementation((_id: string, convo: any[]) => {
          savedConversation = convo;
          return Promise.resolve();
        }),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: undefined,
        CALENDAR_DEBUG: 'false',
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 3,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));

    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    vi.doMock('openai', () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{
                message: { role: 'assistant', content: 'Welcome! How can I help?', tool_calls: undefined },
                finish_reason: 'stop',
              }],
            }),
          },
        };
      },
    }));

    vi.doMock('../src/agent/response-post-processor.js', () => ({
      postProcessResponse: (text: string) => text,
    }));

    vi.doMock('../src/voice/phone-normalizer.js', () => ({
      normalizePhone: (p: string) => p,
    }));

    const { handleChatMessage } = await import('../src/agent/chat-handler.js');

    await handleChatMessage('sess-1', mockTenant.id, 'Hello', mockTenant as any, {
      customerIdentity: { verifiedEmail: 'gate-verified@test.com', displayName: 'Jane Doe', phone: '+15551234567' },
    });

    // The initial system prompt should contain the identity context section
    const systemPrompt = savedConversation.find((m: any) => m.role === 'system');
    expect(systemPrompt).toBeDefined();
    expect(systemPrompt.content).toContain('VERIFIED IDENTITY CONTEXT');
    expect(systemPrompt.content).toContain('gate-verified@test.com');
    expect(systemPrompt.content).toContain('+15551234567');
    expect(systemPrompt.content).toContain('Jane Doe');
    // Should NOT have a separate mid-conversation system message (it's in the main prompt)
    const allSystemMsgs = savedConversation.filter((m: any) => m.role === 'system');
    expect(allSystemMsgs).toHaveLength(1);
  });
});

// ── 8–9. sessionRepo.getVerifiedEmail ────────────────────
// These tests verify the SQL query shape and return values by mocking the
// database layer directly. We import the module fresh each time to avoid
// pollution from the chat-handler mock above.

describe('sessionRepo.getVerifiedEmail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    // Clear any lingering doMock for the session repo module
    vi.doUnmock('../src/repos/session.repo.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns email when session is verified and has linked customer', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({
        rows: [{ email: 'linked@customer.com' }],
      }),
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const email = await sessionRepo.getVerifiedEmail('sess-verified');

    expect(email).toBe('linked@customer.com');
  });

  it('returns null when session is not verified', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({
        rows: [],
      }),
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const email = await sessionRepo.getVerifiedEmail('sess-unverified');

    expect(email).toBeNull();
  });

  it('returns null when session has no linked customer', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({
        rows: [],
      }),
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const email = await sessionRepo.getVerifiedEmail('sess-no-customer');

    expect(email).toBeNull();
  });

  it('returns null when customer has null email', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({
        rows: [{ email: null }],
      }),
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const email = await sessionRepo.getVerifiedEmail('sess-null-email');

    expect(email).toBeNull();
  });
});

// ── 10–12. sessionRepo.getCustomerIdentity ────────────────

describe('sessionRepo.getCustomerIdentity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/repos/session.repo.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns full identity when session is verified and has linked customer', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({
        rows: [{ email: 'jane@example.com', display_name: 'Jane Doe', phone: '+15551234567' }],
      }),
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const identity = await sessionRepo.getCustomerIdentity('sess-verified');

    expect(identity).toEqual({
      verifiedEmail: 'jane@example.com',
      displayName: 'Jane Doe',
      phone: '+15551234567',
    });
  });

  it('returns null when session is not verified', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({
        rows: [],
      }),
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const identity = await sessionRepo.getCustomerIdentity('sess-unverified');

    expect(identity).toBeNull();
  });

  it('returns identity with null fields when customer has partial data', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({
        rows: [{ email: 'partial@example.com', display_name: null, phone: null }],
      }),
    }));

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const identity = await sessionRepo.getCustomerIdentity('sess-partial');

    expect(identity).toEqual({
      verifiedEmail: 'partial@example.com',
      displayName: null,
      phone: null,
    });
  });
});

// ── 13–18. buildIdentityContextSection ────────────────────

describe('buildIdentityContextSection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns empty string when no identity fields present', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    const { buildIdentityContextSection } = await import('../src/agent/system-prompt.js');
    expect(buildIdentityContextSection(null)).toBe('');
    expect(buildIdentityContextSection(undefined)).toBe('');
    expect(buildIdentityContextSection({ verifiedEmail: null, displayName: null, phone: null })).toBe('');
  });

  it('returns identity section with email only — still needs name + phone', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    const { buildIdentityContextSection } = await import('../src/agent/system-prompt.js');
    const section = buildIdentityContextSection({ verifiedEmail: 'jane@example.com', displayName: null, phone: null });

    expect(section).toContain('VERIFIED IDENTITY CONTEXT');
    expect(section).toContain('jane@example.com');
    expect(section).toContain('Do NOT ask for their email address');
    expect(section).toContain('full name');
    expect(section).toContain('phone number');
    expect(section).not.toContain('Do NOT ask for their phone number');
    expect(section).not.toContain('Do NOT ask for their name');
  });

  it('returns identity section with email + phone — still needs name', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    const { buildIdentityContextSection } = await import('../src/agent/system-prompt.js');
    const section = buildIdentityContextSection({
      verifiedEmail: 'jane@example.com',
      displayName: null,
      phone: '+15551234567',
    });

    expect(section).toContain('VERIFIED IDENTITY CONTEXT');
    expect(section).toContain('jane@example.com');
    expect(section).toContain('+15551234567');
    expect(section).toContain('Do NOT ask for their email address');
    expect(section).toContain('Do NOT ask for their phone number');
    expect(section).toContain('full name');
    expect(section).not.toContain('Do NOT ask for their name');
  });

  it('returns identity section with all three fields — nothing missing', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    const { buildIdentityContextSection } = await import('../src/agent/system-prompt.js');
    const section = buildIdentityContextSection({
      verifiedEmail: 'jane@example.com',
      displayName: 'Jane Doe',
      phone: '+15551234567',
    });

    expect(section).toContain('VERIFIED IDENTITY CONTEXT');
    expect(section).toContain('jane@example.com');
    expect(section).toContain('+15551234567');
    expect(section).toContain('Jane Doe');
    expect(section).toContain('Do NOT ask for their email address');
    expect(section).toContain('Do NOT ask for their phone number');
    expect(section).toContain('Do NOT ask for their name');
    expect(section).not.toContain('You still need to collect');
  });

  it('falls back to bare verifiedEmail when no identity object', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    const { buildIdentityContextSection } = await import('../src/agent/system-prompt.js');
    const section = buildIdentityContextSection(null, 'fallback@test.com');

    expect(section).toContain('VERIFIED IDENTITY CONTEXT');
    expect(section).toContain('fallback@test.com');
    expect(section).toContain('Do NOT ask for their email address');
    expect(section).toContain('full name');
    expect(section).toContain('phone number');
  });

  it('uses confirm_booking instructions for email and phone', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    const { buildIdentityContextSection } = await import('../src/agent/system-prompt.js');
    const section = buildIdentityContextSection({
      verifiedEmail: 'jane@example.com',
      displayName: 'Jane',
      phone: '+15559990000',
    });

    expect(section).toContain('confirm_booking');
    expect(section).toContain('client_email');
    expect(section).toContain('client_phone');
    expect(section).toContain('client_name');
  });
});
