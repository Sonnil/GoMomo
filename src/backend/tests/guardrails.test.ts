// ============================================================
// Guardrail Tests — Autonomous Agent Runtime
//
// Verifies the safety guarantees of the agent runtime:
//  1. Policy Engine: default-deny blocks unregistered actions
//  2. Tool Registry: only whitelisted tools can execute
//  3. Audit Trail: every event + policy decision logged
//  4. Event Bus: emits and routes correctly
//  5. PII Redaction: sensitive fields never leak to audit
//  6. Job lifecycle: create → claim → complete/fail
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── PII Redaction ─────────────────────────────────────────

describe('PII Redaction', () => {
  it('redacts known PII field names', async () => {
    const { redactPII } = await import('../src/orchestrator/redact.js');
    const input = {
      client_name: 'Jane Doe',
      client_email: 'jane@example.com',
      phone: '+15551234',
      reference_code: 'APT-123',
      start_time: '2025-02-10T10:00:00Z',
    };
    const result = redactPII(input);
    expect(result.client_name).toBe('[REDACTED]');
    expect(result.client_email).toBe('[REDACTED]');
    expect(result.phone).toBe('[REDACTED]');
    // Non-PII fields preserved
    expect(result.reference_code).toBe('APT-123');
    expect(result.start_time).toBe('2025-02-10T10:00:00Z');
  });

  it('redacts fields matching PII patterns', async () => {
    const { redactPII } = await import('../src/orchestrator/redact.js');
    const result = redactPII({
      caller_phone: '+15559999',
      access_token: 'ya29.abc123',
      secret_key: 'sk-abc',
    });
    expect(result.caller_phone).toBe('[REDACTED]');
    expect(result.access_token).toBe('[REDACTED]');
    expect(result.secret_key).toBe('[REDACTED]');
  });

  it('handles nested objects', async () => {
    const { redactPII } = await import('../src/orchestrator/redact.js');
    const result = redactPII({
      appointment: {
        client_email: 'test@x.com',
        service: 'Consultation',
      },
    });
    expect((result.appointment as any).client_email).toBe('[REDACTED]');
    expect((result.appointment as any).service).toBe('Consultation');
  });

  it('handles null/undefined/empty gracefully', async () => {
    const { redactPII } = await import('../src/orchestrator/redact.js');
    expect(redactPII(null as any)).toEqual({});
    expect(redactPII(undefined as any)).toEqual({});
    expect(redactPII({})).toEqual({});
  });
});

// ── Event Bus ─────────────────────────────────────────────

