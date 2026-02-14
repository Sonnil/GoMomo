// ============================================================
// Service Catalog Mode + Phone Normalization Consolidation Tests
//
// Part A: Service Catalog Mode
//   1. Migration 020 exists and adds service_catalog_mode column
//   2. Tenant type includes service_catalog_mode field
//   3. System prompt: catalog_only mode lists services as fixed list
//   4. System prompt: free_text mode accepts any service description
//   5. System prompt: hybrid mode shows catalog + allows custom
//   6. Tool executor: catalog_only rejects unknown service
//   7. Tool executor: free_text accepts unknown service
//   8. Tool executor: hybrid accepts unknown service
//   9. Tool executor: catalog_only still works for known service
//  10. Seed sets gomomo to free_text mode
//
// Part B: Phone Normalization Consolidation
//  11. customer.service.normalizePhone delegates to voice/phone-normalizer
//  12. customer.service.normalizePhone handles all US formats
//  13. customer.service.normalizePhone returns raw fallback for garbage
//  14. voice/phone-normalizer handles 689-256-8400 format
//  15. voice/phone-normalizer handles (689)256-8400 format
//  16. voice/phone-normalizer handles 689.256.8400 format
//  17. voice/phone-normalizer handles +16892568400 format
//  18. voice/phone-normalizer handles 6892568400 format
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

// ── Part A: Service Catalog Mode ────────────────────────────

describe('Service Catalog Mode', () => {
  // ── 1. Migration ──────────────────────────────────────────

  it('migration 020 adds service_catalog_mode column', () => {
    const migrationPath = path.resolve(
      __dirname, '..', 'src', 'db', 'migrations', '020_service_catalog_mode.sql',
    );
    expect(fs.existsSync(migrationPath)).toBe(true);

    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toContain('service_catalog_mode');
    expect(sql).toContain("DEFAULT 'catalog_only'");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS');
  });

  // ── 2. Domain Type ────────────────────────────────────────

  it('Tenant interface includes service_catalog_mode', async () => {
    const typesPath = path.resolve(__dirname, '..', 'src', 'domain', 'types.ts');
    const src = fs.readFileSync(typesPath, 'utf-8');
    expect(src).toContain('service_catalog_mode');
    expect(src).toContain("'catalog_only'");
    expect(src).toContain("'free_text'");
    expect(src).toContain("'hybrid'");
  });

  // ── 3–5. System Prompt ────────────────────────────────────

  const baseTenant = {
    id: '00000000-0000-4000-a000-000000000001',
    name: 'Test Clinic',
    slug: 'test-clinic',
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
      { name: 'General Consultation', duration: 30, description: 'Standard consult' },
      { name: 'Follow-up', duration: 20, description: 'Quick follow-up' },
    ],
    created_at: new Date(),
    updated_at: new Date(),
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('catalog_only prompt lists services as fixed list', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 0, FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt({ ...baseTenant, service_catalog_mode: 'catalog_only' } as any);

    expect(prompt).toContain('General Consultation (30 minutes)');
    expect(prompt).toContain('Follow-up (20 minutes)');
    // Should NOT contain free_text language
    expect(prompt).not.toContain('accepts ANY service');
    expect(prompt).not.toContain('accept any description');
  });

  it('free_text prompt accepts any service description', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 0, FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt({ ...baseTenant, service_catalog_mode: 'free_text' } as any);

    expect(prompt).toContain('accepts ANY service');
    expect(prompt).toContain('do NOT limit to a predefined list');
    // Common services should still be mentioned for reference
    expect(prompt).toContain('Common services include');
    expect(prompt).toContain('General Consultation');
  });

  it('hybrid prompt shows catalog but allows custom services', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 0, FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt({ ...baseTenant, service_catalog_mode: 'hybrid' } as any);

    expect(prompt).toContain('General Consultation (30 minutes)');
    expect(prompt).toContain('not on this list');
    expect(prompt).toContain('accept their description');
    expect(prompt).toContain('also accept any custom service');
  });

  // ── 6–9. Tool Executor Service Validation ─────────────────

  function setupCheckAvailabilityMocks() {
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {
        getAvailableSlots: vi.fn().mockResolvedValue({
          slots: [
            { start: '2025-02-10T14:00:00Z', end: '2025-02-10T14:30:00Z', available: true },
          ],
          verified: false,
        }),
      },
      SlotConflictError: class extends Error {},
      getCalendarDebugSnapshot: vi.fn(),
      CalendarReadError: class extends Error {},
      isDemoAvailabilityActive: () => false,
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'j-1' }) },
    }));
    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: { evaluate: vi.fn().mockResolvedValue({ effect: 'allow' }) },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/followup-tracking.repo.js', () => ({
      followupTrackingRepo: {
        countBySession: vi.fn().mockResolvedValue(0),
        lastFollowupTo: vi.fn().mockResolvedValue(null),
        record: vi.fn().mockResolvedValue({}),
      },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        MAX_AVAILABILITY_RANGE_DAYS: 30,
        FOLLOWUP_MAX_PER_BOOKING: 2,
        FOLLOWUP_COOLDOWN_MINUTES: 60,
      },
    }));
  }

  it('catalog_only rejects unknown service name', async () => {
    setupCheckAvailabilityMocks();

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      {
        start_date: '2025-02-10',
        end_date: '2025-02-14',
        service_name: 'Deep Tissue Massage',
      },
      'tenant-1',
      'session-1',
      { ...baseTenant, service_catalog_mode: 'catalog_only' } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown service');
    expect(result.error).toContain('Deep Tissue Massage');
  });

  it('free_text accepts unknown service name', async () => {
    setupCheckAvailabilityMocks();

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      {
        start_date: '2025-02-10',
        end_date: '2025-02-14',
        service_name: 'Deep Tissue Massage',
      },
      'tenant-1',
      'session-1',
      { ...baseTenant, service_catalog_mode: 'free_text' } as any,
    );

    expect(result.success).toBe(true);
    expect((result as any).data.available_slots).toBeDefined();
  });

  it('hybrid accepts unknown service name', async () => {
    setupCheckAvailabilityMocks();

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      {
        start_date: '2025-02-10',
        end_date: '2025-02-14',
        service_name: 'Custom Strategy Session',
      },
      'tenant-1',
      'session-1',
      { ...baseTenant, service_catalog_mode: 'hybrid' } as any,
    );

    expect(result.success).toBe(true);
    expect((result as any).data.available_slots).toBeDefined();
  });

  it('catalog_only accepts known service name', async () => {
    setupCheckAvailabilityMocks();

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      {
        start_date: '2025-02-10',
        end_date: '2025-02-14',
        service_name: 'General Consultation',
      },
      'tenant-1',
      'session-1',
      { ...baseTenant, service_catalog_mode: 'catalog_only' } as any,
    );

    expect(result.success).toBe(true);
    expect((result as any).data.available_slots).toBeDefined();
  });

  it('default (no catalog mode) behaves as catalog_only', async () => {
    setupCheckAvailabilityMocks();

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      {
        start_date: '2025-02-10',
        end_date: '2025-02-14',
        service_name: 'Unknown Service',
      },
      'tenant-1',
      'session-1',
      { ...baseTenant } as any, // no service_catalog_mode → defaults to catalog_only
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown service');
  });

  // ── 10. Seed ──────────────────────────────────────────────

  it('seed sets gomomo to free_text mode', () => {
    const seedPath = path.resolve(__dirname, '..', 'src', 'db', 'seed.ts');
    const src = fs.readFileSync(seedPath, 'utf-8');
    expect(src).toContain('service_catalog_mode');
    expect(src).toContain("'free_text'");
  });
});

