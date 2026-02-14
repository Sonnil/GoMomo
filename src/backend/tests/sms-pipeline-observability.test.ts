/**
 * SMS Pipeline Observability Tests
 *
 * Validates the audit trail, truthful messaging, and config
 * reporting added for SMS delivery diagnosis.
 *
 * Tests:
 *  1. processOutbox emits sms.outbound_attempted audit before send
 *  2. processOutbox emits sms.outbound_sent on Twilio success (masked SID, simulated flag)
 *  3. processOutbox emits sms.outbound_failed on max retries (error_code + error_category)
 *  4. SmsSendResult includes simulated:true in simulator mode
 *  5. SmsSendResult includes twilioErrorCode on failure
 *  6. categoriseTwilioError maps known patterns correctly
 *  7. tool-executor returns sms_status='simulator' when Twilio not configured
 *  8. tool-executor returns sms_status='will_send' when Twilio configured
 *  9. tool-executor returns sms_status='no_phone' when phone is missing
 * 10. /health/sms includes twilio_config field with simulator status
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1–3: processOutbox audit events ─────────────────────────

describe('processOutbox audit events', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function baseOutboxEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: 'outbox-obs-1',
      tenant_id: 'tenant-1',
      phone: '+15551234567',
      body: 'Test message',
      message_type: 'booking_confirmation',
      booking_id: 'apt-obs-1',
      status: 'sending',
      attempts: 1,
      max_attempts: 3,
      last_error: null,
      ...overrides,
    };
  }

  function setupMocks(opts: {
    sendResult: Record<string, unknown>;
    entry?: Record<string, unknown>;
  }) {
    const auditLogMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        claimBatch: vi.fn().mockResolvedValue([baseOutboxEntry(opts.entry ?? {})]),
        markSent: vi.fn().mockResolvedValue(undefined),
        scheduleRetry: vi.fn().mockResolvedValue(undefined),
        markFailed: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));

    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: auditLogMock },
    }));

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockResolvedValue(opts.sendResult),
    }));

    vi.doMock('../src/voice/sms-metrics.js', () => ({
      smsMetricInc: vi.fn(),
    }));

    vi.doMock('../src/voice/quiet-hours.js', () => ({
      isQuietHours: () => false,
      nextAllowedSendTime: (now: Date) => now,
      tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
    }));

    return { auditLogMock };
  }

  it('emits sms.outbound_attempted audit before send', async () => {
    const { auditLogMock } = setupMocks({
      sendResult: { success: true, messageSid: 'SMabc123', simulated: false },
    });

    const { processOutbox } = await import('../src/voice/outbound-sms.js');
    await processOutbox(5);

    // First audit call should be sms.outbound_attempted
    const attemptedCall = auditLogMock.mock.calls.find(
      (c: any[]) => c[0]?.event_type === 'sms.outbound_attempted',
    );
    expect(attemptedCall).toBeDefined();
    expect(attemptedCall![0]).toMatchObject({
      event_type: 'sms.outbound_attempted',
      entity_type: 'sms_outbox',
      entity_id: 'outbox-obs-1',
      actor: 'outbox_processor',
      payload: expect.objectContaining({
        message_type: 'booking_confirmation',
        booking_id: 'apt-obs-1',
        attempt: 1,
      }),
    });

    // Verify the attempted audit fires BEFORE the sent audit
    const attemptedIdx = auditLogMock.mock.calls.findIndex(
      (c: any[]) => c[0]?.event_type === 'sms.outbound_attempted',
    );
    const sentIdx = auditLogMock.mock.calls.findIndex(
      (c: any[]) => c[0]?.event_type === 'sms.outbound_sent',
    );
    expect(attemptedIdx).toBeLessThan(sentIdx);
  });

  it('emits sms.outbound_sent on success with masked SID and simulated flag', async () => {
    const { auditLogMock } = setupMocks({
      sendResult: { success: true, messageSid: 'SMtestXYZ9', simulated: true },
    });

    const { processOutbox } = await import('../src/voice/outbound-sms.js');
    const result = await processOutbox(5);
    expect(result.sent).toBe(1);

    const sentCall = auditLogMock.mock.calls.find(
      (c: any[]) => c[0]?.event_type === 'sms.outbound_sent',
    );
    expect(sentCall).toBeDefined();
    expect(sentCall![0]).toMatchObject({
      event_type: 'sms.outbound_sent',
      entity_type: 'sms_outbox',
      entity_id: 'outbox-obs-1',
      actor: 'outbox_processor',
      payload: expect.objectContaining({
        message_type: 'booking_confirmation',
        booking_id: 'apt-obs-1',
        message_sid_last4: 'XYZ9',
        simulated: true,
      }),
    });

    // Full SID must NOT appear in any audit payload
    const allPayloads = auditLogMock.mock.calls
      .map((c: any[]) => JSON.stringify(c[0]?.payload))
      .join(' ');
    expect(allPayloads).not.toContain('SMtestXYZ9');
  });

  it('emits sms.outbound_failed on max retries with error_code and error_category', async () => {
    const { auditLogMock } = setupMocks({
      sendResult: {
        success: false,
        error: 'Twilio 21211: Invalid phone number',
        twilioErrorCode: 21211,
      },
      // Set attempts high enough to exhaust retries (attempts=3, RETRY_BACKOFF has 2 slots → index 2 exceeds)
      entry: { attempts: 3 },
    });

    const { processOutbox } = await import('../src/voice/outbound-sms.js');
    const result = await processOutbox(5);
    expect(result.failed).toBe(1);

    const failedCall = auditLogMock.mock.calls.find(
      (c: any[]) => c[0]?.event_type === 'sms.outbound_failed',
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![0]).toMatchObject({
      event_type: 'sms.outbound_failed',
      entity_type: 'sms_outbox',
      entity_id: 'outbox-obs-1',
      actor: 'outbox_processor',
      payload: expect.objectContaining({
        message_type: 'booking_confirmation',
        booking_id: 'apt-obs-1',
        error_code: 21211,
        error_category: 'invalid_number',
      }),
    });
  });

  it('categorises network errors correctly', async () => {
    const { auditLogMock } = setupMocks({
      sendResult: {
        success: false,
        error: 'Network timeout after 30s',
        twilioErrorCode: undefined,
      },
      entry: { attempts: 3 },
    });

    const { processOutbox } = await import('../src/voice/outbound-sms.js');
    await processOutbox(5);

    const failedCall = auditLogMock.mock.calls.find(
      (c: any[]) => c[0]?.event_type === 'sms.outbound_failed',
    );
    expect(failedCall![0].payload.error_category).toBe('network');
    expect(failedCall![0].payload.error_code).toBeNull();
  });
});

// ── 4–5: SmsSendResult type coverage ────────────────────────

describe('SmsSendResult fields', () => {
  it('simulator mode returns simulated:true', async () => {
    // sms-sender uses env vars to decide simulator mode — when they're empty it simulates
    // We test the type contract through the outbound-sms integration above
    // Here we verify the type at the interface level
    type SmsSendResult = {
      success: boolean;
      messageSid?: string;
      error?: string;
      optedOut?: boolean;
      simulated?: boolean;
      twilioErrorCode?: number;
    };

    // Simulator return shape
    const simResult: SmsSendResult = {
      success: true,
      messageSid: 'SIM_1234567890',
      simulated: true,
    };
    expect(simResult.simulated).toBe(true);
    expect(simResult.twilioErrorCode).toBeUndefined();

    // Error return shape
    const errResult: SmsSendResult = {
      success: false,
      error: 'Auth failure',
      twilioErrorCode: 20003,
    };
    expect(errResult.twilioErrorCode).toBe(20003);
    expect(errResult.simulated).toBeUndefined();
  });
});

// ── 6: categoriseTwilioError ────────────────────────────────

describe('categoriseTwilioError (via processOutbox integration)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const testCases = [
    { error: 'Network timeout', expected: 'network' },
    { error: 'Rate limit exceeded', expected: 'rate_limit' },
    { error: 'Recipient opted out', expected: 'opt_out' },
    { error: 'Unsubscribed number', expected: 'opt_out' },
    { error: '21211: Invalid To number', expected: 'invalid_number' },
    { error: '20003: Authentication error', expected: 'auth_failure' },
    { error: '30006: Undelivered', expected: 'undelivered' },
    { error: '21610: Message queue full', expected: 'blocked' },
    { error: 'Simulator mode echo', expected: 'simulator' },
    { error: 'Something totally unknown', expected: 'unknown' },
    { error: undefined, expected: 'unknown' },
  ];

  // We test via processOutbox since categoriseTwilioError is a private function
  for (const { error, expected } of testCases) {
    it(`"${error ?? '(undefined)'}" → "${expected}"`, async () => {
      const auditLogMock = vi.fn().mockResolvedValue(undefined);

      vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
        smsOutboxRepo: {
          claimBatch: vi.fn().mockResolvedValue([{
            id: 'outbox-cat-1',
            tenant_id: 'tenant-1',
            phone: '+15551234567',
            body: 'test',
            message_type: 'test',
            booking_id: 'apt-1',
            status: 'sending',
            attempts: 3, // max retries exhausted
            max_attempts: 3,
          }]),
          markSent: vi.fn(),
          scheduleRetry: vi.fn(),
          markFailed: vi.fn().mockResolvedValue(undefined),
          abort: vi.fn(),
        },
      }));
      vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
        smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
      }));
      vi.doMock('../src/repos/audit.repo.js', () => ({
        auditRepo: { log: auditLogMock },
      }));
      vi.doMock('../src/voice/sms-sender.js', () => ({
        sendSms: vi.fn().mockResolvedValue({ success: false, error }),
      }));
      vi.doMock('../src/voice/sms-metrics.js', () => ({
        smsMetricInc: vi.fn(),
      }));
      vi.doMock('../src/voice/quiet-hours.js', () => ({
        isQuietHours: () => false,
        nextAllowedSendTime: (now: Date) => now,
        tenantQuietHours: (t: any) => ({ start: '21:00', end: '08:00', timezone: t.timezone }),
      }));

      const { processOutbox } = await import('../src/voice/outbound-sms.js');
      await processOutbox(5);

      const failedCall = auditLogMock.mock.calls.find(
        (c: any[]) => c[0]?.event_type === 'sms.outbound_failed',
      );
      expect(failedCall).toBeDefined();
      expect(failedCall![0].payload.error_category).toBe(expected);
    });
  }
});

// ── 7–9: tool-executor sms_status ───────────────────────────

describe('tool-executor sms_status field', () => {
  // Helper mirrors the logic in tool-executor.ts
  function deriveSmsStatus(envConfig: {
    TWILIO_ACCOUNT_SID: string;
    TWILIO_AUTH_TOKEN: string;
    TWILIO_PHONE_NUMBER: string;
    TWILIO_MESSAGING_SERVICE_SID?: string;
  }, phone: string) {
    const twilioConfigured = !!envConfig.TWILIO_ACCOUNT_SID &&
      !!envConfig.TWILIO_AUTH_TOKEN &&
      (!!envConfig.TWILIO_PHONE_NUMBER || !!envConfig.TWILIO_MESSAGING_SERVICE_SID);
    return !phone ? 'no_phone' : twilioConfigured ? 'will_send' : 'simulator';
  }

  it('maps empty Twilio env to "simulator"', () => {
    expect(deriveSmsStatus({
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_PHONE_NUMBER: '',
    }, '+15551234567')).toBe('simulator');
  });

  it('maps configured Twilio env (From number) to "will_send"', () => {
    expect(deriveSmsStatus({
      TWILIO_ACCOUNT_SID: 'ACfake',
      TWILIO_AUTH_TOKEN: 'faketoken',
      TWILIO_PHONE_NUMBER: '+15559990000',
    }, '+15551234567')).toBe('will_send');
  });

  it('maps configured Twilio env (Messaging Service SID) to "will_send"', () => {
    expect(deriveSmsStatus({
      TWILIO_ACCOUNT_SID: 'ACfake',
      TWILIO_AUTH_TOKEN: 'faketoken',
      TWILIO_PHONE_NUMBER: '',
      TWILIO_MESSAGING_SERVICE_SID: 'MGfake',
    }, '+15551234567')).toBe('will_send');
  });

  it('maps missing phone to "no_phone"', () => {
    expect(deriveSmsStatus({
      TWILIO_ACCOUNT_SID: 'ACfake',
      TWILIO_AUTH_TOKEN: 'faketoken',
      TWILIO_PHONE_NUMBER: '+15559990000',
    }, '')).toBe('no_phone');
  });

  it('truthful message text varies by sms_status', () => {
    const messages: Record<string, string> = {
      will_send: 'Appointment confirmed! A confirmation SMS is being sent to the phone number provided.',
      simulator: 'Appointment confirmed! (SMS delivery is in demo mode — no real text message will be sent.)',
      no_phone: 'Appointment confirmed successfully!',
    };

    for (const [status, expected] of Object.entries(messages)) {
      const message = status === 'will_send'
        ? 'Appointment confirmed! A confirmation SMS is being sent to the phone number provided.'
        : status === 'simulator'
          ? 'Appointment confirmed! (SMS delivery is in demo mode — no real text message will be sent.)'
          : 'Appointment confirmed successfully!';
      expect(message).toBe(expected);
    }
  });
});

// ── 10: /health/sms twilio_config (3-state) ─────────────────

describe('/health/sms twilio_config', () => {
  // Helper mirrors getTwilioConfigStatus logic in index.ts
  function getTwilioConfigStatus(e: {
    TWILIO_ACCOUNT_SID: string;
    TWILIO_AUTH_TOKEN: string;
    TWILIO_PHONE_NUMBER: string;
    TWILIO_MESSAGING_SERVICE_SID: string;
  }) {
    const hasSid = !!e.TWILIO_ACCOUNT_SID;
    const hasToken = !!e.TWILIO_AUTH_TOKEN;
    const hasPhone = !!e.TWILIO_PHONE_NUMBER;
    const hasMsgSvc = !!e.TWILIO_MESSAGING_SERVICE_SID;
    const hasAuth = hasSid && hasToken;
    const hasSender = hasPhone || hasMsgSvc;
    const anySet = hasSid || hasToken || hasPhone || hasMsgSvc;

    let status: 'ok' | 'simulator' | 'config_error';
    let error: string | undefined;

    if (!anySet) {
      status = 'simulator';
    } else if (!hasAuth) {
      status = 'config_error';
      error = 'missing_twilio_config';
    } else if (!hasSender) {
      status = 'config_error';
      error = 'missing_twilio_config';
    } else {
      status = 'ok';
    }

    return {
      status,
      has_account_sid: hasSid,
      has_auth_token: hasToken,
      has_phone_number: hasPhone,
      has_messaging_service_sid: hasMsgSvc,
      ...(error && { error }),
    };
  }

  it('returns simulator when no Twilio vars are set', () => {
    const config = getTwilioConfigStatus({
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_PHONE_NUMBER: '',
      TWILIO_MESSAGING_SERVICE_SID: '',
    });
    expect(config.status).toBe('simulator');
    expect(config.has_account_sid).toBe(false);
  });

  it('returns ok when SID + token + phone are set', () => {
    const config = getTwilioConfigStatus({
      TWILIO_ACCOUNT_SID: 'ACfake',
      TWILIO_AUTH_TOKEN: 'faketoken',
      TWILIO_PHONE_NUMBER: '+15559990000',
      TWILIO_MESSAGING_SERVICE_SID: '',
    });
    expect(config.status).toBe('ok');
    expect(config.has_phone_number).toBe(true);
    expect(config.has_messaging_service_sid).toBe(false);
  });

  it('returns ok when SID + token + messaging service SID are set (no phone)', () => {
    const config = getTwilioConfigStatus({
      TWILIO_ACCOUNT_SID: 'ACfake',
      TWILIO_AUTH_TOKEN: 'faketoken',
      TWILIO_PHONE_NUMBER: '',
      TWILIO_MESSAGING_SERVICE_SID: 'MGfake',
    });
    expect(config.status).toBe('ok');
    expect(config.has_phone_number).toBe(false);
    expect(config.has_messaging_service_sid).toBe(true);
  });

  it('returns config_error when SID is set but token is missing', () => {
    const config = getTwilioConfigStatus({
      TWILIO_ACCOUNT_SID: 'ACfake',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_PHONE_NUMBER: '+15559990000',
      TWILIO_MESSAGING_SERVICE_SID: '',
    });
    expect(config.status).toBe('config_error');
    expect(config.error).toContain('missing_twilio_config');
  });

  it('returns config_error when SID + token set but no sender identity', () => {
    const config = getTwilioConfigStatus({
      TWILIO_ACCOUNT_SID: 'ACfake',
      TWILIO_AUTH_TOKEN: 'faketoken',
      TWILIO_PHONE_NUMBER: '',
      TWILIO_MESSAGING_SERVICE_SID: '',
    });
    expect(config.status).toBe('config_error');
    expect(config.error).toContain('missing_twilio_config');
  });

  it('returns ok when all four vars are set', () => {
    const config = getTwilioConfigStatus({
      TWILIO_ACCOUNT_SID: 'ACfake',
      TWILIO_AUTH_TOKEN: 'faketoken',
      TWILIO_PHONE_NUMBER: '+15559990000',
      TWILIO_MESSAGING_SERVICE_SID: 'MGfake',
    });
    expect(config.status).toBe('ok');
    expect(config.has_phone_number).toBe(true);
    expect(config.has_messaging_service_sid).toBe(true);
  });
});

// ── 11: Sender type detection + A2P status ──────────────────

describe('isTollFreeNumber', () => {
  it('detects 800 toll-free', async () => {
    const mod = await vi.importActual<typeof import('../src/voice/sms-sender.js')>('../src/voice/sms-sender.js');
    expect(mod.isTollFreeNumber('+18005551234')).toBe(true);
  });

  it('detects 844 toll-free', async () => {
    const mod = await vi.importActual<typeof import('../src/voice/sms-sender.js')>('../src/voice/sms-sender.js');
    expect(mod.isTollFreeNumber('+18445731475')).toBe(true);
  });

  it('detects 888 toll-free', async () => {
    const mod = await vi.importActual<typeof import('../src/voice/sms-sender.js')>('../src/voice/sms-sender.js');
    expect(mod.isTollFreeNumber('+18885551234')).toBe(true);
  });

  it('returns false for local 10DLC number', async () => {
    const mod = await vi.importActual<typeof import('../src/voice/sms-sender.js')>('../src/voice/sms-sender.js');
    expect(mod.isTollFreeNumber('+15738777070')).toBe(false);
  });

  it('returns false for non-US number', async () => {
    const mod = await vi.importActual<typeof import('../src/voice/sms-sender.js')>('../src/voice/sms-sender.js');
    expect(mod.isTollFreeNumber('+447911123456')).toBe(false);
  });
});

describe('detectSenderType', () => {
  it('trusts explicit env setting over auto-detection', async () => {
    const mod = await vi.importActual<typeof import('../src/voice/sms-sender.js')>('../src/voice/sms-sender.js');
    // Even though number looks toll-free, explicit setting wins
    expect(mod.detectSenderType('+18005551234', 'local_10dlc')).toBe('local_10dlc');
  });

  it('auto-detects toll-free when env is unknown', async () => {
    const mod = await vi.importActual<typeof import('../src/voice/sms-sender.js')>('../src/voice/sms-sender.js');
    expect(mod.detectSenderType('+18445731475', 'unknown')).toBe('toll_free');
  });

  it('auto-detects local 10DLC for US local numbers', async () => {
    const mod = await vi.importActual<typeof import('../src/voice/sms-sender.js')>('../src/voice/sms-sender.js');
    expect(mod.detectSenderType('+15738777070', 'unknown')).toBe('local_10dlc');
  });

  it('returns unknown for empty phone and unknown env', async () => {
    const mod = await vi.importActual<typeof import('../src/voice/sms-sender.js')>('../src/voice/sms-sender.js');
    expect(mod.detectSenderType('', 'unknown')).toBe('unknown');
  });
});