describe('DomainEventBus', () => {
  beforeEach(async () => {
    // Mock the audit repo to avoid DB calls
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('delivers events to subscribers', async () => {
    const { DomainEventBus } = await import('../src/orchestrator/event-bus.js');
    const bus = new DomainEventBus();
    const received: any[] = [];

    bus.on('BookingCreated', async (event) => {
      received.push(event);
    });

    const evt = {
      name: 'BookingCreated' as const,
      tenant_id: 'test-tenant',
      appointment: { id: 'apt-1' } as any,
      session_id: 'sess-1',
      timestamp: new Date().toISOString(),
    };

    await bus.emit(evt);

    // Allow setImmediate to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe('BookingCreated');
  });

  it('catches and logs handler errors without crashing', async () => {
    const { DomainEventBus } = await import('../src/orchestrator/event-bus.js');
    const bus = new DomainEventBus();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    bus.on('HoldExpired', async () => {
      throw new Error('handler boom');
    });

    const evt = {
      name: 'HoldExpired' as const,
      tenant_id: 'test',
      hold_id: 'h-1',
      slot_start: '2025-01-01T10:00:00Z',
      slot_end: '2025-01-01T10:30:00Z',
      timestamp: new Date().toISOString(),
    };

    // Should not throw
    await bus.emit(evt);
    await new Promise((r) => setTimeout(r, 50));

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('tracks recent events (capped at 200)', async () => {
    const { DomainEventBus } = await import('../src/orchestrator/event-bus.js');
    const bus = new DomainEventBus();

    for (let i = 0; i < 210; i++) {
      await bus.emit({
        name: 'HoldExpired' as const,
        tenant_id: 'test',
        hold_id: `h-${i}`,
        slot_start: '2025-01-01T10:00:00Z',
        slot_end: '2025-01-01T10:30:00Z',
        timestamp: new Date().toISOString(),
      });
    }

    expect(bus.getRecentEvents().length).toBeLessThanOrEqual(200);
  });
});

// ── Registered Tools ──────────────────────────────────────

describe('Registered Tools', () => {
  it('lists all registered tools', async () => {
    const { listRegisteredTools } = await import('../src/orchestrator/registered-tools.js');
    const tools = listRegisteredTools();
    expect(tools).toContain('send_confirmation');
    expect(tools).toContain('send_cancellation');
    expect(tools).toContain('retry_calendar_sync');
    expect(tools).toContain('send_reminder');
  });

  it('returns undefined for unregistered tools', async () => {
    const { getTool } = await import('../src/orchestrator/registered-tools.js');
    expect(getTool('exec_shell')).toBeUndefined();
    expect(getTool('read_filesystem')).toBeUndefined();
    expect(getTool('arbitrary_http')).toBeUndefined();
  });

  it('returns a function for registered tools', async () => {
    const { getTool } = await import('../src/orchestrator/registered-tools.js');
    const tool = getTool('send_confirmation');
    expect(typeof tool).toBe('function');
  });
});

// ── Policy Engine (Unit) ──────────────────────────────────

describe('Policy Engine', () => {
  beforeEach(async () => {
    vi.doMock('../src/repos/policy.repo.js', () => ({
      policyRepo: {
        findByAction: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('default-deny when no rules match', async () => {
    const { policyEngine } = await import('../src/orchestrator/policy-engine.js');
    const decision = await policyEngine.evaluate('unknown_action', 'tenant-1', {});
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('no matching');
  });

  it('allows when a matching allow rule exists', async () => {
    const { policyRepo } = await import('../src/repos/policy.repo.js');
    vi.mocked(policyRepo.findByAction).mockResolvedValue([
      {
        id: 'rule-1',
        tenant_id: null,
        action: 'send_confirmation',
        effect: 'allow',
        conditions: { channel: 'email' },
        priority: 10,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    const { policyEngine } = await import('../src/orchestrator/policy-engine.js');
    const decision = await policyEngine.evaluate('send_confirmation', 'tenant-1', {
      channel: 'email',
    });
    expect(decision.effect).toBe('allow');
  });

  it('denies when a matching deny rule exists', async () => {
    const { policyRepo } = await import('../src/repos/policy.repo.js');
    vi.mocked(policyRepo.findByAction).mockResolvedValue([
      {
        id: 'rule-2',
        tenant_id: null,
        action: 'auto_cancel_no_show',
        effect: 'deny',
        conditions: {},
        priority: 10,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    const { policyEngine } = await import('../src/orchestrator/policy-engine.js');
    const decision = await policyEngine.evaluate('auto_cancel_no_show', 'tenant-1', {});
    expect(decision.effect).toBe('deny');
  });
});

// ── Date-Distance Confirmation Guardrail ──────────────────

describe('Date-Distance Confirmation Guardrail', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('includes guardrail text when BOOKING_FAR_DATE_CONFIRM_DAYS > 0', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 30,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any);

    expect(prompt).toContain('DATE-DISTANCE CONFIRMATION GUARDRAIL');
    expect(prompt).toContain('more than 30 days from today');
    expect(prompt).toContain('MUST ask for explicit confirmation before calling hold_slot');
    expect(prompt).toContain('Just to confirm');
  });

  it('excludes guardrail text when BOOKING_FAR_DATE_CONFIRM_DAYS = 0', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any);

    expect(prompt).not.toContain('DATE-DISTANCE CONFIRMATION GUARDRAIL');
  });

  it('uses custom threshold when configured', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 14,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any);

    expect(prompt).toContain('more than 14 days from today');
    expect(prompt).toContain('14 days or fewer from today');
  });
});

// ── Follow-Up Messaging Guardrails ────────────────────────

describe('Follow-Up Messaging Guardrails', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // ── System Prompt Tests ─────────────────────────────────

  it('system prompt includes follow-up guardrail text', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 2,
        FOLLOWUP_COOLDOWN_MINUTES: 60,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any);

    expect(prompt).toContain('FOLLOW-UP MESSAGING GUARDRAILS');
    expect(prompt).toContain('at most 2 follow-up contacts');
    expect(prompt).toContain('at least 60 minutes');
    expect(prompt).toContain('__confirmed_additional__');
    expect(prompt).toContain('CONFIRMATION_REQUIRED');
    expect(prompt).toContain('limit reached');
    expect(prompt).toContain('cooldown');
  });

  it('system prompt renders custom max and cooldown', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 5,
        FOLLOWUP_COOLDOWN_MINUTES: 30,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any);

    expect(prompt).toContain('at most 5 follow-up contacts');
    expect(prompt).toContain('at least 30 minutes');
  });

  // ── Tool Executor: Limit Enforcement ────────────────────

  it('blocks follow-up when per-session limit is reached', async () => {
    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: { evaluate: vi.fn().mockResolvedValue({ effect: 'allow', rule_id: 'r-1', action: 'send_contact_followup', reason: 'ok', evaluated_at: new Date().toISOString() }) },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/repos/followup-tracking.repo.js', () => ({
      followupTrackingRepo: {
        countBySession: vi.fn().mockResolvedValue(2),
        lastFollowupTo: vi.fn().mockResolvedValue(null),
        record: vi.fn().mockResolvedValue({}),
      },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'schedule_contact_followup',
      {
        client_name: 'Jane Doe',
        client_email: 'jane@example.com',
        preferred_contact: 'email',
        reason: 'no_availability',
      },
      'tenant-1',
      'session-1',
      mockTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Follow-up limit reached');
    expect(result.error).toContain('2 of 2');
  });

  it('emits FollowupLimitReached event when limit hit', async () => {
    const mockEmit = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: { evaluate: vi.fn().mockResolvedValue({ effect: 'allow' }) },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/repos/followup-tracking.repo.js', () => ({
      followupTrackingRepo: {
        countBySession: vi.fn().mockResolvedValue(2),
        lastFollowupTo: vi.fn().mockResolvedValue(null),
        record: vi.fn().mockResolvedValue({}),
      },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: mockEmit },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    await executeToolCall(
      'schedule_contact_followup',
      {
        client_name: 'Jane',
        client_email: 'jane@test.com',
        preferred_contact: 'email',
        reason: 'no_availability',
      },
      'tenant-1',
      'sess-1',
      mockTenant as any,
    );

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FollowupLimitReached',
        current_count: 2,
        max_allowed: 2,
      }),
    );
  });

  // ── Tool Executor: Cooldown Enforcement ─────────────────

  it('blocks follow-up during cooldown window', async () => {
    const recentTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: { evaluate: vi.fn().mockResolvedValue({ effect: 'allow' }) },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/repos/followup-tracking.repo.js', () => ({
      followupTrackingRepo: {
        countBySession: vi.fn().mockResolvedValue(0),
        lastFollowupTo: vi.fn().mockResolvedValue({ created_at: recentTime }),
        record: vi.fn().mockResolvedValue({}),
      },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'schedule_contact_followup',
      {
        client_name: 'Jane',
        client_email: 'jane@test.com',
        preferred_contact: 'email',
        reason: 'no_availability',
      },
      'tenant-1',
      'sess-1',
      mockTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('cooldown');
    expect(result.error).toContain('60 minutes');
  });

  it('emits FollowupCooldownBlocked event', async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    const mockEmit = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: { evaluate: vi.fn().mockResolvedValue({ effect: 'allow' }) },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/repos/followup-tracking.repo.js', () => ({
      followupTrackingRepo: {
        countBySession: vi.fn().mockResolvedValue(0),
        lastFollowupTo: vi.fn().mockResolvedValue({ created_at: recentTime }),
        record: vi.fn().mockResolvedValue({}),
      },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: mockEmit },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    await executeToolCall(
      'schedule_contact_followup',
      {
        client_name: 'Jane',
        client_email: 'jane@test.com',
        preferred_contact: 'sms',
        client_phone: '+15551234567',
        reason: 'no_availability',
      },
      'tenant-1',
      'sess-1',
      mockTenant as any,
    );

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'FollowupCooldownBlocked',
        cooldown_minutes: 60,
      }),
    );
  });

  // ── Tool Executor: Confirmation for Additional Contacts ──

  it('requires confirmation for second follow-up (no __confirmed_additional__)', async () => {
    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: { evaluate: vi.fn().mockResolvedValue({ effect: 'allow' }) },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-2' }) },
    }));
    vi.doMock('../src/repos/followup-tracking.repo.js', () => ({
      followupTrackingRepo: {
        countBySession: vi.fn().mockResolvedValue(1),
        lastFollowupTo: vi.fn().mockResolvedValue({ created_at: new Date(Date.now() - 120 * 60 * 1000) }),
        record: vi.fn().mockResolvedValue({}),
      },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'schedule_contact_followup',
      {
        client_name: 'Jane',
        client_email: 'jane@test.com',
        preferred_contact: 'email',
        reason: 'calendar_retry_queued',
      },
      'tenant-1',
      'sess-1',
      mockTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('CONFIRMATION_REQUIRED');
    expect(result.error).toContain('already 1 follow-up');
  });

  it('allows second follow-up when __confirmed_additional__ is in notes', async () => {
    const mockRecord = vi.fn().mockResolvedValue({});

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: { evaluate: vi.fn().mockResolvedValue({ effect: 'allow', rule_id: 'r-1', action: 'send_contact_followup', reason: 'ok', evaluated_at: new Date().toISOString() }) },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-3' }) },
    }));
    vi.doMock('../src/repos/followup-tracking.repo.js', () => ({
      followupTrackingRepo: {
        countBySession: vi.fn().mockResolvedValue(1),
        lastFollowupTo: vi.fn().mockResolvedValue({ created_at: new Date(Date.now() - 120 * 60 * 1000) }),
        record: mockRecord,
      },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'schedule_contact_followup',
      {
        client_name: 'Jane',
        client_email: 'jane@test.com',
        preferred_contact: 'email',
        reason: 'calendar_retry_queued',
        notes: 'User confirmed __confirmed_additional__',
      },
      'tenant-1',
      'sess-1',
      mockTenant as any,
    );

    expect(result.success).toBe(true);
    expect(result.data.followup_number).toBe(2);
    expect(result.data.remaining_followups).toBe(0);
    expect(mockRecord).toHaveBeenCalled();
  });

  // ── Tool Executor: Happy path within cooldown ───────────

  it('allows follow-up when cooldown has expired', async () => {
    const oldTime = new Date(Date.now() - 120 * 60 * 1000);

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: { evaluate: vi.fn().mockResolvedValue({ effect: 'allow', rule_id: 'r-1', action: 'send_contact_followup', reason: 'ok', evaluated_at: new Date().toISOString() }) },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-4' }) },
    }));
    vi.doMock('../src/repos/followup-tracking.repo.js', () => ({
      followupTrackingRepo: {
        countBySession: vi.fn().mockResolvedValue(0),
        lastFollowupTo: vi.fn().mockResolvedValue({ created_at: oldTime }),
        record: vi.fn().mockResolvedValue({}),
      },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'schedule_contact_followup',
      {
        client_name: 'Jane',
        client_email: 'jane@test.com',
        preferred_contact: 'email',
        reason: 'no_availability',
      },
      'tenant-1',
      'sess-1',
      mockTenant as any,
    );

    expect(result.success).toBe(true);
    expect(result.data.followup_number).toBe(1);
    expect(result.data.remaining_followups).toBe(1);
  });

  // ── Tool Executor: Audit logging on limit ───────────────

  it('logs audit event when limit is reached', async () => {
    const mockLog = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: { evaluate: vi.fn().mockResolvedValue({ effect: 'allow' }) },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: mockLog },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'j-1' }) },
    }));
    vi.doMock('../src/repos/followup-tracking.repo.js', () => ({
      followupTrackingRepo: {
        countBySession: vi.fn().mockResolvedValue(2),
        lastFollowupTo: vi.fn().mockResolvedValue(null),
        record: vi.fn().mockResolvedValue({}),
      },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/config/env.js', () => ({
      env: { FOLLOWUP_MAX_PER_BOOKING: 2, FOLLOWUP_COOLDOWN_MINUTES: 60 },
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    await executeToolCall(
      'schedule_contact_followup',
      {
        client_name: 'Jane',
        client_email: 'jane@test.com',
        preferred_contact: 'email',
        reason: 'no_availability',
      },
      'tenant-1',
      'sess-1',
      mockTenant as any,
    );

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'followup.limit_reached',
        entity_type: 'session',
        entity_id: 'sess-1',
        payload: expect.objectContaining({
          current_count: 2,
          max_allowed: 2,
        }),
      }),
    );
  });
});

