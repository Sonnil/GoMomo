// ============================================================
// Storefront Knowledge System — Tests
// ============================================================
// Covers:
//   1. Facts endpoint shape (incl. mission/vision/partnership/sales_cta)
//   2. Facts-based answers (no LLM)
//   3. Router: storefront vs booking intent detection
//   4. Router: "what is gomomo" answered without booking flow
//   5. Router: "pricing" uses facts and does not hallucinate
//   6. Retrieval engine (BM25) returns relevant passages
//   7. Unanswered FAQ logging
//   8. Admin propose stores a draft
//   9. Approved FAQ returns deterministically
//  10. Storefront context prompt injection
//  11. Booking intent bypasses storefront router
//  12. answerFromFacts returns null for booking questions
//  13. Mission / vision / positioning answers from facts
//  14. Partnership & sales answers from facts with CTA
//  15. Investor inquiry answered from facts
//  16. Sales CTA / demo booking intent routed correctly
//  17. Context prompt builder includes CTA for partnership sections
//  18. No wellness/clinic language in any fact or answer

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── 1. Facts file shape ─────────────────────────────────────

describe('Storefront Knowledge — Facts', () => {
  it('GOMOMO_FACTS has required shape', async () => {
    const { GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');

    expect(GOMOMO_FACTS.brand_name).toBe('Gomomo');
    expect(GOMOMO_FACTS.tagline).toBeTruthy();
    expect(GOMOMO_FACTS.short_description).toBeTruthy();
    expect(GOMOMO_FACTS.long_description).toBeTruthy();
    expect(GOMOMO_FACTS.last_updated).toBeTruthy();

    // Mission / vision / positioning (Phase 10)
    expect(GOMOMO_FACTS.mission).toBeTruthy();
    expect(GOMOMO_FACTS.mission.length).toBeGreaterThan(20);
    expect(GOMOMO_FACTS.vision).toBeTruthy();
    expect(GOMOMO_FACTS.vision).toContain('robot receptionist');
    expect(GOMOMO_FACTS.positioning).toBeTruthy();
    expect(GOMOMO_FACTS.positioning).toContain('SMB');

    // Primary outcomes (Phase 10)
    expect(GOMOMO_FACTS.primary_outcomes).toBeInstanceOf(Array);
    expect(GOMOMO_FACTS.primary_outcomes.length).toBeGreaterThanOrEqual(4);

    // Contact
    expect(GOMOMO_FACTS.contact.general).toMatch(/@gomomo\.ai$/);
    expect(GOMOMO_FACTS.contact.partners).toMatch(/@gomomo\.ai$/);
    expect(GOMOMO_FACTS.contact.legal).toMatch(/@gomomo\.ai$/);
    expect(GOMOMO_FACTS.contact.privacy).toMatch(/@gomomo\.ai$/);
    expect(GOMOMO_FACTS.contact.support).toMatch(/@gomomo\.ai$/);
    expect(GOMOMO_FACTS.contact.sales).toMatch(/@gomomo\.ai$/);

    // Pricing
    expect(GOMOMO_FACTS.pricing_plans.length).toBeGreaterThanOrEqual(3);
    for (const plan of GOMOMO_FACTS.pricing_plans) {
      expect(plan.name).toBeTruthy();
      expect(plan.price).toBeTruthy();
      expect(plan.channels.length).toBeGreaterThan(0);
    }

    // Channels
    expect(GOMOMO_FACTS.supported_channels.web_chat.enabled).toBe(true);
    expect(GOMOMO_FACTS.supported_channels.sms.enabled).toBe(true);
    expect(GOMOMO_FACTS.supported_channels.voice.enabled).toBe(true);

    // Links
    expect(GOMOMO_FACTS.key_links.length).toBeGreaterThanOrEqual(4);
    const urls = GOMOMO_FACTS.key_links.map((l) => l.url);
    expect(urls).toContain('https://gomomo.ai');
    expect(urls).toContain('https://gomomo.ai/privacy');
    expect(urls).toContain('https://gomomo.ai/terms');

    // Partnership channels (Phase 10)
    expect(GOMOMO_FACTS.partnership_channels).toBeInstanceOf(Array);
    expect(GOMOMO_FACTS.partnership_channels.length).toBeGreaterThanOrEqual(4);
    const partnerTypes = GOMOMO_FACTS.partnership_channels.map((c) => c.type);
    expect(partnerTypes).toContain('advertising');
    expect(partnerTypes).toContain('b2b_partnerships');
    expect(partnerTypes).toContain('integrations');
    expect(partnerTypes).toContain('investors');
    for (const ch of GOMOMO_FACTS.partnership_channels) {
      expect(ch.contact_email).toMatch(/@gomomo\.ai$/);
      expect(ch.suggested_subject.length).toBeGreaterThan(5);
      expect(ch.pitch.length).toBeGreaterThan(10);
    }

    // Sales CTA (Phase 10)
    expect(GOMOMO_FACTS.sales_cta).toBeTruthy();
    expect(GOMOMO_FACTS.sales_cta.calendar_demo_service_name).toBeTruthy();
    expect(GOMOMO_FACTS.sales_cta.default_duration_minutes).toBeGreaterThanOrEqual(15);
    expect(GOMOMO_FACTS.sales_cta.sales_email).toMatch(/@gomomo\.ai$/);
  });

  it('last_updated is a valid ISO string', async () => {
    const { GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const parsed = new Date(GOMOMO_FACTS.last_updated);
    expect(parsed.toISOString()).toBeTruthy();
    expect(isNaN(parsed.getTime())).toBe(false);
  });
});

// ── 2. Facts-based answers ──────────────────────────────────

describe('Storefront Knowledge — answerFromFacts', () => {
  it('answers "what is gomomo" from facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('What is Gomomo?');
    expect(result).not.toBeNull();
    expect(result!.source).toBe('facts');
    expect(result!.section).toBe('brand');
    expect(result!.answer).toContain('AI receptionist platform');
    expect(result!.answer).toContain('gomomo.ai');
  });

  it('answers pricing questions from facts with real plan data', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('How much does it cost?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('pricing');
    // Must contain at least one actual plan name — no hallucinated prices
    expect(result!.answer).toContain('Free');
    expect(result!.answer).toContain('Pro');
    expect(result!.answer).toContain(GOMOMO_FACTS.contact.partners);
  });

  it('answers contact questions from facts', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('How can I contact Gomomo?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('contact');
    expect(result!.answer).toContain(GOMOMO_FACTS.contact.general);
    expect(result!.answer).toContain(GOMOMO_FACTS.contact.support);
  });

  it('answers "how to buy" from facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('How do I buy Gomomo?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('pricing');
    expect(result!.answer).toContain('gomomo.ai');
  });

  it('answers features questions from facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('What features does Gomomo have?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('features');
  });

  it('returns null for booking questions (no match)', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    expect(answerFromFacts('I want to book an appointment for Tuesday')).toBeNull();
    expect(answerFromFacts('Can you reschedule my booking?')).toBeNull();
    expect(answerFromFacts('Cancel my appointment please')).toBeNull();
  });

  it('returns null for unrelated gibberish', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    expect(answerFromFacts('asdfghjkl qwerty')).toBeNull();
  });

  // ── Phase 10: Mission / Vision / Positioning / Outcomes ───

  it('answers "what is your mission" from facts', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('What is your mission?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('mission');
    expect(result!.answer).toContain(GOMOMO_FACTS.mission);
    expect(result!.answer).toContain('book a call');
  });

  it('answers "what problem do you solve" from facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('What problem do you solve?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('mission');
    expect(result!.answer).toContain('24/7');
  });

  it('answers vision questions from facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('What is your vision for the future?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('vision');
    expect(result!.answer).toContain('robot receptionist');
  });

  it('answers positioning / who is it for from facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('Who is Gomomo for? Is it for small businesses?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('positioning');
    expect(result!.answer).toContain('SMB');
  });

  it('answers outcomes/benefits questions from facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('What are the benefits of using Gomomo?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('outcomes');
    expect(result!.answer).toContain('10+ hours');
  });

  // ── Phase 10: Partnership & Sales ─────────────────────────

  it('answers advertising partnership questions from facts', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('I want to advertise with you');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('partnership_advertising');
    const adCh = GOMOMO_FACTS.partnership_channels.find((c) => c.type === 'advertising')!;
    expect(result!.answer).toContain(adCh.contact_email);
    expect(result!.answer).toContain('book a call');
  });

  it('answers general partnership questions from facts', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('I want to partner with Gomomo');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('partnership_b2b');
    expect(result!.answer).toContain(GOMOMO_FACTS.contact.partners);
    expect(result!.answer).toContain(GOMOMO_FACTS.sales_cta.calendar_demo_service_name);
  });

  it('answers integration questions from facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('I want to integrate Gomomo into my website');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('partnership_integrations');
    expect(result!.answer).toContain('Google Calendar');
    expect(result!.answer).toContain('book a call');
  });

  it('answers investor inquiries from facts', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts("I'm interested in investing in Gomomo");
    expect(result).not.toBeNull();
    expect(result!.section).toBe('partnership_investors');
    const invCh = GOMOMO_FACTS.partnership_channels.find((c) => c.type === 'investors')!;
    expect(result!.answer).toContain(invCh.contact_email);
    expect(result!.answer).toContain(invCh.suggested_subject);
  });

  it('answers "book a call" / demo CTA from facts', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('Can I book a call with your team?');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('sales_cta');
    expect(result!.answer).toContain(GOMOMO_FACTS.sales_cta.calendar_demo_service_name);
    expect(result!.answer).toContain(`${GOMOMO_FACTS.sales_cta.default_duration_minutes}`);
    expect(result!.answer).toContain(GOMOMO_FACTS.sales_cta.sales_email);
  });

  it('answers "talk to sales" from facts', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('I want to talk to sales');
    expect(result).not.toBeNull();
    expect(result!.section).toBe('sales_cta');
  });
});

