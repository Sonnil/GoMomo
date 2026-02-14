// ============================================================
// Legacy Brand Sanitizer (Guardrail 5) + System Prompt Tests
// ============================================================
// Separated into own file to avoid vitest module registry
// pollution from tests that mock response-post-processor.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════
// 1. Legacy Brand Sanitizer (Guardrail 5)
// ═══════════════════════════════════════════════════════════

describe('Guardrail 5 — Legacy Brand Sanitizer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('replaces "Bloom Wellness Studio" with "Gomomo"', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = 'Welcome to Bloom Wellness Studio! We offer great services.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toContain('Bloom');
    expect(result).toContain('Gomomo');
    expect(result).toBe('Welcome to Gomomo! We offer great services.');
  });

  it('replaces "Bloom Wellness" (without Studio) with "Gomomo"', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = 'At Bloom Wellness, we provide excellent care.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toContain('Bloom');
    expect(result).toContain('Gomomo');
  });

  it('replaces "Bloom.ai" with "Gomomo"', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = 'Visit Bloom.ai for more information.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toContain('Bloom.ai');
    expect(result).toContain('Gomomo');
  });

  it('replaces "Demo Clinic" with "Gomomo"', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = 'Demo Clinic has the best doctors.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toContain('Demo Clinic');
    expect(result).toContain('Gomomo');
  });

  it('handles multiple legacy brand mentions in one response', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = 'Bloom Wellness Studio and bloom.ai are the same. Also see Demo Clinic.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toMatch(/bloom/i);
    expect(result).not.toContain('Demo Clinic');
  });

  it('does not modify responses without legacy brand names', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = 'Gomomo offers AI-powered booking. Plans start at $0/month.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).toBe(input);
  });

  it('is case-insensitive for legacy brand patterns', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = 'BLOOM WELLNESS STUDIO is great. Also bloom wellness studio.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toMatch(/bloom/i);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. System Prompt — No Forbidden Brand Tokens
// ═══════════════════════════════════════════════════════════

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

describe('System Prompt — No Legacy Brand Tokens', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('system prompt does not contain "Bloom" or "bloom.ai"', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: undefined,
        OPENAI_MODEL: 'gpt-4o',
        CALENDAR_DEBUG: 'false',
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        NODE_ENV: 'test',
      },
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(gomomoTenant);

    // The word "Bloom" must NOT appear anywhere in the system prompt
    expect(prompt.toLowerCase()).not.toContain('bloom');
    // "Demo Clinic" must NOT appear
    expect(prompt.toLowerCase()).not.toContain('demo clinic');
  });

  it('system prompt contains positive identity constraints', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: undefined,
        OPENAI_MODEL: 'gpt-4o',
        CALENDAR_DEBUG: 'false',
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        NODE_ENV: 'test',
      },
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(gomomoTenant);

    expect(prompt).toContain('You represent only Gomomo');
    expect(prompt).toContain('Do not mention or imply you represent any other business or brand');
    expect(prompt).toContain('I only represent Gomomo');
  });
});