// ── Phone Call Limitations ────────────────────────────────

describe('Phone Call Limitations', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('system prompt includes phone call limitation section', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 2,
        FOLLOWUP_COOLDOWN_MINUTES: 60,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any);

    expect(prompt).toContain('PHONE CALL LIMITATIONS');
    expect(prompt).toContain('CANNOT make, receive, or transfer phone calls');
    expect(prompt).toContain('text or email');
    expect(prompt).toContain('I can send confirmations by text or email');
  });

  it('system prompt forbids call-transfer language', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 0,
        FOLLOWUP_MAX_PER_BOOKING: 2,
        FOLLOWUP_COOLDOWN_MINUTES: 60,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any);

    expect(prompt).toContain('NEVER say: "I\'ll have someone call you"');
    expect(prompt).toContain('NEVER say: "Let me transfer you"');
  });
});

// ============================================================
// CODE-ENFORCED INVARIANTS — Guardrails 1–4
// ============================================================

// ── Guardrail 1: Ambiguous Availability Request ───────────

describe('Code-Enforced: check_availability service disambiguation', () => {
  const multiServiceTenant = {
    id: '00000000-0000-4000-a000-000000000001',
    name: 'Multi-Service Clinic',
    slug: 'multi-clinic',
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
      { name: 'Consultation', duration: 30, description: 'General consultation' },
      { name: 'Deep Tissue Massage', duration: 60, description: 'Deep tissue' },
    ],
    google_calendar_id: null,
    google_oauth_tokens: null,
    excel_integration: null,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const singleServiceTenant = {
    ...multiServiceTenant,
    name: 'Single-Service Clinic',
    slug: 'single-clinic',
    services: [{ name: 'Consultation', duration: 30, description: 'General consultation' }],
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects check_availability when tenant has >1 service and no service_name', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: { getAvailableSlots: vi.fn() },
      SlotConflictError: class extends Error {},
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {},
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      { start_date: '2026-03-10T00:00:00-05:00', end_date: '2026-03-10T23:59:59-05:00' },
      multiServiceTenant.id,
      'sess-1',
      multiServiceTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('SERVICE_REQUIRED');
    expect(result.error).toContain('Consultation');
    expect(result.error).toContain('Deep Tissue Massage');
  });

  it('allows check_availability for single-service tenant without service_name', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {
        getAvailableSlots: vi.fn().mockResolvedValue({ slots: [], verified: false }),
      },
      SlotConflictError: class extends Error {},
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {},
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      { start_date: '2026-03-10T00:00:00-05:00', end_date: '2026-03-10T23:59:59-05:00' },
      singleServiceTenant.id,
      'sess-1',
      singleServiceTenant as any,
    );

    expect(result.success).toBe(true);
  });

  it('allows check_availability for multi-service tenant WITH service_name', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: {
        getAvailableSlots: vi.fn().mockResolvedValue({ slots: [], verified: false }),
      },
      SlotConflictError: class extends Error {},
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {},
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      {
        start_date: '2026-03-10T00:00:00-05:00',
        end_date: '2026-03-10T23:59:59-05:00',
        service_name: 'Consultation',
      },
      multiServiceTenant.id,
      'sess-1',
      multiServiceTenant as any,
    );

    expect(result.success).toBe(true);
  });

  it('rejects unknown service_name', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: { getAvailableSlots: vi.fn() },
      SlotConflictError: class extends Error {},
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {},
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      {
        start_date: '2026-03-10T00:00:00-05:00',
        end_date: '2026-03-10T23:59:59-05:00',
        service_name: 'Nonexistent Service',
      },
      multiServiceTenant.id,
      'sess-1',
      multiServiceTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown service');
    expect(result.error).toContain('Nonexistent Service');
  });

  it('rejects date ranges wider than 14 days', async () => {
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: { getAvailableSlots: vi.fn() },
      SlotConflictError: class extends Error {},
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {},
    }));

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'check_availability',
      {
        start_date: '2026-03-01T00:00:00-05:00',
        end_date: '2026-03-31T23:59:59-05:00', // 30-day range
      },
      singleServiceTenant.id,
      'sess-1',
      singleServiceTenant as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('DATE_RANGE_TOO_WIDE');
    expect(result.error).toContain('14 days');
  });
});