// ── 3. Intent detection ─────────────────────────────────────

describe('Storefront Knowledge — Intent Detection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects booking intents', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { detectIntent } = await import('../src/storefront/router.js');
    expect(detectIntent('I want to book an appointment')).toBe('booking');
    expect(detectIntent('Can I reschedule my booking?')).toBe('booking');
    expect(detectIntent('Cancel my appointment')).toBe('booking');
    expect(detectIntent('What times are available?')).toBe('booking');
  });

  it('detects storefront intents', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { detectIntent } = await import('../src/storefront/router.js');
    expect(detectIntent('What is Gomomo?')).toBe('storefront');
    expect(detectIntent('How much does it cost?')).toBe('storefront');
    expect(detectIntent('Tell me about your features')).toBe('storefront');
    expect(detectIntent('Where can I find the privacy policy?')).toBe('storefront');
  });

  it('detects partnership / sales intents as storefront', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { detectIntent } = await import('../src/storefront/router.js');
    expect(detectIntent('I want to partner with you')).toBe('storefront');
    expect(detectIntent('I want to advertise with Gomomo')).toBe('storefront');
    expect(detectIntent("I'm interested in investing")).toBe('storefront');
    expect(detectIntent('Can I book a call with your team?')).toBe('storefront');
    expect(detectIntent('I want to talk to sales')).toBe('storefront');
    expect(detectIntent('Can I get a demo?')).toBe('storefront');
    expect(detectIntent('What is your mission?')).toBe('storefront');
    expect(detectIntent('I want to integrate Gomomo')).toBe('storefront');
  });

  it('returns ambiguous for unclear messages', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { detectIntent } = await import('../src/storefront/router.js');
    expect(detectIntent('Hello')).toBe('ambiguous');
    expect(detectIntent('Thanks!')).toBe('ambiguous');
  });
});

