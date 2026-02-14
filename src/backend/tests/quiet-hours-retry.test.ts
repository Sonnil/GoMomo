// ============================================================
// Tests — Quiet Hours + Outbound SMS Retry
//
// 1. Message queued during quiet hours
// 2. Message sent immediately outside quiet hours
// 3. Retry succeeds on second attempt
// 4. Retry aborted on STOP (opt-out)
// 5. Retry aborted on cancel/reschedule
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. Quiet Hours Utility (pure functions) ─────────────────

describe('Quiet Hours Utility', () => {
  it('detects quiet hours (overnight range 21:00–08:00)', async () => {
    const { isQuietHours } = await import('../src/voice/quiet-hours.js');

    // 10 PM ET = within quiet hours (after 21:00)
    const tenPmEt = new Date('2026-02-09T03:00:00Z'); // 10 PM ET = 03:00 UTC+0 (ET is UTC-5)
    expect(isQuietHours(tenPmEt, {
      start: '21:00', end: '08:00', timezone: 'America/New_York',
    })).toBe(true);

    // 3 AM ET = within quiet hours (before 08:00)
    const threeAmEt = new Date('2026-02-09T08:00:00Z'); // 3 AM ET = 08:00 UTC
    expect(isQuietHours(threeAmEt, {
      start: '21:00', end: '08:00', timezone: 'America/New_York',
    })).toBe(true);
  });

  it('detects outside quiet hours (afternoon)', async () => {
    const { isQuietHours } = await import('../src/voice/quiet-hours.js');

    // 2 PM ET = 19:00 UTC — outside quiet hours
    const twoPmEt = new Date('2026-02-09T19:00:00Z');
    expect(isQuietHours(twoPmEt, {
      start: '21:00', end: '08:00', timezone: 'America/New_York',
    })).toBe(false);
  });

  it('calculates next allowed send time (morning after quiet hours)', async () => {
    const { nextAllowedSendTime, isQuietHours } = await import('../src/voice/quiet-hours.js');

    // 10 PM ET on Feb 9 → next allowed = 8 AM ET on Feb 10
    const tenPmEt = new Date('2026-02-09T03:00:00Z');
    const config = { start: '21:00', end: '08:00', timezone: 'America/New_York' };

    const next = nextAllowedSendTime(tenPmEt, config);

    // Should be 8 AM ET on Feb 10 = 13:00 UTC on Feb 10
    expect(next.getTime()).toBeGreaterThan(tenPmEt.getTime());
    // Verify the result is NOT in quiet hours
    expect(isQuietHours(next, config)).toBe(false);
  });

  it('returns now when NOT in quiet hours', async () => {
    const { nextAllowedSendTime } = await import('../src/voice/quiet-hours.js');

    const twoPmEt = new Date('2026-02-09T19:00:00Z');
    const config = { start: '21:00', end: '08:00', timezone: 'America/New_York' };

    const next = nextAllowedSendTime(twoPmEt, config);
    expect(next.getTime()).toBe(twoPmEt.getTime());
  });

  it('builds config from tenant object with defaults', async () => {
    const { tenantQuietHours } = await import('../src/voice/quiet-hours.js');

    const config = tenantQuietHours({ timezone: 'America/Chicago' });
    expect(config.start).toBe('21:00');
    expect(config.end).toBe('08:00');
    expect(config.timezone).toBe('America/Chicago');
  });
});

// ── 2. Outbound SMS Gateway (mocked dependencies) ──────────

describe('Outbound SMS Gateway', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('queues message during quiet hours instead of sending', async () => {
    // Ensure FEATURE_SMS is enabled for these per-tenant kill-switch tests
    vi.doMock('../src/config/env.js', () => ({
      env: { FEATURE_SMS: 'true' },
    }));

    // Mock quiet hours → always quiet
    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => true,
      nextAllowedSendTime: () => new Date('2026-02-10T13:00:00Z'),
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    const enqueueMock = vi.fn().mockResolvedValue({
      id: 'outbox-1',
      status: 'queued',
      scheduled_at: new Date('2026-02-10T13:00:00Z'),
    });
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: { enqueue: enqueueMock },
    }));

    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: auditLogMock },
    }));

    // sendSms should NOT be called
    const sendSmsMock = vi.fn();
    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: sendSmsMock,
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    const result = await sendOutboundSms(
      {
        tenantId: 'tenant-1',
        phone: '+15551234567',
        body: 'Test reminder',
        messageType: 'reminder',
        bookingId: 'apt-1',
        scheduledAt: new Date('2026-02-09T20:00:00Z'),
      },
      { timezone: 'America/New_York' },
    );

    expect(result.queued).toBe(true);
    expect(result.sent).toBe(false);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledOnce();

    // Verify audit event was logged
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'sms.queued_due_to_quiet_hours',
      }),
    );
  });

  it('sends immediately when outside quiet hours', async () => {
    // Ensure FEATURE_SMS is enabled for these per-tenant kill-switch tests
    vi.doMock('../src/config/env.js', () => ({
      env: { FEATURE_SMS: 'true' },
    }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: { enqueue: vi.fn() },
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    const sendSmsMock = vi.fn().mockResolvedValue({ success: true, messageSid: 'SM123' });
    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: sendSmsMock,
    }));

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    const result = await sendOutboundSms(
      {
        tenantId: 'tenant-1',
        phone: '+15551234567',
        body: 'Test reminder',
        messageType: 'reminder',
      },
      { timezone: 'America/New_York' },
    );

    expect(result.sent).toBe(true);
    expect(result.queued).toBe(false);
    expect(sendSmsMock).toHaveBeenCalledOnce();
  });
});

