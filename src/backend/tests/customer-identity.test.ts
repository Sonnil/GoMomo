// ============================================================
// Customer Identity + Session Continuity Tests
//
// Verifies:
//  1. Phone normalization (E.164)
//  2. Email normalization
//  3. Customer findOrCreate logic
//  4. Returning customer context generation
//  5. Soft-delete clears PII
//  6. Session linking to customer
//  7. SMS→web cross-channel continuity
//  8. System prompt returning-customer section
//  9. Preference learning from bookings
//  10. PII redaction includes customer fields
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 1. Phone Normalization ────────────────────────────────

describe('normalizePhone', () => {
  it('normalizes 10-digit US number to E.164', async () => {
    const { normalizePhone } = await import('../src/services/customer.service.js');
    expect(normalizePhone('5551234567')).toBe('+15551234567');
  });

  it('normalizes 11-digit US number with leading 1', async () => {
    const { normalizePhone } = await import('../src/services/customer.service.js');
    expect(normalizePhone('15551234567')).toBe('+15551234567');
  });

  it('preserves existing E.164 format', async () => {
    const { normalizePhone } = await import('../src/services/customer.service.js');
    expect(normalizePhone('+15551234567')).toBe('+15551234567');
  });

  it('strips parentheses, dashes, and spaces', async () => {
    const { normalizePhone } = await import('../src/services/customer.service.js');
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
  });

  it('handles international format', async () => {
    const { normalizePhone } = await import('../src/services/customer.service.js');
    expect(normalizePhone('+447911123456')).toBe('+447911123456');
  });
});

// ── 2. Email Normalization ────────────────────────────────

describe('normalizeEmail', () => {
  it('lowercases email', async () => {
    const { normalizeEmail } = await import('../src/services/customer.service.js');
    expect(normalizeEmail('Jane@Example.COM')).toBe('jane@example.com');
  });

  it('trims whitespace', async () => {
    const { normalizeEmail } = await import('../src/services/customer.service.js');
    expect(normalizeEmail('  user@test.com  ')).toBe('user@test.com');
  });
});

// ── 3. Customer findOrCreate Logic ────────────────────────

describe('customerRepo.findOrCreate', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));
    mockQuery.mockReset();
  });

  it('creates new customer when none found by phone', async () => {
    // findByPhone returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // INSERT returns new customer
    const newCustomer = {
      id: 'cust-001',
      tenant_id: 'tenant-1',
      phone: '+15551234567',
      email: null,
      display_name: null,
      preferences: {},
      booking_count: 0,
      last_seen_at: new Date().toISOString(),
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [newCustomer] });

    const { customerRepo } = await import('../src/repos/customer.repo.js');
    const result = await customerRepo.findOrCreate('tenant-1', { phone: '+15551234567' });

    expect(result.isNew).toBe(true);
    expect(result.customer.phone).toBe('+15551234567');
    expect(result.customer.id).toBe('cust-001');
  });

  it('returns existing customer when found by phone', async () => {
    const existing = {
      id: 'cust-002',
      tenant_id: 'tenant-1',
      phone: '+15551234567',
      email: 'existing@test.com',
      display_name: 'Jane',
      preferences: { preferred_service: 'Haircut' },
      booking_count: 3,
      last_seen_at: new Date().toISOString(),
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // findByPhone returns existing
    mockQuery.mockResolvedValueOnce({ rows: [existing] });
    // touch last_seen
    mockQuery.mockResolvedValueOnce({ rows: [{ ...existing, last_seen_at: new Date().toISOString() }] });

    const { customerRepo } = await import('../src/repos/customer.repo.js');
    const result = await customerRepo.findOrCreate('tenant-1', { phone: '+15551234567' });

    expect(result.isNew).toBe(false);
    expect(result.customer.id).toBe('cust-002');
    expect(result.customer.booking_count).toBe(3);
  });

  it('creates new customer when none found by email', async () => {
    // findByPhone — not searched (no phone)
    // findByEmail returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // INSERT returns new customer
    const newCustomer = {
      id: 'cust-003',
      tenant_id: 'tenant-1',
      phone: null,
      email: 'user@test.com',
      display_name: 'User',
      preferences: {},
      booking_count: 0,
      last_seen_at: new Date().toISOString(),
      deleted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [newCustomer] });

    const { customerRepo } = await import('../src/repos/customer.repo.js');
    const result = await customerRepo.findOrCreate('tenant-1', { email: 'user@test.com', display_name: 'User' });

    expect(result.isNew).toBe(true);
    expect(result.customer.email).toBe('user@test.com');
  });
});

// ── 4. Returning Customer Context ─────────────────────────

