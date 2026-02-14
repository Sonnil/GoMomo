// ============================================================
// Platform Persona — Gomomo tenant system prompt tests
// ============================================================
// Verifies that the default Gomomo tenant (slug: "gomomo") gets the
// platform persona prompt, while non-Gomomo tenants still get the
// standard booking agent prompt.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock tenant shape ────────────────────────────────
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

describe('Platform Persona — system prompt', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
  });

  // ── 1. Gomomo tenant gets platform identity ─────────────
  it('includes "AI receptionist platform" for the gomomo tenant', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(gomomoTenant as any);

    expect(prompt).toContain('AI receptionist platform');
    expect(prompt).toContain('ABOUT GOMOMO');
    expect(prompt).toContain('WHAT TO SAY WHEN ASKED');
    expect(prompt).toContain('DEMO BOOKING NOTE');
    expect(prompt).toContain('IDENTITY LOCK');
  });

  // ── 2. Gomomo prompt does NOT reference wellness/clinic ──
  it('does not describe Gomomo as a wellness studio or clinic', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(gomomoTenant as any).toLowerCase();

    // These should never appear as a positive identity for Gomomo
    expect(prompt).not.toContain('acupuncture');
    expect(prompt).not.toMatch(/gomomo is a.*clinic/);
    expect(prompt).not.toMatch(/gomomo is a.*wellness/);
    expect(prompt).not.toMatch(/you are.*wellness.*agent/);
    // "wellness" may appear in a prohibition ("NEVER describe Gomomo as a wellness studio") — that's OK
    // "clinics" may appear as an industry example ("salons, clinics, law firms") — that's OK
  });

  // ── 3. Gomomo prompt still includes booking machinery ───
  it('preserves booking flow instructions in gomomo prompt', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(gomomoTenant as any);

    expect(prompt).toContain('CRITICAL RULES');
    expect(prompt).toContain('check_availability');
    expect(prompt).toContain('confirm_booking');
    expect(prompt).toContain('BOOKING FLOW');
    expect(prompt).toContain('hold_slot');
  });

  // ── 4. Gomomo prompt includes SaaS knowledge base ───────
  it('contains answers for common platform questions', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(gomomoTenant as any);

    expect(prompt).toContain('What is Gomomo?');
    expect(prompt).toContain('What problem does it solve?');
    expect(prompt).toContain('How much does it cost?');
    expect(prompt).toContain('How can I purchase?');
    expect(prompt).toContain('Who built it?');
    expect(prompt).toContain('What industries can use it?');
    expect(prompt).toContain('gomomo.ai');
  });

  // ── 5. Non-Gomomo tenant gets standard booking prompt ───
  it('uses standard booking agent prompt for non-gomomo tenants', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(otherTenant as any);

    expect(prompt).toContain('AI receptionist for "Acme Salon"');
    expect(prompt).toContain('built on the Gomomo platform');
    expect(prompt).not.toContain('ABOUT GOMOMO');
    expect(prompt).not.toContain('WHAT TO SAY WHEN ASKED');
    expect(prompt).not.toContain('DEMO BOOKING NOTE');
  });

  // ── 6. Non-Gomomo tenant still has booking flow ─────────
  it('non-gomomo tenant has full booking machinery', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(otherTenant as any);

    expect(prompt).toContain('CRITICAL RULES');
    expect(prompt).toContain('BOOKING FLOW');
    expect(prompt).toContain('check_availability');
    expect(prompt).toContain('confirm_booking');
  });

  // ── 7. GOMOMO_PLATFORM_SLUG export ──────────────────────
  it('exports GOMOMO_PLATFORM_SLUG as "gomomo"', async () => {
    const { GOMOMO_PLATFORM_SLUG } = await import('../src/agent/system-prompt.js');
    expect(GOMOMO_PLATFORM_SLUG).toBe('gomomo');
  });

  // ── 8. Gomomo prompt includes multi-channel info ────────
  it('mentions web chat, SMS, and voice in gomomo prompt', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(gomomoTenant as any);

    expect(prompt).toContain('web chat');
    expect(prompt).toContain('SMS');
    expect(prompt).toContain('voice');
  });

  // ── 9. Gomomo prompt includes multi-industry info ───────
  it('mentions multiple industries in gomomo prompt', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(gomomoTenant as any).toLowerCase();

    expect(prompt).toContain('salons');
    expect(prompt).toContain('law firms');
    expect(prompt).toContain('auto shops');
  });

  // ── 10. Platform prompt identity line ───────────────────
  it('gomomo prompt starts with canonical identity, not service agent', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(gomomoTenant as any);

    expect(prompt).toMatch(/^You are Gomomo/);
    expect(prompt).not.toMatch(/^You are the AI assistant for/);
    expect(prompt).not.toMatch(/^You are a professional, friendly AI service agent/);
  });
});
