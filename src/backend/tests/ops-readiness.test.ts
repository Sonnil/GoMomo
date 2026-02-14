// ============================================================
// Tests — Pilot Operational Readiness Controls + Telemetry
//
// 1. Kill switch: sms_outbound_enabled blocks all sends
// 2. Kill switch: sms_retry_enabled blocks retries
// 3. Kill switch: sms_quiet_hours_enabled skips quiet-hours
// 4. Metrics: counters increment on each event type
// 5. Metrics: snapshot returns all keys
// 6. Health endpoint shape (integration-light)
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. SMS Metrics Module ───────────────────────────────────

describe('SMS Metrics', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('increments individual counters', async () => {
    const { smsMetricInc, smsMetricGet, smsMetricsReset } = await import(
      '../src/voice/sms-metrics.js'
    );
    smsMetricsReset();

    smsMetricInc('sent');
    smsMetricInc('sent');
    smsMetricInc('failed');
    smsMetricInc('queued', 3);

    expect(smsMetricGet('sent')).toBe(2);
    expect(smsMetricGet('failed')).toBe(1);
    expect(smsMetricGet('queued')).toBe(3);
    expect(smsMetricGet('help')).toBe(0);
  });

  it('snapshot returns all 14 metric keys', async () => {
    const { smsMetricsSnapshot, smsMetricsReset } = await import(
      '../src/voice/sms-metrics.js'
    );
    smsMetricsReset();

    const snap = smsMetricsSnapshot();
    const keys = Object.keys(snap);

    expect(keys).toContain('sent');
    expect(keys).toContain('failed');
    expect(keys).toContain('queued');
    expect(keys).toContain('retry_scheduled');
    expect(keys).toContain('retry_succeeded');
    expect(keys).toContain('retry_aborted');
    expect(keys).toContain('blocked_outbound_disabled');
    expect(keys).toContain('blocked_retry_disabled');
    expect(keys).toContain('blocked_quiet_hours_disabled');
    expect(keys).toContain('help');
    expect(keys).toContain('stop');
    expect(keys).toContain('start');
    expect(keys).toContain('booking_web');
    expect(keys).toContain('booking_sms');
    expect(keys).toContain('confirmation_sent');
    expect(keys).toContain('confirmation_failed');
    expect(keys.length).toBe(16);
  });

  it('reset clears all counters to zero', async () => {
    const { smsMetricInc, smsMetricsSnapshot, smsMetricsReset } = await import(
      '../src/voice/sms-metrics.js'
    );
    smsMetricInc('sent', 10);
    smsMetricInc('stop', 5);

    smsMetricsReset();

    const snap = smsMetricsSnapshot();
    for (const val of Object.values(snap)) {
      expect(val).toBe(0);
    }
  });
});

// ── 2. Kill Switch: sms_outbound_enabled ────────────────────

describe('Kill Switch — sms_outbound_enabled', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('blocks send when sms_outbound_enabled=false', async () => {
    vi.doMock('../src/config/env.js', () => ({ env: { FEATURE_SMS: 'true' } }));

    // Mock quiet hours → not quiet (shouldn't matter — outbound blocked first)
    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: { enqueue: vi.fn() },
    }));

    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: auditLogMock },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    const sendSmsMock = vi.fn();
    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: sendSmsMock,
    }));

    // Reset metrics before test
    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    const result = await sendOutboundSms(
      {
        tenantId: 'tenant-1',
        phone: '+15551234567',
        body: 'Should not send',
        messageType: 'reminder',
        bookingId: 'apt-1',
      },
      {
        timezone: 'America/New_York',
        sms_outbound_enabled: false,          // ← KILL SWITCH
      },
    );

    expect(result.sent).toBe(false);
    expect(result.queued).toBe(false);
    expect(result.error).toBe('sms_outbound_disabled');
    expect(sendSmsMock).not.toHaveBeenCalled();

    // Audit event logged
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'sms.blocked_outbound_disabled',
      }),
    );

    // Metric incremented
    expect(smsMetricGet('blocked_outbound_disabled')).toBe(1);
  });

  it('allows send when sms_outbound_enabled=true (default)', async () => {
    vi.doMock('../src/config/env.js', () => ({ env: { FEATURE_SMS: 'true' } }));

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

    const sendSmsMock = vi.fn().mockResolvedValue({ success: true, messageSid: 'SM100' });
    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: sendSmsMock,
    }));

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    const result = await sendOutboundSms(
      {
        tenantId: 'tenant-1',
        phone: '+15551234567',
        body: 'Should send fine',
        messageType: 'reminder',
      },
      {
        timezone: 'America/New_York',
        sms_outbound_enabled: true,
      },
    );

    expect(result.sent).toBe(true);
    expect(sendSmsMock).toHaveBeenCalledOnce();
  });
});