// ── Guardrail 2: Far-Future Date Gate (Code-Enforced) ─────

describe('Code-Enforced: hold_slot far-future date gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const mockTenantSimple = {
    id: '00000000-0000-4000-a000-000000000001',
    name: 'Test Clinic',
    slug: 'test-clinic',
    timezone: 'America/New_York',
    slot_duration: 30,
    business_hours: {
      monday: { start: '09:00', end: '17:00' },
      tuesday: null, wednesday: null, thursday: null,
      friday: null, saturday: null, sunday: null,
    },
    services: [{ name: 'Consultation', duration: 30 }],
    google_calendar_id: null,
    google_oauth_tokens: null,
    excel_integration: null,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('rejects hold_slot for dates > FAR_FUTURE_DAYS without confirmation', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 30 },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: { holdSlot: vi.fn() },
      SlotConflictError: class extends Error {},
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {},
    }));

    const farDate = new Date();
    farDate.setDate(farDate.getDate() + 60);
    const farDateEnd = new Date(farDate);
    farDateEnd.setMinutes(farDateEnd.getMinutes() + 30);

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'hold_slot',
      {
        start_time: farDate.toISOString(),
        end_time: farDateEnd.toISOString(),
      },
      mockTenantSimple.id,
      'sess-1',
      mockTenantSimple as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('FAR_DATE_CONFIRMATION_REQUIRED');
    expect(result.error).toContain('far_date_confirmed=true');
  });

  it('allows hold_slot for far dates when far_date_confirmed=true', async () => {
    const mockHold = {
      id: 'hold-123',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      expires_at: new Date().toISOString(),
    };

    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 30 },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: { holdSlot: vi.fn().mockResolvedValue(mockHold) },
      SlotConflictError: class extends Error {},
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {},
    }));

    const farDate = new Date();
    farDate.setDate(farDate.getDate() + 60);
    const farDateEnd = new Date(farDate);
    farDateEnd.setMinutes(farDateEnd.getMinutes() + 30);

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'hold_slot',
      {
        start_time: farDate.toISOString(),
        end_time: farDateEnd.toISOString(),
        far_date_confirmed: true,
      },
      mockTenantSimple.id,
      'sess-1',
      mockTenantSimple as any,
    );

    expect(result.success).toBe(true);
    expect(result.data.hold_id).toBe('hold-123');
  });

  it('allows hold_slot for near-future dates without confirmation', async () => {
    const mockHold = {
      id: 'hold-456',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      expires_at: new Date().toISOString(),
    };

    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 30 },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: { holdSlot: vi.fn().mockResolvedValue(mockHold) },
      SlotConflictError: class extends Error {},
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {},
    }));

    const nearDate = new Date();
    nearDate.setDate(nearDate.getDate() + 5);
    const nearDateEnd = new Date(nearDate);
    nearDateEnd.setMinutes(nearDateEnd.getMinutes() + 30);

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'hold_slot',
      {
        start_time: nearDate.toISOString(),
        end_time: nearDateEnd.toISOString(),
      },
      mockTenantSimple.id,
      'sess-1',
      mockTenantSimple as any,
    );

    expect(result.success).toBe(true);
    expect(result.data.hold_id).toBe('hold-456');
  });

  it('skips far-date gate when BOOKING_FAR_DATE_CONFIRM_DAYS=0', async () => {
    const mockHold = {
      id: 'hold-789',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      expires_at: new Date().toISOString(),
    };

    vi.doMock('../src/config/env.js', () => ({
      env: { BOOKING_FAR_DATE_CONFIRM_DAYS: 0 },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      availabilityService: { holdSlot: vi.fn().mockResolvedValue(mockHold) },
      SlotConflictError: class extends Error {},
    }));
    vi.doMock('../src/services/booking.service.js', () => ({
      bookingService: {},
      BookingError: class extends Error {},
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {},
    }));

    const farDate = new Date();
    farDate.setDate(farDate.getDate() + 120);
    const farDateEnd = new Date(farDate);
    farDateEnd.setMinutes(farDateEnd.getMinutes() + 30);

    const { executeToolCall } = await import('../src/agent/tool-executor.js');
    const result = await executeToolCall(
      'hold_slot',
      {
        start_time: farDate.toISOString(),
        end_time: farDateEnd.toISOString(),
      },
      mockTenantSimple.id,
      'sess-1',
      mockTenantSimple as any,
    );

    expect(result.success).toBe(true);
  });
});