// ── 4. Retrieval engine ─────────────────────────────────────

describe('Storefront Knowledge — Retrieval', () => {
  beforeEach(async () => {
    const { resetCorpusCache } = await import('../src/storefront/retrieval.js');
    resetCorpusCache();
  });

  it('loads corpus documents from the corpus directory', async () => {
    const { loadCorpus } = await import('../src/storefront/retrieval.js');
    const corpus = loadCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(8); // 5 original + 4 new
    const sources = corpus.map((d) => d.source);
    expect(sources).toContain('homepage.md');
    expect(sources).toContain('privacy.md');
    expect(sources).toContain('terms.md');
    expect(sources).toContain('data-deletion.md');
    // Phase 10 additions
    expect(sources).toContain('mission.md');
    expect(sources).toContain('partnerships.md');
    expect(sources).toContain('pricing.md');
    expect(sources).toContain('outcomes.md');
  });

  it('retrieves relevant passages for "data deletion"', async () => {
    const { retrieveStorefrontContext } = await import('../src/storefront/retrieval.js');
    const result = retrieveStorefrontContext('How do I delete my data?');
    expect(result.results.length).toBeGreaterThan(0);
    // Should find passages from data-deletion.md or privacy.md
    const sources = result.results.map((r) => r.source);
    expect(sources.some((s) => s === 'data-deletion.md' || s === 'privacy.md')).toBe(true);
  });

  it('retrieves relevant passages for "Google Calendar"', async () => {
    const { retrieveStorefrontContext } = await import('../src/storefront/retrieval.js');
    const result = retrieveStorefrontContext('Does Gomomo integrate with Google Calendar?');
    expect(result.results.length).toBeGreaterThan(0);
    // Should find passages mentioning Google Calendar
    const allText = result.results.map((r) => r.passage).join(' ').toLowerCase();
    expect(allText).toContain('google calendar');
  });

  it('returns empty results for completely irrelevant queries', async () => {
    const { retrieveStorefrontContext } = await import('../src/storefront/retrieval.js');
    const result = retrieveStorefrontContext('quantum entanglement in black holes');
    // Should have no confident results
    const confident = result.results.filter((r) => r.score > 2.0);
    expect(confident.length).toBe(0);
  });

  it('isRetrievalConfident returns false for weak results', async () => {
    const { isRetrievalConfident } = await import('../src/storefront/retrieval.js');
    expect(isRetrievalConfident({ results: [], query: 'test' })).toBe(false);
    expect(isRetrievalConfident({ results: [{ passage: 'x', source: 'y', score: 0.1 }], query: 'test' }, 1.0)).toBe(false);
  });
});

