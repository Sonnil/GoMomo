// ============================================================
// Workflow Tests — Phase 27 Autonomous Workflows
//
// Tests for the four workflows:
//  A) Hold Expiry Follow-up
//  B) Waitlist (SlotOpened → notify)
//  C) Calendar Retry enhancement (exponential backoff + escalation)
//  D) Reminders (24h + 2h)
//
// Also verifies:
//  - New registered tools exist
//  - New policy rules gate actions
//  - New domain events fire correctly
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Workflow A: Hold Expiry Follow-up ─────────────────────

describe('Workflow A — Hold Expiry Follow-up', () => {
  beforeEach(() => {
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'sess-1',
          metadata: { client_email: 'test@example.com', client_name: 'Jane' },
        }),
      },
    }));
    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({ effect: 'allow', rule_id: 'r-1', action: 'hold_followup', reason: 'allowed', evaluated_at: new Date().toISOString() }),
      },
    }));
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [{ count: '0' }] }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('enqueues send_hold_followup when session has contact info', async () => {
    const { onHoldExpired } = await import('../src/orchestrator/handlers/on-hold-expired.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    await onHoldExpired({
      name: 'HoldExpired',
      tenant_id: 'tenant-1',
      hold_id: 'hold-1',
      session_id: 'sess-1',
      slot_start: '2026-02-10T10:00:00Z',
      slot_end: '2026-02-10T10:30:00Z',
      timestamp: new Date().toISOString(),
    });

    expect(jobRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'send_hold_followup',
        payload: expect.objectContaining({
          client_email: 'test@example.com',
          session_id: 'sess-1',
        }),
      }),
    );
  });

  it('skips follow-up when no session_id', async () => {
    const { onHoldExpired } = await import('../src/orchestrator/handlers/on-hold-expired.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    await onHoldExpired({
      name: 'HoldExpired',
      tenant_id: 'tenant-1',
      hold_id: 'hold-1',
      session_id: '',
      slot_start: '2026-02-10T10:00:00Z',
      slot_end: '2026-02-10T10:30:00Z',
      timestamp: new Date().toISOString(),
    });

    expect(jobRepo.create).not.toHaveBeenCalled();
  });

  it('skips follow-up during cooldown', async () => {
    // Override cooldown check to return existing recent job
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [{ count: '1' }] }),
    }));

    const { onHoldExpired } = await import('../src/orchestrator/handlers/on-hold-expired.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    await onHoldExpired({
      name: 'HoldExpired',
      tenant_id: 'tenant-1',
      hold_id: 'hold-1',
      session_id: 'sess-1',
      slot_start: '2026-02-10T10:00:00Z',
      slot_end: '2026-02-10T10:30:00Z',
      timestamp: new Date().toISOString(),
    });

    expect(jobRepo.create).not.toHaveBeenCalled();
  });

  it('skips follow-up when policy denies', async () => {
    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({ effect: 'deny', rule_id: null, action: 'hold_followup', reason: 'denied', evaluated_at: new Date().toISOString() }),
      },
    }));

    const { onHoldExpired } = await import('../src/orchestrator/handlers/on-hold-expired.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    await onHoldExpired({
      name: 'HoldExpired',
      tenant_id: 'tenant-1',
      hold_id: 'hold-1',
      session_id: 'sess-1',
      slot_start: '2026-02-10T10:00:00Z',
      slot_end: '2026-02-10T10:30:00Z',
      timestamp: new Date().toISOString(),
    });

    expect(jobRepo.create).not.toHaveBeenCalled();
  });
});

// ── Workflow B: Waitlist + Slot Opened ────────────────────

describe('Workflow B — Waitlist Notification', () => {
  beforeEach(() => {
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({ effect: 'allow', rule_id: 'r-2', action: 'waitlist_notify', reason: 'allowed', evaluated_at: new Date().toISOString() }),
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('enqueues waitlist notification when matching entries exist', async () => {
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {
        findWaiting: vi.fn().mockResolvedValue([
          {
            id: 'wl-1',
            client_email: 'waitlist@example.com',
            client_name: 'Waiter',
            preferred_days: [],
            preferred_time_range: null,
          },
        ]),
      },
    }));

    const { onSlotOpened } = await import('../src/orchestrator/handlers/on-slot-opened.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    await onSlotOpened({
      name: 'SlotOpened',
      tenant_id: 'tenant-1',
      slot_start: '2026-02-10T10:00:00Z',
      slot_end: '2026-02-10T10:30:00Z',
      service: 'Consultation',
      reason: 'cancellation',
      timestamp: new Date().toISOString(),
    });

    expect(jobRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'send_waitlist_notification',
        payload: expect.objectContaining({
          waitlist_entry_id: 'wl-1',
          client_email: 'waitlist@example.com',
        }),
      }),
    );
  });

  it('skips when no waitlist entries match', async () => {
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: {
        findWaiting: vi.fn().mockResolvedValue([]),
      },
    }));

    const { onSlotOpened } = await import('../src/orchestrator/handlers/on-slot-opened.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    await onSlotOpened({
      name: 'SlotOpened',
      tenant_id: 'tenant-1',
      slot_start: '2026-02-10T10:00:00Z',
      slot_end: '2026-02-10T10:30:00Z',
      service: null,
      reason: 'cancellation',
      timestamp: new Date().toISOString(),
    });

    expect(jobRepo.create).not.toHaveBeenCalled();
  });
});

