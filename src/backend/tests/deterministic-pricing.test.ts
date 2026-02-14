// ============================================================
// Deterministic Pricing — LLM Bypass Tests
// ============================================================
// Verifies that pricing questions:
//   1. Return real plan data from gomomo-facts (not hallucinated)
//   2. NEVER invoke the LLM (OpenAI mock confirms zero calls)
//   3. Fall back to contact message when pricing_plans is empty
//   4. Work for all pricing trigger phrases (cost, plans, etc.)
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helpers ─────────────────────────────────────────────────

const gomomoTenant = {
  id: 'tenant-gomomo',
  slug: 'gomomo',
  name: 'Gomomo',
  timezone: 'America/New_York',
  business_type: 'platform',
  services: [],
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

function makeSession(conversation: any[] = []) {
  return {
    id: 'sess-pricing',
    tenant_id: gomomoTenant.id,
    customer_id: null,
    channel: 'web' as const,
    conversation,
    metadata: {},
    email_verified: false,
    message_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/** Standard mocks that every test in this file needs. */
function setupBaseMocks() {
  vi.doMock('../src/repos/session.repo.js', () => ({
    sessionRepo: {
      findOrCreate: vi.fn().mockResolvedValue(makeSession()),
      updateConversation: vi.fn().mockResolvedValue(undefined),
      updateMetadata: vi.fn().mockResolvedValue(undefined),
      incrementBookingCount: vi.fn().mockResolvedValue(undefined),
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

  vi.doMock('../src/agent/response-post-processor.js', () => ({
    postProcessResponse: (text: string) => text,
  }));

  vi.doMock('../src/voice/phone-normalizer.js', () => ({
    normalizePhone: (p: string) => p,
  }));

  // Mock faq-repo to avoid DB dependency in router
  vi.doMock('../src/storefront/faq-repo.js', () => ({
    findApprovedAnswer: async () => null,
    logUnansweredFaq: async () => ({}),
  }));
}

// ── 1. Pricing bypasses LLM completely ──────────────────────

describe('Deterministic Pricing — LLM Bypass', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('"what is your pricing?" returns facts values and does NOT call LLM', async () => {
    setupBaseMocks();

    // Mock OpenAI — should NOT be called
    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { handleChatMessage } = await import('../src/agent/chat-handler.js');
    const { GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');

    const { response, meta } = await handleChatMessage(
      'sess-pricing',
      gomomoTenant.id,
      'What is your pricing?',
      gomomoTenant,
    );

    // Response must contain actual plan names from facts
    expect(response).toContain('Free');
    expect(response).toContain('Pro');
    expect(response).toContain('Business');
    expect(response).toContain('Enterprise');

    // Response must contain actual prices from facts
    expect(response).toContain('$0/month');
    expect(response).toContain('$49/month');
    expect(response).toContain('$149/month');

    // Must contain the real contact email, not an invented one
    expect(response).toContain(GOMOMO_FACTS.contact.partners);

    // LLM was NEVER invoked
    expect(createMock).not.toHaveBeenCalled();

    // No tools were used
    expect(meta.tools_used).toEqual([]);
    expect(meta.has_async_job).toBe(false);
  });

  it('"how much does gomomo cost?" returns facts and does NOT call LLM', async () => {
    setupBaseMocks();

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { handleChatMessage } = await import('../src/agent/chat-handler.js');

    const { response } = await handleChatMessage(
      'sess-pricing',
      gomomoTenant.id,
      'How much does Gomomo cost?',
      gomomoTenant,
    );

    expect(response).toContain('Free');
    expect(response).toContain('$49/month');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('"what plans do you have?" returns facts and does NOT call LLM', async () => {
    setupBaseMocks();

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { handleChatMessage } = await import('../src/agent/chat-handler.js');

    const { response } = await handleChatMessage(
      'sess-pricing',
      gomomoTenant.id,
      'What plans do you have?',
      gomomoTenant,
    );

    expect(response).toContain('Free');
    expect(response).toContain('Pro');
    expect(response).toContain('Business');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('"can I buy a subscription?" returns pricing facts and does NOT call LLM', async () => {
    setupBaseMocks();

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { handleChatMessage } = await import('../src/agent/chat-handler.js');

    const { response } = await handleChatMessage(
      'sess-pricing',
      gomomoTenant.id,
      'Can I buy a subscription?',
      gomomoTenant,
    );

    // "buy" and "subscription" are both pricing triggers
    expect(response).toContain('Free');
    expect(response).toContain('$0/month');
    expect(createMock).not.toHaveBeenCalled();
  });
});

// ── 2. Empty pricing_plans fallback ─────────────────────────

describe('Deterministic Pricing — Empty Plans Fallback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns finalize message when pricing_plans is empty', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');

    // Temporarily empty the plans to test the fallback
    const originalPlans = GOMOMO_FACTS.pricing_plans;
    (GOMOMO_FACTS as any).pricing_plans = [];

    try {
      const result = answerFromFacts('What is the pricing?');
      expect(result).not.toBeNull();
      expect(result!.section).toBe('pricing');
      expect(result!.answer).toBe(
        'Pricing is currently being finalized. Please contact hello@gomomo.ai.',
      );
    } finally {
      // Restore original plans so other tests aren't affected
      (GOMOMO_FACTS as any).pricing_plans = originalPlans;
    }
  });

  it('returns finalize message via chat handler when pricing_plans is empty (LLM not called)', async () => {
    setupBaseMocks();

    const createMock = vi.fn();
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    // Override gomomo-facts with empty pricing_plans
    const { GOMOMO_FACTS: realFacts } = await import('../src/storefront/gomomo-facts.js');
    const originalPlans = realFacts.pricing_plans;
    (realFacts as any).pricing_plans = [];

    try {
      const { handleChatMessage } = await import('../src/agent/chat-handler.js');

      const { response } = await handleChatMessage(
        'sess-pricing',
        gomomoTenant.id,
        'What is the pricing?',
        gomomoTenant,
      );

      expect(response).toBe(
        'Pricing is currently being finalized. Please contact hello@gomomo.ai.',
      );
      expect(createMock).not.toHaveBeenCalled();
    } finally {
      (realFacts as any).pricing_plans = originalPlans;
    }
  });
});

// ── 3. Non-gomomo tenants still call LLM ────────────────────

describe('Deterministic Pricing — Non-Gomomo Tenant', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pricing question for non-gomomo tenant DOES call LLM (no storefront bypass)', async () => {
    setupBaseMocks();

    const createMock = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          role: 'assistant',
          content: 'Our pricing varies by service.',
          tool_calls: undefined,
        },
        finish_reason: 'stop',
      }],
    });

    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const otherTenant = { ...gomomoTenant, slug: 'salon-xyz', id: 'tenant-xyz' };
    const { handleChatMessage } = await import('../src/agent/chat-handler.js');

    await handleChatMessage(
      'sess-pricing',
      otherTenant.id,
      'What is your pricing?',
      otherTenant,
    );

    // Non-gomomo tenant → storefront router not activated → LLM IS called
    expect(createMock).toHaveBeenCalled();
  });
});