// ── 5. Router integration ───────────────────────────────────

describe('Storefront Knowledge — Router', () => {
  // Mock DB calls since router hits faq-repo
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('"what is gomomo" routes to facts (no DB needed)', async () => {
    // Mock faq-repo to avoid DB dependency
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { routeStorefrontQuestion } = await import('../src/storefront/router.js');
    const result = await routeStorefrontQuestion('What is Gomomo?');
    expect(result.type).toBe('facts');
    if (result.type === 'facts') {
      expect(result.answer).toContain('AI receptionist platform');
      expect(result.section).toBe('brand');
    }
  });

  it('"pricing" routes to facts', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { routeStorefrontQuestion } = await import('../src/storefront/router.js');
    const result = await routeStorefrontQuestion('What is the pricing?');
    expect(result.type).toBe('facts');
    if (result.type === 'facts') {
      expect(result.answer).toContain('Free');
      expect(result.answer).toContain('Pro');
    }
  });

  it('booking intent bypasses storefront router', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { routeStorefrontQuestion } = await import('../src/storefront/router.js');
    const result = await routeStorefrontQuestion('I want to book an appointment');
    expect(result.type).toBe('bypass');
    if (result.type === 'bypass') {
      expect(result.reason).toBe('booking_intent');
    }
  });

  it('unmatched question logs as unanswered FAQ', async () => {
    const logSpy = vi.fn().mockResolvedValue({ id: 'test-id', question: 'xyzzy quantum entanglement nonsense' });
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: logSpy,
    }));
    const { routeStorefrontQuestion } = await import('../src/storefront/router.js');
    const result = await routeStorefrontQuestion('xyzzy quantum entanglement nonsense');
    expect(result.type).toBe('unknown');
    if (result.type === 'unknown') {
      expect(result.logged).toBe(true);
    }
    expect(logSpy).toHaveBeenCalledWith('xyzzy quantum entanglement nonsense');
  });

  it('approved FAQ is returned before RAG', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => ({
        id: 'faq-123',
        question: 'Can Gomomo handle walk-ins?',
        answer: 'Yes! Gomomo supports walk-in bookings through the web chat widget.',
        source_faq_id: null,
        approved_at: '2026-02-11T00:00:00Z',
      }),
      logUnansweredFaq: async () => ({}),
    }));
    const { routeStorefrontQuestion } = await import('../src/storefront/router.js');
    const result = await routeStorefrontQuestion('Can Gomomo handle walk-ins?');
    // This doesn't match any facts pattern, so it should hit approved FAQs
    expect(result.type).toBe('approved_faq');
    if (result.type === 'approved_faq') {
      expect(result.answer).toContain('walk-in');
      expect(result.faqId).toBe('faq-123');
    }
  });
});