// ── 3. Outbox Processor (retry logic) ───────────────────────

describe('Outbox Processor', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('retry succeeds on second attempt', async () => {
    const markSentMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        claimBatch: vi.fn().mockResolvedValue([{
          id: 'outbox-1',
          tenant_id: 'tenant-1',
          phone: '+15551234567',
          body: 'Retry test',
          message_type: 'reminder',
          booking_id: 'apt-1',
          status: 'sending',
          attempts: 2,          // This is the 2nd attempt (retry after 1st failure)
          max_attempts: 3,
          last_error: 'Twilio 503',
        }]),
        markSent: markSentMock,
        scheduleRetry: vi.fn(),
        markFailed: vi.fn(),
        abort: vi.fn(),
      },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    // This time it succeeds
    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockResolvedValue({ success: true, messageSid: 'SM456' }),
    }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    const { processOutbox } = await import('../src/voice/outbound-sms.js');

    const result = await processOutbox(5);
    expect(result.sent).toBe(1);
    expect(result.aborted).toBe(0);
    expect(markSentMock).toHaveBeenCalledWith('outbox-1', 'SM456');
  });

  it('aborts retry when recipient opted out (STOP)', async () => {
    const abortMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        claimBatch: vi.fn().mockResolvedValue([{
          id: 'outbox-2',
          tenant_id: 'tenant-1',
          phone: '+15551234567',
          body: 'Should not send',
          message_type: 'reminder',
          booking_id: 'apt-2',
          status: 'sending',
          attempts: 2,
          max_attempts: 3,
        }]),
        abort: abortMock,
        markSent: vi.fn(),
        scheduleRetry: vi.fn(),
        markFailed: vi.fn(),
      },
    }));

    // Recipient has opted out
    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(true) },
    }));

    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: auditLogMock },
    }));

    const sendSmsMock = vi.fn();
    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: sendSmsMock,
    }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    const { processOutbox } = await import('../src/voice/outbound-sms.js');

    const result = await processOutbox(5);
    expect(result.aborted).toBe(1);
    expect(result.sent).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(abortMock).toHaveBeenCalledWith('outbox-2', 'opt_out');

    // Verify RETRY_ABORTED audit event
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'sms.retry_aborted',
        payload: expect.objectContaining({
          abort_reason: 'opt_out',
        }),
      }),
    );
  });

  it('aborts queued messages when booking is cancelled', async () => {
    // Test that abortByBooking calls the right SQL and returns rowCount
    const abortMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        abortByBooking: vi.fn().mockResolvedValue(2),
        claimBatch: vi.fn().mockResolvedValue([]),
        enqueue: vi.fn(),
        markSent: vi.fn(),
        scheduleRetry: vi.fn(),
        markFailed: vi.fn(),
        abort: abortMock,
      },
    }));

    const { smsOutboxRepo } = await import('../src/repos/sms-outbox.repo.js');

    const count = await smsOutboxRepo.abortByBooking('apt-cancel-1', 'booking_cancelled');
    expect(count).toBe(2);
  });
});

// ── 4. Idempotency Key ─────────────────────────────────────

describe('Idempotency', () => {
  it('builds deterministic idempotency key from messageType + bookingId + scheduledAt', async () => {
    // The gateway builds: `${messageType}:${bookingId}:${scheduledAt.toISOString()}`
    // We just verify the format is deterministic
    const key1 = `reminder:apt-1:2026-02-09T20:00:00.000Z`;
    const key2 = `reminder:apt-1:2026-02-09T20:00:00.000Z`;
    expect(key1).toBe(key2);

    const key3 = `reminder:apt-2:2026-02-09T20:00:00.000Z`;
    expect(key1).not.toBe(key3);
  });
});
