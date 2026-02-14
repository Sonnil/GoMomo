// ============================================================
// Agent Identity Enforcement Tests
// ============================================================
// Verifies that the canonical "Gomomo" identity is enforced
// across system prompts, storefront facts, and corpus docs.
// No legacy branding (Bloom, assistant, virtual assistant,
// AI service agent, powered by) should leak into runtime strings.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

// ── Shared mock tenant ──────────────────────────────────────
const baseTenant = {
  id: '00000000-0000-4000-a000-000000000001',
  timezone: 'America/New_York',
  slot_duration: 30,
  business_hours: {
    monday: { start: '09:00', end: '17:00' },
    tuesday: { start: '09:00', end: '17:00' },
    wednesday: { start: '09:00', end: '17:00' },
    thursday: { start: '09:00', end: '17:00' },
    friday: { start: '09:00', end: '17:00' },
    saturday: null,
    sunday: null,
  },
  services: [
    { name: 'Demo Consultation', duration: 30, description: 'Standard demo appointment' },
  ],
  service_catalog_mode: 'free_text' as const,
  created_at: new Date(),
  updated_at: new Date(),
};

const gomomoTenant = { ...baseTenant, name: 'Gomomo', slug: 'gomomo' };
const otherTenant = { ...baseTenant, name: 'Acme Salon', slug: 'acme-salon' };

// ── Tests ───────────────────────────────────────────────────