// ── 6. Storefront context prompt builder ────────────────────

describe('Storefront Knowledge — Context Prompt Builder', () => {
  it('builds facts context prompt', async () => {
    const { buildStorefrontContextPrompt } = await import('../src/storefront/router.js');
    const prompt = buildStorefrontContextPrompt({
      type: 'facts',
      answer: 'Gomomo is an AI receptionist platform.',
      section: 'brand',
    });
    expect(prompt).toContain('STOREFRONT ANSWER');
    expect(prompt).toContain('verified facts');
    expect(prompt).toContain('Gomomo is an AI receptionist platform.');
  });

  it('builds facts context prompt with CTA for partnership sections', async () => {
    const { buildStorefrontContextPrompt } = await import('../src/storefront/router.js');
    const prompt = buildStorefrontContextPrompt({
      type: 'facts',
      answer: 'We welcome advertising partnerships.',
      section: 'partnership_advertising',
    });
    expect(prompt).toContain('STOREFRONT ANSWER');
    expect(prompt).toContain('sales/partnership question');
    expect(prompt).toContain('Gomomo Partnership Call');
    expect(prompt).toContain('check_availability');
  });

  it('builds facts context prompt with CTA for sales_cta section', async () => {
    const { buildStorefrontContextPrompt } = await import('../src/storefront/router.js');
    const prompt = buildStorefrontContextPrompt({
      type: 'facts',
      answer: 'I can book a call for you.',
      section: 'sales_cta',
    });
    expect(prompt).toContain('sales/partnership question');
    expect(prompt).toContain('booking flow');
  });

  it('builds facts context prompt with CTA for mission section', async () => {
    const { buildStorefrontContextPrompt } = await import('../src/storefront/router.js');
    const prompt = buildStorefrontContextPrompt({
      type: 'facts',
      answer: 'Our mission is to help every business.',
      section: 'mission',
    });
    expect(prompt).toContain('sales/partnership question');
  });

  it('does NOT add CTA suffix for non-sales sections', async () => {
    const { buildStorefrontContextPrompt } = await import('../src/storefront/router.js');
    const prompt = buildStorefrontContextPrompt({
      type: 'facts',
      answer: 'Our channels include web chat.',
      section: 'channels',
    });
    expect(prompt).toContain('STOREFRONT ANSWER');
    expect(prompt).not.toContain('sales/partnership question');
  });

  it('builds approved FAQ context prompt', async () => {
    const { buildStorefrontContextPrompt } = await import('../src/storefront/router.js');
    const prompt = buildStorefrontContextPrompt({
      type: 'approved_faq',
      answer: 'Yes, we support Google Calendar.',
      faqId: 'faq-1',
    });
    expect(prompt).toContain('APPROVED FAQ ANSWER');
    expect(prompt).toContain('human-verified');
  });

  it('builds RAG context prompt with passages and sources', async () => {
    const { buildStorefrontContextPrompt } = await import('../src/storefront/router.js');
    const prompt = buildStorefrontContextPrompt({
      type: 'rag',
      passages: ['Gomomo uses TLS encryption.', 'Data is encrypted at rest.'],
      sources: ['privacy.md', 'privacy.md'],
      query: 'Is my data secure?',
    });
    expect(prompt).toContain('RETRIEVED CONTEXT');
    expect(prompt).toContain('privacy.md');
    expect(prompt).toContain('TLS encryption');
  });

  it('returns null for bypass/unknown results', async () => {
    const { buildStorefrontContextPrompt } = await import('../src/storefront/router.js');
    expect(buildStorefrontContextPrompt({ type: 'bypass', reason: 'booking_intent' })).toBeNull();
    expect(buildStorefrontContextPrompt({ type: 'unknown', logged: false })).toBeNull();
  });
});

// ── 7. Pricing answer has no hallucinated numbers ───────────