// ── 3. Kill Switch: sms_retry_enabled ───────────────────────

describe('Kill Switch — sms_retry_enabled', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('blocks retry on transport failure when sms_retry_enabled=false', async () => {
    vi.doMock('../src/config/env.js', () => ({ env: { FEATURE_SMS: 'true' } }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    const enqueueMock = vi.fn();
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: { enqueue: enqueueMock },
    }));

    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: auditLogMock },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    // Transport failure
    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockResolvedValue({
        success: false,
        error: 'Twilio 503',
        optedOut: false,
        rateLimited: false,
      }),
    }));

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    const result = await sendOutboundSms(
      {
        tenantId: 'tenant-1',
        phone: '+15551234567',
        body: 'Will fail to send',
        messageType: 'confirmation',
      },
      {
        timezone: 'America/New_York',
        sms_retry_enabled: false,             // ← KILL SWITCH
      },
    );

    expect(result.sent).toBe(false);
    expect(result.queued).toBe(false);
    expect(result.error).toBe('Twilio 503');
    expect(enqueueMock).not.toHaveBeenCalled();

    // Audit event
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'sms.blocked_retry_disabled',
      }),
    );

    // Metrics
    expect(smsMetricGet('blocked_retry_disabled')).toBe(1);
    expect(smsMetricGet('failed')).toBe(1);
  });

  it('processOutbox aborts retry entries when sms_retry_enabled=false', async () => {
    const abortMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        claimBatch: vi.fn().mockResolvedValue([{
          id: 'outbox-retry-1',
          tenant_id: 'tenant-1',
          phone: '+15551234567',
          body: 'Retry message',
          message_type: 'reminder',
          booking_id: 'apt-5',
          status: 'sending',
          attempts: 2,          // 2nd attempt = retry
          max_attempts: 3,
        }]),
        abort: abortMock,
        markSent: vi.fn(),
        scheduleRetry: vi.fn(),
        markFailed: vi.fn(),
      },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
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

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { processOutbox } = await import('../src/voice/outbound-sms.js');

    const result = await processOutbox(5, async () => ({
      timezone: 'America/New_York',
      sms_retry_enabled: false,               // ← KILL SWITCH
    }));

    expect(result.aborted).toBe(1);
    expect(result.sent).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(abortMock).toHaveBeenCalledWith('outbox-retry-1', 'retry_disabled');

    // Metrics
    expect(smsMetricGet('retry_aborted')).toBe(1);
    expect(smsMetricGet('blocked_retry_disabled')).toBe(1);
  });
});

// ── 4. Kill Switch: sms_quiet_hours_enabled ─────────────────