// ── Guardrail 3: No Premature Confirmation Language ───────

describe('Code-Enforced: response post-processor — premature confirmation', () => {
  it('strips "confirmed" language when confirm_booking was NOT used', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const inputs = [
      'Your appointment is confirmed for Monday at 10am.',
      'Your booking has been confirmed!',
      'I\'ve confirmed your appointment for next week.',
      'Your appointment has been booked successfully.',
      'You\'re all set for your visit.',
      'Successfully booked your slot.',
    ];

    for (const input of inputs) {
      const result = postProcessResponse(input, { toolsUsed: ['check_availability', 'hold_slot'] });
      expect(result).not.toMatch(/confirm(ed)?|book(ed)?|all set/i);
      expect(result).toContain('still working on finalizing');
    }
  });

  it('preserves "confirmed" language when confirm_booking WAS used', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input = 'Your appointment is confirmed for Monday at 10am.';
    const result = postProcessResponse(input, { toolsUsed: ['hold_slot', 'confirm_booking'] });

    // Should be untouched
    expect(result).toBe(input);
  });

  it('does not strip unrelated uses of "confirm"', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input = 'Can you confirm your email address for me?';
    const result = postProcessResponse(input, { toolsUsed: [] });

    // "confirm your email" does not match our patterns (which target booking/appointment confirmation)
    expect(result).toBe(input);
  });
});