// ── Workflow C: Calendar Write Retry (Exponential Backoff) ────────────

describe('Workflow C — Calendar Retry with Exponential Backoff', () => {
  beforeEach(() => {
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({ effect: 'allow', rule_id: 'r-5', action: 'retry_calendar_sync', reason: 'allowed', evaluated_at: new Date().toISOString() }),
      },
    }));
    vi.doMock('../src/orchestrator/event-bus.js', () => ({
      eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
      DomainEventBus: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('schedules retry with 30s delay on first failure', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [{ count: '0' }] }),
    }));

    const { onCalendarWriteFailed } = await import('../src/orchestrator/handlers/on-calendar-write-failed.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    const before = Date.now();
    await onCalendarWriteFailed({
      name: 'CalendarWriteFailed',
      tenant_id: 'tenant-1',
      appointment_id: 'apt-1',
      reference_code: 'APT-TEST',
      session_id: null,
      error: 'Google API 503',
      timestamp: new Date().toISOString(),
    });

    expect(jobRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'retry_calendar_sync',
        payload: expect.objectContaining({ appointment_id: 'apt-1' }),
      }),
    );

    // Verify ~30s backoff
    const runAt = (jobRepo.create as any).mock.calls[0][0].run_at;
    const delayMs = runAt.getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(29_000);
    expect(delayMs).toBeLessThan(35_000);
  });

  it('schedules retry with 120s delay on second failure', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [{ count: '1' }] }),
    }));

    const { onCalendarWriteFailed } = await import('../src/orchestrator/handlers/on-calendar-write-failed.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    const before = Date.now();
    await onCalendarWriteFailed({
      name: 'CalendarWriteFailed',
      tenant_id: 'tenant-1',
      appointment_id: 'apt-1',
      reference_code: 'APT-TEST',
      session_id: null,
      error: 'Google API 503',
      timestamp: new Date().toISOString(),
    });

    const runAt = (jobRepo.create as any).mock.calls[0][0].run_at;
    const delayMs = runAt.getTime() - before;
    expect(delayMs).toBeGreaterThanOrEqual(119_000);
    expect(delayMs).toBeLessThan(125_000);
  });

  it('emits CalendarRetryExhausted when max retries reached', async () => {
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [{ count: '3' }] }),
    }));

    const { onCalendarWriteFailed } = await import('../src/orchestrator/handlers/on-calendar-write-failed.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');
    const { eventBus } = await import('../src/orchestrator/event-bus.js');

    await onCalendarWriteFailed({
      name: 'CalendarWriteFailed',
      tenant_id: 'tenant-1',
      appointment_id: 'apt-1',
      reference_code: 'APT-TEST',
      session_id: null,
      error: 'Google API 503',
      timestamp: new Date().toISOString(),
    });

    // Should NOT create a retry job
    expect(jobRepo.create).not.toHaveBeenCalled();

    // Should emit escalation (via setImmediate — flush microtasks)
    await new Promise((r) => setTimeout(r, 10));
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'CalendarRetryExhausted',
        appointment_id: 'apt-1',
      }),
    );
  });
});

// ── Workflow C: Calendar Retry Exhausted Escalation ─────────────────

describe('Workflow C — Calendar Retry Exhausted Escalation', () => {
  beforeEach(() => {
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({ effect: 'allow', rule_id: 'r-3', action: 'escalate_calendar_failure', reason: 'allowed', evaluated_at: new Date().toISOString() }),
      },
    }));
    vi.doMock('../src/stores/booking-store-factory.js', () => ({
      getDefaultStore: vi.fn().mockReturnValue({
        findById: vi.fn().mockResolvedValue({
          id: 'apt-1',
          client_email: 'client@example.com',
          client_name: 'Test User',
        }),
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('enqueues escalation when retries exhausted', async () => {
    const { onCalendarRetryExhausted } = await import('../src/orchestrator/handlers/on-calendar-retry-exhausted.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    await onCalendarRetryExhausted({
      name: 'CalendarRetryExhausted',
      tenant_id: 'tenant-1',
      appointment_id: 'apt-1',
      reference_code: 'APT-TEST',
      attempts: 3,
      last_error: 'Google API timeout',
      timestamp: new Date().toISOString(),
    });

    expect(jobRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'escalate_calendar_failure',
        payload: expect.objectContaining({
          appointment_id: 'apt-1',
          reference_code: 'APT-TEST',
          client_email: 'client@example.com',
        }),
      }),
    );
  });
});