describe('Kill Switch — sms_quiet_hours_enabled', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('sends immediately during quiet hours when sms_quiet_hours_enabled=false', async () => {
    vi.doMock('../src/config/env.js', () => ({ env: { FEATURE_SMS: 'true' } }));

    // Mock quiet hours → would be quiet, but kill switch overrides
    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => true,               // Would be quiet...
      nextAllowedSendTime: () => new Date('2026-02-10T13:00:00Z'),
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    const enqueueMock = vi.fn();
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: { enqueue: enqueueMock },
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    const sendSmsMock = vi.fn().mockResolvedValue({ success: true, messageSid: 'SM200' });
    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: sendSmsMock,
    }));

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    const result = await sendOutboundSms(
      {
        tenantId: 'tenant-1',
        phone: '+15551234567',
        body: 'Urgent message',
        messageType: 'reminder',
      },
      {
        timezone: 'America/New_York',
        sms_quiet_hours_enabled: false,       // ← KILL SWITCH
      },
    );

    // Should send immediately — NOT queued
    expect(result.sent).toBe(true);
    expect(result.queued).toBe(false);
    expect(sendSmsMock).toHaveBeenCalledOnce();
    expect(enqueueMock).not.toHaveBeenCalled();

    // Metric: sent, NOT queued
    expect(smsMetricGet('sent')).toBe(1);
    expect(smsMetricGet('queued')).toBe(0);
  });

  it('processOutbox skips quiet hours re-enter when sms_quiet_hours_enabled=false', async () => {
    const markSentMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        claimBatch: vi.fn().mockResolvedValue([{
          id: 'outbox-qh-1',
          tenant_id: 'tenant-1',
          phone: '+15551234567',
          body: 'Should send despite quiet hours',
          message_type: 'reminder',
          booking_id: 'apt-6',
          status: 'sending',
          attempts: 1,
          max_attempts: 3,
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

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockResolvedValue({ success: true, messageSid: 'SM300' }),
    }));

    // Even though it's quiet hours, the kill switch should skip the check
    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => true,               // Would be quiet...
      nextAllowedSendTime: () => new Date('2026-02-10T13:00:00Z'),
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    const { processOutbox } = await import('../src/voice/outbound-sms.js');

    const result = await processOutbox(5, async () => ({
      timezone: 'America/New_York',
      sms_quiet_hours_enabled: false,         // ← KILL SWITCH
    }));

    // Should send — NOT re-queued for quiet hours
    expect(result.sent).toBe(1);
    expect(result.aborted).toBe(0);
    expect(markSentMock).toHaveBeenCalledWith('outbox-qh-1', 'SM300');
  });
});

// ── 5. Outbound disabled in processOutbox ───────────────────

describe('Kill Switch — sms_outbound_enabled in processOutbox', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('aborts all queued entries when sms_outbound_enabled=false at process time', async () => {
    const abortMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        claimBatch: vi.fn().mockResolvedValue([
          {
            id: 'outbox-a',
            tenant_id: 'tenant-1',
            phone: '+15551234567',
            body: 'Msg A',
            message_type: 'reminder',
            booking_id: 'apt-7',
            status: 'sending',
            attempts: 1,
            max_attempts: 3,
          },
          {
            id: 'outbox-b',
            tenant_id: 'tenant-1',
            phone: '+15559876543',
            body: 'Msg B',
            message_type: 'confirmation',
            booking_id: 'apt-8',
            status: 'sending',
            attempts: 1,
            max_attempts: 3,
          },
        ]),
        abort: abortMock,
        markSent: vi.fn(),
        scheduleRetry: vi.fn(),
        markFailed: vi.fn(),
      },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
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

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { processOutbox } = await import('../src/voice/outbound-sms.js');

    const result = await processOutbox(5, async () => ({
      timezone: 'America/New_York',
      sms_outbound_enabled: false,            // ← KILL SWITCH
    }));

    expect(result.aborted).toBe(2);
    expect(result.sent).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(abortMock).toHaveBeenCalledTimes(2);

    expect(smsMetricGet('retry_aborted')).toBe(2);
    expect(smsMetricGet('blocked_outbound_disabled')).toBe(2);
  });
});

// ── 6. Metrics wiring — sendOutboundSms paths ──────────────