// ── Guardrail 4: Forbidden Phone-Call Claims ──────────────

describe('Code-Enforced: response post-processor — phone-call claims', () => {
  it('strips phone-call claim phrases regardless of tools used', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const inputs = [
      "I'll have someone call you back shortly.",
      'Let me transfer you to a representative.',
      "I'll connect you with the doctor.",
      "I'll call you back in a few minutes.",
      'Someone will call you tomorrow morning.',
      "I'll put you through to the front desk.",
      'Let me connect you to scheduling.',
      "I'm connecting you to the team now.",
    ];

    for (const input of inputs) {
      const result = postProcessResponse(input, { toolsUsed: ['confirm_booking'] });
      expect(result).not.toMatch(/call you|transfer you|connect you|put you through|connecting you/i);
      expect(result).toContain('text or email');
    }
  });

  it('does not strip innocent uses of "call"', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input = 'Please call us at 555-1234 if you have questions.';
    const result = postProcessResponse(input, { toolsUsed: [] });

    // "call us at" doesn't match our patterns
    expect(result).toBe(input);
  });

  it('handles combined violations (confirmation + phone-call)', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input =
      "Your appointment is confirmed! I'll have someone call you to provide directions.";
    const result = postProcessResponse(input, { toolsUsed: ['hold_slot'] });

    expect(result).not.toMatch(/confirmed/i);
    expect(result).not.toMatch(/call you/i);
    expect(result).toContain('still working on finalizing');
    expect(result).toContain('text or email');
  });
});