// ── Part B: Phone Normalization Consolidation ───────────────

describe('Phone Normalization Consolidation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // ── 11–13. customer.service delegates to voice/phone-normalizer ──

  it('customer.service.normalizePhone delegates to voice/phone-normalizer', () => {
    const csPath = path.resolve(__dirname, '..', 'src', 'services', 'customer.service.ts');
    const src = fs.readFileSync(csPath, 'utf-8');
    expect(src).toContain("from '../voice/phone-normalizer.js'");
    // Should NOT have its own implementation of digit stripping
    expect(src).not.toMatch(/digits\.length === 10/);
    expect(src).not.toMatch(/digits\.length === 11/);
  });

  it('customer.service.normalizePhone handles all US formats via delegation', async () => {
    const { normalizePhone } = await import('../src/services/customer.service.js');
    expect(normalizePhone('5551234567')).toBe('+15551234567');
    expect(normalizePhone('15551234567')).toBe('+15551234567');
    expect(normalizePhone('+15551234567')).toBe('+15551234567');
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('555-123-4567')).toBe('+15551234567');
    expect(normalizePhone('555.123.4567')).toBe('+15551234567');
  });

  it('customer.service.normalizePhone returns raw string for un-normalizable input', async () => {
    const { normalizePhone } = await import('../src/services/customer.service.js');
    // The customer service version should return the raw input as fallback
    // (not null, for backward compatibility)
    const result = normalizePhone('hello');
    expect(typeof result).toBe('string');
    // It should return 'hello' as-is since normalizePhoneStrict returns null
    expect(result).toBe('hello');
  });

  // ── 14–18. voice/phone-normalizer specific format tests ──

  it('normalizes 689-256-8400 to +16892568400', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('689-256-8400')).toBe('+16892568400');
  });

  it('normalizes (689)256-8400 to +16892568400', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('(689)256-8400')).toBe('+16892568400');
  });

  it('normalizes (689) 256-8400 to +16892568400', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('(689) 256-8400')).toBe('+16892568400');
  });

  it('normalizes 689.256.8400 to +16892568400', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('689.256.8400')).toBe('+16892568400');
  });

  it('normalizes +16892568400 passthrough', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('+16892568400')).toBe('+16892568400');
  });

  it('normalizes 6892568400 (10 digits) to +16892568400', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('6892568400')).toBe('+16892568400');
  });

  it('normalizes 16892568400 (11 digits) to +16892568400', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('16892568400')).toBe('+16892568400');
  });

  it('normalizes +1 (689) 256 8400 to +16892568400', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('+1 (689) 256 8400')).toBe('+16892568400');
  });

  it('returns null for empty input', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('')).toBeNull();
  });

  it('returns null for non-numeric input', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('not-a-number')).toBeNull();
  });

  it('returns null for too-short input', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
  });
});
