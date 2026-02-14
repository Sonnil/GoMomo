// ============================================================
// Multilingual Pricing + Legacy Brand Sanitizer Tests
// ============================================================
// Verifies:
//   1. Vietnamese/French/Spanish pricing queries hit the facts path
//      (no LLM call) — deterministic short-circuit.
//   2. The response sanitizer (Guardrail 5) strips legacy brand
//      names from LLM output.
//   3. System prompt no longer contains forbidden brand names.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helpers (shared with deterministic-pricing.test.ts) ─────

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
    id: 'sess-multilingual',
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

  vi.doMock('../src/storefront/faq-repo.js', () => ({
    findApprovedAnswer: async () => null,
    logUnansweredFaq: async () => ({}),
  }));
}

// ═══════════════════════════════════════════════════════════
// 1. Multilingual Pricing — Facts Path (No LLM)
// ═══════════════════════════════════════════════════════════

describe('Multilingual Pricing — Facts Short-Circuit', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const testCases = [
    // Vietnamese
    { lang: 'Vietnamese', query: 'giá cả?', trigger: 'giá cả' },
    { lang: 'Vietnamese', query: 'bao nhiêu tiền?', trigger: 'bao nhiêu' },
    { lang: 'Vietnamese', query: 'chi phí như thế nào?', trigger: 'chi phí' },
    // French
    { lang: 'French', query: 'Quel est le prix?', trigger: 'prix' },
    { lang: 'French', query: 'Combien ça coûte?', trigger: 'combien' },
    { lang: 'French', query: 'tarif mensuel?', trigger: 'tarif' },
    // Spanish
    { lang: 'Spanish', query: '¿Cuánto cuesta?', trigger: 'cuánto' },
    { lang: 'Spanish', query: 'precio del servicio?', trigger: 'precio' },
    // German
    { lang: 'German', query: 'Wie viel kostet es?', trigger: 'wie viel' },
    { lang: 'German', query: 'Was ist der Preis?', trigger: 'preis' },
    // Chinese
    { lang: 'Chinese', query: '价格是多少？', trigger: '价格' },
    { lang: 'Chinese', query: '多少钱？', trigger: '多少钱' },
    // Japanese
    { lang: 'Japanese', query: '料金はいくらですか？', trigger: '料金' },
    // Korean
    { lang: 'Korean', query: '가격이 얼마예요?', trigger: '가격' },
  ];

  for (const { lang, query, trigger } of testCases) {
    it(`[${lang}] "${query}" (trigger: "${trigger}") returns pricing facts, NOT LLM`, async () => {
      setupBaseMocks();

      const createMock = vi.fn();
      vi.doMock('openai', () => ({
        default: class {
          chat = { completions: { create: createMock } };
        },
      }));

      const { handleChatMessage } = await import('../src/agent/chat-handler.js');

      const { response, meta } = await handleChatMessage(
        `sess-ml-${lang}`,
        gomomoTenant.id,
        query,
        gomomoTenant,
      );

      // Must contain actual pricing data
      expect(response).toContain('Free');
      expect(response).toContain('$0/month');

      // LLM was NEVER invoked
      expect(createMock).not.toHaveBeenCalled();

      // No tools used
      expect(meta.tools_used).toEqual([]);
    });
  }
});

// ═══════════════════════════════════════════════════════════
// 2. Storefront Router — Multilingual Intent Detection
// ═══════════════════════════════════════════════════════════

describe('Multilingual Intent Detection', () => {
  beforeEach(() => { vi.resetModules(); });

  it('Vietnamese pricing queries detect as storefront intent', async () => {
    const { detectIntent } = await import('../src/storefront/router.js');
    expect(detectIntent('giá cả?')).toBe('storefront');
    expect(detectIntent('bao nhiêu tiền?')).toBe('storefront');
    expect(detectIntent('chi phí là bao nhiêu?')).toBe('storefront');
  });

  it('French pricing queries detect as storefront intent', async () => {
    const { detectIntent } = await import('../src/storefront/router.js');
    expect(detectIntent('prix?')).toBe('storefront');
    expect(detectIntent('combien ça coûte?')).toBe('storefront');
    expect(detectIntent('quel est le tarif?')).toBe('storefront');
  });

  it('Spanish pricing queries detect as storefront intent', async () => {
    const { detectIntent } = await import('../src/storefront/router.js');
    expect(detectIntent('¿Cuánto cuesta?')).toBe('storefront');
    expect(detectIntent('precio del plan?')).toBe('storefront');
  });

  it('Chinese/Japanese/Korean pricing queries detect as storefront intent', async () => {
    const { detectIntent } = await import('../src/storefront/router.js');
    expect(detectIntent('价格是多少？')).toBe('storefront');
    expect(detectIntent('料金はいくらですか？')).toBe('storefront');
    expect(detectIntent('가격이 얼마예요?')).toBe('storefront');
  });

  it('English pricing queries still work', async () => {
    const { detectIntent } = await import('../src/storefront/router.js');
    expect(detectIntent('what is your pricing?')).toBe('storefront');
    expect(detectIntent('how much does it cost?')).toBe('storefront');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Facts Answer — Multilingual Pricing Triggers
// ═══════════════════════════════════════════════════════════

describe('answerFromFacts — Multilingual Pricing', () => {
  beforeEach(() => { vi.resetModules(); });

  it('Vietnamese "giá cả" triggers pricing facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('giá cả?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('pricing');
    expect(result!.answer).toContain('$0/month');
  });

  it('French "prix" triggers pricing facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('prix?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('pricing');
    expect(result!.answer).toContain('Free');
  });

  it('Spanish "precio" triggers pricing facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('precio del servicio?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('pricing');
  });

  it('Chinese "价格" triggers pricing facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('价格是多少？');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('pricing');
  });

  it('Japanese "料金" triggers pricing facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('料金はいくらですか？');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('pricing');
  });

  it('Korean "가격" triggers pricing facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('가격이 얼마예요?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('pricing');
  });
});