// ── BOOKING_REQUEST System Prompt Section ─────────────────

// ── Guardrail 7: External URL / Spam Domain Stripping ─────

describe('Code-Enforced: response post-processor — external URL stripping', () => {
  it('strips hallucinated myspace.com URLs', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input = 'If you want more, visit myspace.com for details.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toMatch(/myspace\.com/i);
  });

  it('strips social media domain URLs', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const inputs = [
      'Follow us on facebook.com/gomomo',
      'Check out our page at www.instagram.com/gomomo',
      'Find us on https://twitter.com/gomomo',
      'Join us on https://www.tiktok.com/@gomomo',
    ];

    for (const input of inputs) {
      const result = postProcessResponse(input, { toolsUsed: [] });
      expect(result).not.toMatch(/facebook\.com|instagram\.com|twitter\.com|tiktok\.com/i);
    }
  });

  it('strips markdown links to external domains', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input = 'Check out [this link](https://myspace.com/profile) for more info.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toMatch(/myspace\.com/i);
    // The link text should be preserved
    expect(result).toContain('this link');
  });

  it('preserves gomomo.ai URLs', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input = 'For more information, visit [gomomo.ai](https://gomomo.ai) or email hello@gomomo.ai.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).toContain('gomomo.ai');
  });
});

// ── Guardrail 8: Broadcast/Media Sign-Off Stripping ───────