describe('Agent Identity Enforcement', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
  });

  // ═══════════════════════════════════════════════════════════
  // 1. System Prompt — "Who are you?" behaviour
  // ═══════════════════════════════════════════════════════════

  describe('System Prompt Identity', () => {
    it('opens with "You are Gomomo" for the gomomo tenant', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any);
      expect(prompt).toMatch(/^You are Gomomo/);
    });

    it('contains IDENTITY LOCK section for gomomo tenant', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any);
      expect(prompt).toContain('IDENTITY LOCK');
      expect(prompt).toContain('Your name is Gomomo');
    });

    it('instructs the agent to say "I\'m Gomomo" when asked who it is', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any);
      expect(prompt).toContain("I'm Gomomo");
    });

    it('instructs the agent to say "built by the Gomomo team" when asked who built it', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any);
      expect(prompt).toContain('built by the Gomomo team');
    });

    it('forbids the word "assistant" in the gomomo system prompt (except OpenAI role refs)', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any).toLowerCase();

      // "assistant" should appear ONLY inside the NEVER/ban instructions
      // e.g. 'NEVER call yourself an "assistant"'
      // It should NOT appear as a positive self-descriptor like "You are the AI assistant"
      expect(prompt).not.toMatch(/you are.*\bassistant\b/);
      expect(prompt).not.toMatch(/^.*\bi'm.*\bassistant\b/m);
    });

    it('forbids "virtual assistant" anywhere in gomomo system prompt', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any).toLowerCase();
      // It may appear in the NEVER-say list, which is acceptable
      // But verify it does NOT appear as an identity claim
      const lines = prompt.split('\n');
      const identityLines = lines.filter(
        (l) => l.includes('virtual assistant') && !l.includes('never'),
      );
      expect(identityLines).toHaveLength(0);
    });

    it('forbids "AI service agent" as a positive identity in gomomo system prompt', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any);
      // "AI service agent" may appear in NEVER-ban instructions — that's OK.
      // It must NOT appear as a self-descriptor like "You are an AI service agent".
      const lines = prompt.split('\n');
      const identityLines = lines.filter(
        (l) =>
          l.toLowerCase().includes('ai service agent') &&
          !l.toLowerCase().includes('never'),
      );
      expect(identityLines).toHaveLength(0);
    });

    it('forbids "powered by" in gomomo system prompt', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any);
      // "powered by" should not be used as self-identity — may appear in NEVER instructions
      const lines = prompt.split('\n');
      const identityLines = lines.filter(
        (l) => l.toLowerCase().includes('powered by') && !l.toLowerCase().includes('never'),
      );
      expect(identityLines).toHaveLength(0);
    });

    it('non-gomomo tenant says "AI receptionist" not "AI service agent"', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(otherTenant as any);
      expect(prompt).toContain('AI receptionist for "Acme Salon"');
      expect(prompt).not.toContain('AI service agent');
    });

    it('non-gomomo tenant says "built on the Gomomo platform" not "powered by"', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(otherTenant as any);
      expect(prompt).toContain('built on the Gomomo platform');
      expect(prompt).not.toContain('powered by gomomo.ai');
    });

    it('uses "TEXT-BASED agent" not "TEXT-BASED assistant"', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any);
      expect(prompt).toContain('TEXT-BASED agent');
      expect(prompt).not.toContain('TEXT-BASED assistant');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 2. No Bloom / Legacy Branding
  // ═══════════════════════════════════════════════════════════

  describe('No Legacy Branding (Bloom)', () => {
    it('gomomo system prompt has zero positive Bloom references', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(gomomoTenant as any);
      // "Bloom" may appear in the NEVER-reference ban instruction — that's OK.
      // It must NOT appear as a positive identity/branding reference.
      const lines = prompt.split('\n');
      const bloomLines = lines.filter(
        (l) =>
          l.toLowerCase().includes('bloom') &&
          !l.toLowerCase().includes('never'),
      );
      expect(bloomLines).toHaveLength(0);
    });

    it('non-gomomo system prompt has zero Bloom references', async () => {
      const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
      const prompt = buildSystemPrompt(otherTenant as any).toLowerCase();
      expect(prompt).not.toContain('bloom');
    });

    it('GOMOMO_FACTS has zero Bloom references', async () => {
      const { GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
      const factsDump = JSON.stringify(GOMOMO_FACTS).toLowerCase();
      expect(factsDump).not.toContain('bloom');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 3. Gomomo Facts — Identity Fields
  // ═══════════════════════════════════════════════════════════

  describe('Gomomo Facts — Identity Fields', () => {
    it('has short_identity field', async () => {
      const { GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
      expect(GOMOMO_FACTS.short_identity).toBeDefined();
      expect(GOMOMO_FACTS.short_identity.toLowerCase()).toContain('gomomo');
      expect(GOMOMO_FACTS.short_identity.toLowerCase()).not.toContain('assistant');
    });

    it('has agent_identity_statement field', async () => {
      const { GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
      expect(GOMOMO_FACTS.agent_identity_statement).toBeDefined();
      expect(GOMOMO_FACTS.agent_identity_statement).toContain('I am Gomomo');
      expect(GOMOMO_FACTS.agent_identity_statement.toLowerCase()).not.toContain('assistant');
    });

    it('long_description does not reference clinics or fitness studios', async () => {
      const { GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
      expect(GOMOMO_FACTS.long_description.toLowerCase()).not.toContain('clinics');
      expect(GOMOMO_FACTS.long_description.toLowerCase()).not.toContain('fitness studios');
    });

    it('brand_name is Gomomo', async () => {
      const { GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
      expect(GOMOMO_FACTS.brand_name).toBe('Gomomo');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 4. Corpus Docs — No "AI assistant"
  // ═══════════════════════════════════════════════════════════

  describe('Corpus Docs — No "AI assistant"', () => {
    const corpusDir = path.resolve(__dirname, '../src/storefront/corpus');

    it('no corpus markdown file contains "AI assistant"', () => {
      const files = readdirSync(corpusDir).filter((f) => f.endsWith('.md'));
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const content = readFileSync(path.join(corpusDir, file), 'utf-8');
        expect(content).not.toContain('AI assistant');
      }
    });

    it('no corpus markdown file contains "virtual assistant"', () => {
      const files = readdirSync(corpusDir).filter((f) => f.endsWith('.md'));

      for (const file of files) {
        const content = readFileSync(path.join(corpusDir, file), 'utf-8');
        expect(content.toLowerCase()).not.toContain('virtual assistant');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 5. answerFromFacts — Identity Responses
  // ═══════════════════════════════════════════════════════════

  describe('answerFromFacts — Identity Responses', () => {
    it('"who is gomomo" returns brand answer with short_description', async () => {
      const { answerFromFacts, GOMOMO_FACTS } = await import('../src/storefront/gomomo-facts.js');
      const result = answerFromFacts('who is gomomo');
      expect(result).not.toBeNull();
      expect(result!.section).toBe('brand');
      expect(result!.answer).toContain(GOMOMO_FACTS.short_description);
    });

    it('"who built gomomo" returns team answer', async () => {
      const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
      const result = answerFromFacts('who built gomomo');
      expect(result).not.toBeNull();
      expect(result!.section).toBe('team');
      expect(result!.answer).toContain('Gomomo team');
    });

    it('no answerFromFacts response contains the word "assistant"', async () => {
      const { answerFromFacts } = await import('../src/storefront/gomomo-facts.js');
      const queries = [
        'what is gomomo',
        'who built gomomo',
        'pricing',
        'features',
        'contact',
        'industries',
        'privacy',
        'mission',
        'vision',
        'outcomes',
        'how to buy',
        'channels',
      ];

      for (const q of queries) {
        const result = answerFromFacts(q);
        if (result) {
          expect(result.answer.toLowerCase()).not.toContain('assistant');
        }
      }
    });
  });
});