describe('customerService.getReturningContext', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));
    mockQuery.mockReset();
  });

  it('returns null for new customer with zero bookings', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'cust-new',
        tenant_id: 't1',
        phone: '+15551234567',
        email: null,
        display_name: null,
        preferences: {},
        booking_count: 0,
        last_seen_at: new Date().toISOString(),
        deleted_at: null,
      }],
    });

    const { customerService } = await import('../src/services/customer.service.js');
    const ctx = await customerService.getReturningContext('cust-new');
    expect(ctx).toBeNull();
  });

  it('returns context for returning customer with bookings', async () => {
    // findById
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'cust-ret',
        tenant_id: 't1',
        phone: '+15559876543',
        email: 'jane@test.com',
        display_name: 'Jane',
        preferences: { preferred_service: 'Consultation', timezone: 'America/New_York' },
        booking_count: 5,
        last_seen_at: new Date().toISOString(),
        deleted_at: null,
      }],
    });
    // countSessions
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });

    const { customerService } = await import('../src/services/customer.service.js');
    const ctx = await customerService.getReturningContext('cust-ret');

    expect(ctx).not.toBeNull();
    expect(ctx!.display_name).toBe('Jane');
    expect(ctx!.booking_count).toBe(5);
    expect(ctx!.preferences.preferred_service).toBe('Consultation');
    expect(ctx!.previous_sessions).toBe(3);
  });

  it('returns null for soft-deleted customer', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // findById filters deleted_at

    const { customerService } = await import('../src/services/customer.service.js');
    const ctx = await customerService.getReturningContext('cust-deleted');
    expect(ctx).toBeNull();
  });
});

// ── 5. Soft-Delete Clears PII ─────────────────────────────

describe('customerRepo.softDelete', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));
    mockQuery.mockReset();
  });

  it('sets deleted_at and clears PII fields', async () => {
    // softDelete UPDATE returns affected row
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const { customerRepo } = await import('../src/repos/customer.repo.js');
    const result = await customerRepo.softDelete('cust-to-delete');

    expect(result).toBe(true);

    // Verify the SQL clears PII
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('deleted_at');
    expect(sql).toContain('phone = NULL');
    expect(sql).toContain('email = NULL');
    expect(sql).toContain('display_name = NULL');
  });

  it('returns false for non-existent customer', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const { customerRepo } = await import('../src/repos/customer.repo.js');
    const result = await customerRepo.softDelete('non-existent');
    expect(result).toBe(false);
  });
});

// ── 6. Session Linking ────────────────────────────────────

describe('sessionRepo.linkCustomer', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));
    mockQuery.mockReset();
  });

  it('updates session with customer_id', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    await sessionRepo.linkCustomer('sess-123', 'cust-456');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('customer_id');
    expect(mockQuery.mock.calls[0][1]).toEqual(['cust-456', 'sess-123']);
  });

  it('findByCustomerId returns most recent session', async () => {
    const session = {
      id: 'sess-latest',
      tenant_id: 't1',
      customer_id: 'cust-456',
      channel: 'web',
      conversation: [],
      metadata: {},
      updated_at: new Date().toISOString(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [session] });

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    const result = await sessionRepo.findByCustomerId('cust-456', 't1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('sess-latest');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY updated_at DESC');
  });
});

// ── 7. Session channel parameter ──────────────────────────

describe('sessionRepo.findOrCreate with channel', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));
    mockQuery.mockReset();
  });

  it('passes channel to INSERT', async () => {
    const session = {
      id: 'sms-session',
      tenant_id: 't1',
      channel: 'sms',
      conversation: [],
      metadata: {},
    };
    mockQuery.mockResolvedValueOnce({ rows: [session] });

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    await sessionRepo.findOrCreate('sms-session', 't1', 'sms');

    expect(mockQuery.mock.calls[0][1]).toEqual(['sms-session', 't1', 'sms']);
  });

  it('defaults to web channel', async () => {
    const session = {
      id: 'web-session',
      tenant_id: 't1',
      channel: 'web',
      conversation: [],
      metadata: {},
    };
    mockQuery.mockResolvedValueOnce({ rows: [session] });

    const { sessionRepo } = await import('../src/repos/session.repo.js');
    await sessionRepo.findOrCreate('web-session', 't1');

    expect(mockQuery.mock.calls[0][1]).toEqual(['web-session', 't1', 'web']);
  });
});

// ── 8. System Prompt Returning Customer Section ───────────