describe('Metrics wiring — sendOutboundSms', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('increments "sent" on successful send', async () => {
    vi.doMock('../src/config/env.js', () => ({ env: { FEATURE_SMS: 'true' } }));

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

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockResolvedValue({ success: true, messageSid: 'SM400' }),
    }));

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    await sendOutboundSms(
      { tenantId: 't', phone: '+15550001111', body: 'hi', messageType: 'reminder' },
      { timezone: 'America/New_York' },
    );

    expect(smsMetricGet('sent')).toBe(1);
    expect(smsMetricGet('failed')).toBe(0);
    expect(smsMetricGet('queued')).toBe(0);
  });

  it('increments "queued" during quiet hours', async () => {
    vi.doMock('../src/config/env.js', () => ({ env: { FEATURE_SMS: 'true' } }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => true,
      nextAllowedSendTime: () => new Date('2026-02-10T13:00:00Z'),
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        enqueue: vi.fn().mockResolvedValue({ id: 'qh-1', status: 'queued' }),
      },
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn(),
    }));

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    await sendOutboundSms(
      { tenantId: 't', phone: '+15550001111', body: 'hi', messageType: 'reminder', bookingId: 'b1' },
      { timezone: 'America/New_York' },
    );

    expect(smsMetricGet('queued')).toBe(1);
    expect(smsMetricGet('sent')).toBe(0);
  });

  it('increments "failed" on opt-out rejection', async () => {
    vi.doMock('../src/config/env.js', () => ({ env: { FEATURE_SMS: 'true' } }));

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

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockResolvedValue({
        success: false,
        error: 'Recipient opted out',
        optedOut: true,
        rateLimited: false,
      }),
    }));

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    await sendOutboundSms(
      { tenantId: 't', phone: '+15550001111', body: 'hi', messageType: 'reminder' },
      { timezone: 'America/New_York' },
    );

    expect(smsMetricGet('failed')).toBe(1);
    expect(smsMetricGet('retry_scheduled')).toBe(0);
  });

  it('increments "retry_scheduled" on transport failure (retry enabled)', async () => {
    vi.doMock('../src/config/env.js', () => ({ env: { FEATURE_SMS: 'true' } }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        enqueue: vi.fn().mockResolvedValue({ id: 'retry-1', status: 'queued' }),
      },
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockResolvedValue({
        success: false,
        error: 'Twilio 503',
        optedOut: false,
        rateLimited: false,
      }),
    }));

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { sendOutboundSms } = await import('../src/voice/outbound-sms.js');

    await sendOutboundSms(
      { tenantId: 't', phone: '+15550001111', body: 'hi', messageType: 'reminder' },
      { timezone: 'America/New_York', sms_retry_enabled: true },
    );

    expect(smsMetricGet('retry_scheduled')).toBe(1);
    expect(smsMetricGet('failed')).toBe(0);
  });
});

// ── 7. Metrics wiring — processOutbox paths ─────────────────

describe('Metrics wiring — processOutbox', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('increments "retry_succeeded" + "sent" on successful delivery', async () => {
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        claimBatch: vi.fn().mockResolvedValue([{
          id: 'ob-ok',
          tenant_id: 'tenant-1',
          phone: '+15551234567',
          body: 'Good msg',
          message_type: 'reminder',
          booking_id: 'apt-9',
          status: 'sending',
          attempts: 2,
          max_attempts: 3,
        }]),
        markSent: vi.fn().mockResolvedValue(undefined),
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

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockResolvedValue({ success: true, messageSid: 'SM500' }),
    }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { processOutbox } = await import('../src/voice/outbound-sms.js');
    await processOutbox(5);

    expect(smsMetricGet('retry_succeeded')).toBe(1);
    expect(smsMetricGet('sent')).toBe(1);
  });

  it('increments "retry_aborted" on opt-out abort', async () => {
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        claimBatch: vi.fn().mockResolvedValue([{
          id: 'ob-oo',
          tenant_id: 'tenant-1',
          phone: '+15551234567',
          body: 'Opted out msg',
          message_type: 'reminder',
          booking_id: 'apt-10',
          status: 'sending',
          attempts: 2,
          max_attempts: 3,
        }]),
        abort: vi.fn().mockResolvedValue(undefined),
        markSent: vi.fn(),
        scheduleRetry: vi.fn(),
        markFailed: vi.fn(),
      },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(true) },
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn(),
    }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { processOutbox } = await import('../src/voice/outbound-sms.js');
    await processOutbox(5);

    expect(smsMetricGet('retry_aborted')).toBe(1);
  });

  it('increments "failed" on max retries exhausted', async () => {
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        claimBatch: vi.fn().mockResolvedValue([{
          id: 'ob-max',
          tenant_id: 'tenant-1',
          phone: '+15551234567',
          body: 'Max retries',
          message_type: 'reminder',
          booking_id: 'apt-11',
          status: 'sending',
          attempts: 3,          // 3rd attempt = max_attempts
          max_attempts: 3,
        }]),
        markFailed: vi.fn().mockResolvedValue(undefined),
        markSent: vi.fn(),
        scheduleRetry: vi.fn(),
        abort: vi.fn(),
      },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockResolvedValue({
        success: false,
        error: 'Twilio 503',
        optedOut: false,
      }),
    }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    const { smsMetricsReset, smsMetricGet } = await import('../src/voice/sms-metrics.js');
    smsMetricsReset();

    const { processOutbox } = await import('../src/voice/outbound-sms.js');
    await processOutbox(5);

    expect(smsMetricGet('failed')).toBe(1);
    expect(smsMetricGet('retry_scheduled')).toBe(0);
  });
});