// ── Workflow D: 2h Reminder ──────────────────────────────

describe('Workflow D — 2h Reminder', () => {
  beforeEach(() => {
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/job.repo.js', () => ({
      jobRepo: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
    }));
    vi.doMock('../src/orchestrator/policy-engine.js', () => ({
      policyEngine: {
        evaluate: vi.fn().mockResolvedValue({ effect: 'allow', rule_id: 'r-4', action: 'send_reminder', reason: 'allowed', evaluated_at: new Date().toISOString() }),
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('enqueues both 24h and 2h reminders for future bookings', async () => {
    const { onBookingCreated } = await import('../src/orchestrator/handlers/on-booking-created.js');
    const { jobRepo } = await import('../src/repos/job.repo.js');

    // Create a booking 3 days in the future
    const futureStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const futureEnd = new Date(futureStart.getTime() + 30 * 60 * 1000);

    await onBookingCreated({
      name: 'BookingCreated',
      tenant_id: 'tenant-1',
      appointment: {
        id: 'apt-1',
        tenant_id: 'tenant-1',
        reference_code: 'APT-TEST',
        client_name: 'Test User',
        client_email: 'test@example.com',
        client_phone: null,
        client_notes: null,
        service: 'Consultation',
        start_time: futureStart,
        end_time: futureEnd,
        timezone: 'America/New_York',
        status: 'confirmed',
        google_event_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      session_id: 'sess-1',
      timestamp: new Date().toISOString(),
    });

    const calls = (jobRepo.create as any).mock.calls;

    // Should have 3 jobs: confirmation, 24h reminder, 2h reminder
    expect(calls).toHaveLength(3);

    // Confirmation
    expect(calls[0][0]).toMatchObject({ type: 'send_confirmation' });

    // 24h reminder
    expect(calls[1][0]).toMatchObject({
      type: 'send_reminder',
      payload: expect.objectContaining({ reminder_type: '24h' }),
    });

    // 2h reminder
    expect(calls[2][0]).toMatchObject({
      type: 'send_reminder',
      payload: expect.objectContaining({ reminder_type: '2h' }),
    });
  });
});

// ── Registered Tools ─────────────────────────────────────

describe('Phase 27 Registered Tools', () => {
  beforeEach(() => {
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }));
    vi.doMock('../src/repos/waitlist.repo.js', () => ({
      waitlistRepo: { updateStatus: vi.fn().mockResolvedValue(undefined) },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('has all workflow tools registered', async () => {
    const { listRegisteredTools } = await import('../src/orchestrator/registered-tools.js');
    const tools = listRegisteredTools();

    // Phase 26 tools
    expect(tools).toContain('send_confirmation');
    expect(tools).toContain('send_cancellation');
    expect(tools).toContain('retry_calendar_sync');
    expect(tools).toContain('send_reminder');

    // Phase 27 tools
    expect(tools).toContain('send_hold_followup');
    expect(tools).toContain('send_waitlist_notification');
    expect(tools).toContain('escalate_calendar_failure');
  });
});

// ── Domain Events ────────────────────────────────────────

describe('Phase 27 Domain Events', () => {
  beforeEach(() => {
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    // Re-expose the real event-bus (previous test mocked it)
    vi.doMock('../src/orchestrator/event-bus.js', async (importOriginal) => {
      const actual = await importOriginal() as any;
      return { ...actual };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('DomainEventBus accepts new event types', async () => {
    const { DomainEventBus } = await import('../src/orchestrator/event-bus.js');
    const bus = new DomainEventBus();
    const received: any[] = [];

    bus.on('SlotOpened', async (event: any) => received.push(event));
    bus.on('CalendarRetryExhausted', async (event: any) => received.push(event));

    await bus.emit({
      name: 'SlotOpened',
      tenant_id: 'tenant-1',
      slot_start: '2026-02-10T10:00:00Z',
      slot_end: '2026-02-10T10:30:00Z',
      service: null,
      reason: 'cancellation',
      timestamp: new Date().toISOString(),
    });

    await bus.emit({
      name: 'CalendarRetryExhausted',
      tenant_id: 'tenant-1',
      appointment_id: 'apt-1',
      reference_code: 'APT-TEST',
      attempts: 3,
      last_error: 'error',
      timestamp: new Date().toISOString(),
    });

    expect(received).toHaveLength(2);
    expect(received[0].name).toBe('SlotOpened');
    expect(received[1].name).toBe('CalendarRetryExhausted');
  });
});