describe('Storefront Knowledge — Anti-Hallucination', () => {
  it('pricing answer only contains plan names from GOMOMO_FACTS', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('pricing');
    expect(result).not.toBeNull();

    const planNames = GOMOMO_FACTS.pricing_plans.map((p) => p.name);
    for (const name of planNames) {
      expect(result!.answer).toContain(name);
    }

    // Ensure no made-up plan names
    expect(result!.answer).not.toContain('Premium');
    expect(result!.answer).not.toContain('Starter');
    expect(result!.answer).not.toContain('Ultimate');
  });

  it('contact answer only contains emails from GOMOMO_FACTS', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const result = answerFromFacts('contact');
    expect(result).not.toBeNull();
    expect(result!.answer).toContain(GOMOMO_FACTS.contact.general);
    // Should not contain any email not in facts
    expect(result!.answer).not.toContain('info@gomomo.ai');
  });

  it('partnership answers use only contact emails from GOMOMO_FACTS', async () => {
    const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const adResult = answerFromFacts('I want to advertise');
    expect(adResult).not.toBeNull();
    // All emails in the answer must be from the facts
    const allEmails = [
      GOMOMO_FACTS.contact.general,
      GOMOMO_FACTS.contact.partners,
      GOMOMO_FACTS.contact.sales,
    ];
    const emailMatches = adResult!.answer.match(/[\w.-]+@gomomo\.ai/g) ?? [];
    for (const email of emailMatches) {
      expect(allEmails).toContain(email);
    }
  });
});

// ── 8. No wellness/clinic language ──────────────────────────

describe('Storefront Knowledge — No Wellness Language', () => {
  it('GOMOMO_FACTS contains no wellness/clinic/Bloom language', async () => {
    const { GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
    const jsonDump = JSON.stringify(GOMOMO_FACTS).toLowerCase();
    expect(jsonDump).not.toContain('bloom');
    expect(jsonDump).not.toContain('wellness studio');
    expect(jsonDump).not.toContain('massage');
    expect(jsonDump).not.toContain('facial');
    expect(jsonDump).not.toContain('deep tissue');
    expect(jsonDump).not.toContain('aromatherapy');
  });

  it('answerFromFacts never returns wellness language', async () => {
    const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
    const queries = [
      'What is Gomomo?', 'pricing', 'mission', 'I want to partner',
      'I want to advertise', 'book a call', 'I want to invest',
      'what problem do you solve', 'features', 'contact',
    ];
    for (const q of queries) {
      const result = answerFromFacts(q);
      if (result) {
        const lower = result.answer.toLowerCase();
        expect(lower).not.toContain('bloom');
        expect(lower).not.toContain('wellness studio');
        expect(lower).not.toContain('massage');
        expect(lower).not.toContain('facial');
      }
    }
  });
});

// ── 9. Router: partnership/sales routes to facts ────────────

describe('Storefront Knowledge — Router Sales/Partnership', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('"I want to advertise" routes to facts with partnership_advertising section', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { routeStorefrontQuestion } = await import('../src/storefront/router.js');
    const result = await routeStorefrontQuestion('I want to advertise with you');
    expect(result.type).toBe('facts');
    if (result.type === 'facts') {
      expect(result.section).toBe('partnership_advertising');
      expect(result.answer).toContain('partners@gomomo.ai');
    }
  });

  it('"book a call" routes to facts with sales_cta section', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { routeStorefrontQuestion } = await import('../src/storefront/router.js');
    const result = await routeStorefrontQuestion('Can I book a call?');
    expect(result.type).toBe('facts');
    if (result.type === 'facts') {
      expect(result.section).toBe('sales_cta');
      expect(result.answer).toContain('Gomomo Partnership Call');
    }
  });

  it('"investing" routes to facts with partnership_investors section', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { routeStorefrontQuestion } = await import('../src/storefront/router.js');
    const result = await routeStorefrontQuestion("I'm interested in investing");
    expect(result.type).toBe('facts');
    if (result.type === 'facts') {
      expect(result.section).toBe('partnership_investors');
      expect(result.answer).toContain('hello@gomomo.ai');
    }
  });

  it('"what is your mission" routes to facts', async () => {
    vi.doMock('../src/storefront/faq-repo.js', () => ({
      findApprovedAnswer: async () => null,
      logUnansweredFaq: async () => ({}),
    }));
    const { routeStorefrontQuestion } = await import('../src/storefront/router.js');
    const result = await routeStorefrontQuestion('What is your mission?');
    expect(result.type).toBe('facts');
    if (result.type === 'facts') {
      expect(result.section).toBe('mission');
    }
  });
});