describe('Code-Enforced: response post-processor — broadcast sign-off stripping', () => {
  it('strips "thanks for watching" phrases', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const inputs = [
      'Have a great day! Thanks for watching!',
      'Thanks for watching. See you next time!',
      'Thank you for watching!',
    ];

    for (const input of inputs) {
      const result = postProcessResponse(input, { toolsUsed: [] });
      expect(result).not.toMatch(/thanks?\s+for\s+watching/i);
    }
  });

  it('strips subscribe/like phrases', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const inputs = [
      "Don't forget to subscribe!",
      'Like and subscribe for more.',
      'Hit the subscribe button.',
      'Smash that like button!',
    ];

    for (const input of inputs) {
      const result = postProcessResponse(input, { toolsUsed: [] });
      expect(result).not.toMatch(/subscribe|smash that like/i);
    }
  });

  it('strips "see you next time" phrases', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input = 'Hope this helps! See you in the next one!';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toMatch(/see you in the next/i);
  });

  it('preserves normal farewell language', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input = 'Have a wonderful day! Feel free to reach out anytime.';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).toBe(input);
  });

  it('handles combined spam: external URL + sign-off', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');

    const input = 'For more, visit myspace.com. Thanks for watching!';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).not.toMatch(/myspace\.com/i);
    expect(result).not.toMatch(/thanks for watching/i);
  });
});

describe('BOOKING_REQUEST intake form prompt section', () => {
  const mockTenant = {
    id: '00000000-0000-4000-a000-000000000001',
    name: 'Test Clinic',
    slug: 'test-clinic',
    timezone: 'America/New_York',
    business_hours: {
      monday: { start: '09:00', end: '17:00' },
      tuesday: null,
      wednesday: null,
      thursday: null,
      friday: null,
      saturday: null,
      sunday: null,
    },
    services: [{ name: 'Consultation', duration: 30, description: 'General consultation' }],
    created_at: new Date(),
    updated_at: new Date(),
  };

  beforeEach(() => {
    vi.resetModules();
  });

  it('system prompt includes BOOKING_REQUEST instructions', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        BOOKING_FAR_DATE_CONFIRM_DAYS: 30,
        FOLLOWUP_MAX_PER_BOOKING: 2,
        FOLLOWUP_COOLDOWN_MINUTES: 60,
      },
    }));
    vi.doMock('../src/services/availability.service.js', () => ({
      isDemoAvailabilityActive: () => false,
    }));

    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant as any);

    expect(prompt).toContain('STRUCTURED BOOKING REQUEST (INTAKE FORM)');
    expect(prompt).toContain('BOOKING_REQUEST:');
    expect(prompt).toContain('service=<service>; duration=<minutes>; name=<name>; email=<email>; phone=<phone>');
    expect(prompt).toContain('Do NOT ask the user to re-enter any of these fields');
    expect(prompt).toContain('Skip directly to checking availability');
  });

  it('BOOKING_REQUEST format is parseable', () => {
    // Mirrors the structured message the IntakeForm submits (with duration + comment)
    const message = 'BOOKING_REQUEST: service=Follow-up Appointment; duration=45; name=Jane Smith; email=jane@example.com; phone=(555) 123-4567; comment=First visit';

    expect(message.startsWith('BOOKING_REQUEST:')).toBe(true);

    // Simple parse (the AI agent parses this via NLU, but verify the format is clean)
    const payload = message.replace('BOOKING_REQUEST:', '').trim();
    const fields: Record<string, string> = {};
    for (const part of payload.split(';')) {
      const [key, ...rest] = part.split('=');
      if (key && rest.length) fields[key.trim()] = rest.join('=').trim();
    }

    expect(fields.service).toBe('Follow-up Appointment');
    expect(fields.duration).toBe('45');
    expect(fields.name).toBe('Jane Smith');
    expect(fields.email).toBe('jane@example.com');
    expect(fields.phone).toBe('(555) 123-4567');
    expect(fields.comment).toBe('First visit');
  });
});