describe('buildSystemPrompt with returning customer', () => {
  let buildSystemPrompt: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 60,
        FOLLOWUP_MAX_PER_BOOKING: 2,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));
    const mod = await import('../src/agent/system-prompt.js');
    buildSystemPrompt = mod.buildSystemPrompt;
  });

  const mockTenant = {
    id: 't1',
    name: 'Test Salon',
    timezone: 'America/New_York',
    services: [{ name: 'Haircut', duration: 30, description: 'Standard haircut' }],
    business_hours: { monday: { start: '09:00', end: '17:00' } },
  };

  it('includes returning customer section when context provided', () => {
    const prompt = buildSystemPrompt(mockTenant as any, {
      returningCustomer: {
        customer_id: 'cust-1',
        display_name: 'Jane',
        booking_count: 3,
        preferences: { preferred_service: 'Haircut' },
        previous_sessions: 2,
      },
    });

    expect(prompt).toContain('RETURNING CUSTOMER:');
    expect(prompt).toContain('Jane');
    expect(prompt).toContain('3 times before');
    expect(prompt).toContain('Haircut');
    expect(prompt).toContain('Welcome back, Jane');
    expect(prompt).toContain('Would you like the same Haircut as last time');
    expect(prompt).toContain('Do NOT ask for their name or email again');
  });

  it('omits returning customer section when null', () => {
    const prompt = buildSystemPrompt(mockTenant as any, {
      returningCustomer: null,
    });
    expect(prompt).not.toContain('RETURNING CUSTOMER:');
  });

  it('omits returning customer section when booking_count is 0', () => {
    const prompt = buildSystemPrompt(mockTenant as any, {
      returningCustomer: {
        customer_id: 'cust-new',
        display_name: null,
        booking_count: 0,
        preferences: {},
        previous_sessions: 1,
      },
    });
    expect(prompt).not.toContain('RETURNING CUSTOMER:');
  });

  it('handles returning customer without display_name', () => {
    const prompt = buildSystemPrompt(mockTenant as any, {
      returningCustomer: {
        customer_id: 'cust-2',
        display_name: null,
        booking_count: 2,
        preferences: {},
        previous_sessions: 1,
      },
    });

    expect(prompt).toContain('RETURNING CUSTOMER:');
    expect(prompt).toContain('2 times before');
    expect(prompt).not.toContain('null');
  });

  it('includes practitioner preference when set', () => {
    const prompt = buildSystemPrompt(mockTenant as any, {
      returningCustomer: {
        customer_id: 'cust-3',
        display_name: 'Bob',
        booking_count: 1,
        preferences: {
          preferred_service: 'Consultation',
          practitioner_preference: 'Dr. Smith',
        },
        previous_sessions: 1,
      },
    });

    expect(prompt).toContain('Dr. Smith');
  });
});

// ── 9. Preference Learning ────────────────────────────────

describe('customerService.learnFromBooking', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));
    mockQuery.mockReset();
  });

  it('updates service preference', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] }); // updatePreferences

    const { customerService } = await import('../src/services/customer.service.js');
    await customerService.learnFromBooking('cust-1', { service: 'Haircut' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('preferences');
  });

  it('skips update when no preferences to learn', async () => {
    const { customerService } = await import('../src/services/customer.service.js');
    await customerService.learnFromBooking('cust-1', {});

    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── 10. PII Redaction Includes Customer Fields ────────────

describe('PII Redaction — customer fields', () => {
  it('redacts customer_email and customer_phone', async () => {
    const { redactPII } = await import('../src/orchestrator/redact.js');
    const input = {
      customer_email: 'jane@test.com',
      customer_phone: '+15551234567',
      display_name: 'Jane Doe',
      client_phone: '+15559999999',
      reference_code: 'APT-999',
    };
    const result = redactPII(input);

    expect(result.customer_email).toBe('[REDACTED]');
    expect(result.customer_phone).toBe('[REDACTED]');
    expect(result.display_name).toBe('[REDACTED]');
    expect(result.client_phone).toBe('[REDACTED]');
    // Non-PII preserved
    expect(result.reference_code).toBe('APT-999');
  });
});

// ── 11. Customer Service — deleteCustomer ─────────────────

describe('customerService.deleteCustomer', () => {
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/db/client.js', () => ({
      query: mockQuery,
    }));
    mockQuery.mockReset();
  });

  it('unlinks sessions then soft-deletes customer', async () => {
    // Unlink sessions
    mockQuery.mockResolvedValueOnce({ rowCount: 2 });
    // softDelete
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const { customerService } = await import('../src/services/customer.service.js');
    const result = await customerService.deleteCustomer('cust-del');

    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // First call: unlink sessions
    const unlinkSql = mockQuery.mock.calls[0][0] as string;
    expect(unlinkSql).toContain('customer_id = NULL');
    expect(unlinkSql).toContain('chat_sessions');

    // Second call: soft-delete customer
    const deleteSql = mockQuery.mock.calls[1][0] as string;
    expect(deleteSql).toContain('deleted_at');
  });
});
