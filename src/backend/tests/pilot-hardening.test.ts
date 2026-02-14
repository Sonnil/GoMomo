// ============================================================
// Pilot Hardening Tests — Phone Normalization, Reminder
// Message Clarity, HELP Keyword
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Phone Normalization ───────────────────────────────────

describe('Phone Normalizer', () => {
  it('passes through valid E.164 unchanged', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('+15551234567')).toBe('+15551234567');
    expect(normalizePhone('+442071234567')).toBe('+442071234567');
  });

  it('adds + to 11-digit US number starting with 1', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('15551234567')).toBe('+15551234567');
  });

  it('adds +1 to 10-digit US number', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('5551234567')).toBe('+15551234567');
  });

  it('strips formatting characters', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('555.123.4567')).toBe('+15551234567');
  });

  it('returns null for garbage input', async () => {
    const { normalizePhone } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('hello')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
  });

  it('normalizePhoneOrPassthrough returns original on failure', async () => {
    const { normalizePhoneOrPassthrough } = await import('../src/voice/phone-normalizer.js');
    expect(normalizePhoneOrPassthrough('+15551234567')).toBe('+15551234567');
    expect(normalizePhoneOrPassthrough('not-a-phone')).toBe('not-a-phone');
  });
});

// ── PII Redaction covers client_phone ─────────────────────

describe('PII Redaction — phone fields', () => {
  it('redacts client_phone field', async () => {
    const { redactPII } = await import('../src/orchestrator/redact.js');
    const result = redactPII({
      client_phone: '+15551234567',
      reference_code: 'APT-123',
    });
    expect(result.client_phone).toBe('[REDACTED]');
    expect(result.reference_code).toBe('APT-123');
  });

  it('redacts any field matching /phone/i pattern', async () => {
    const { redactPII } = await import('../src/orchestrator/redact.js');
    const result = redactPII({
      from_phone: '+15551234567',
      caller_phone: '+19995551234',
    });
    expect(result.from_phone).toBe('[REDACTED]');
    expect(result.caller_phone).toBe('[REDACTED]');
  });
});

// ── SMS Reminder Message — Date + Time ────────────────────

describe('SMS Reminder — message format', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes explicit date AND time (not just "today")', async () => {
    let sentBody = '';
    const mockMarkSent = vi.fn();

    vi.doMock('../src/voice/sms-sender.js', () => ({
      sendSms: vi.fn().mockImplementation((_to: string, body: string) => {
        sentBody = body;
        return Promise.resolve({ success: true, sid: 'SM123' });
      }),
    }));
    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));
    vi.doMock('../src/repos/appointment-reminder.repo.js', () => ({
      appointmentReminderRepo: {
        markSent: mockMarkSent,
        markFailed: vi.fn(),
        markCancelled: vi.fn(),
      },
    }));
    vi.doMock('../src/stores/booking-store-factory.js', () => ({
      getDefaultStore: () => ({
        findById: vi.fn().mockResolvedValue({
          id: 'apt-1',
          status: 'confirmed',
        }),
      }),
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/tenant.repo.js', () => ({
      tenantRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'tenant-1',
          timezone: 'America/New_York',
          quiet_hours_start: '21:00',
          quiet_hours_end: '08:00',
        }),
      },
    }));
    vi.doMock('../src/voice/outbound-sms.js', () => ({
      sendOutboundSms: vi.fn().mockImplementation(async (req: any) => {
        sentBody = req.body;
        return { sent: true, queued: false };
      }),
    }));

    // Import registered-tools to trigger the registration
    const registeredTools = await import('../src/orchestrator/registered-tools.js');
    const { getTool } = registeredTools;

    const executor = getTool('send_sms_reminder');
    expect(executor).toBeDefined();

    // Create a mock job with a known date: Mon Feb 9, 2026 at 2:00 PM ET
    const mockJob = {
      id: 'job-1',
      tenant_id: 'tenant-1',
      type: 'send_sms_reminder',
      payload: {
        appointment_id: 'apt-1',
        reference_code: 'APT-99999',
        phone: '+15551234567',
        first_name: 'Sarah',
        service: 'General Consultation',
        start_time: '2026-02-09T19:00:00.000Z', // 2:00 PM ET
        end_time: '2026-02-09T20:00:00.000Z',
        timezone: 'America/New_York',
      },
      priority: 8,
      status: 'claimed',
      run_at: new Date(),
      max_attempts: 3,
      attempts: 0,
      created_at: new Date(),
      claimed_at: new Date(),
    };

    await executor!(mockJob as any);

    // The message should include a date like "Mon Feb 9" and a time like "2:00 PM"
    expect(sentBody).toContain('Sarah');
    expect(sentBody).toContain('General Consultation');
    expect(sentBody).toMatch(/Mon Feb 9/);
    expect(sentBody).toMatch(/2:00 PM/);
    // Should NOT say "today"
    expect(sentBody).not.toContain('today');
    expect(sentBody).toContain('HELP');
    expect(mockMarkSent).toHaveBeenCalledWith('job-1');
  });
});

// ── HELP Keyword ──────────────────────────────────────────

describe('SMS HELP keyword', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HELP returns instruction message (not opted out)', async () => {
    // Mock all dependencies for the inbound SMS route
    vi.doMock('../src/config/env.js', () => ({
      env: {
        NODE_ENV: 'test',
        TWILIO_AUTH_TOKEN: 'test',
        SMS_INBOUND_ENABLED: 'true',
        SMS_DEBUG: 'false',
        SMS_INBOUND_RATE_LIMIT_MAX: 20,
        SMS_RATE_LIMIT_MAX: 3,
      },
    }));
    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: {
        isOptedOut: vi.fn().mockResolvedValue(false),
        optOut: vi.fn(),
        optIn: vi.fn(),
      },
    }));
    vi.doMock('../src/voice/sms-session-resolver.js', () => ({
      resolveSmsSession: vi.fn().mockResolvedValue({
        tenant: { id: 'tenant-1', name: 'Test' },
        sessionId: 'sess-1',
        isNew: false,
        returningContext: null,
      }),
    }));
    vi.doMock('../src/voice/twilio-signature.js', () => ({
      validateTwilioSignature: () => true,
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findOrCreate: vi.fn().mockResolvedValue({ metadata: {} }),
        updateMetadata: vi.fn(),
      },
    }));
    vi.doMock('../src/auth/middleware.js', () => ({
      markPublic: vi.fn((_req: any, _reply: any, done: any) => done()),
      requireAdminKey: vi.fn(),
    }));
    vi.doMock('../src/repos/sms-rate-limit.repo.js', () => ({
      smsRateLimitRepo: {
        checkInbound: vi.fn().mockResolvedValue({ allowed: true, count: 1 }),
        record: vi.fn(),
      },
    }));
    // Mock chat-handler to prevent OpenAI client instantiation
    vi.doMock('../src/agent/chat-handler.js', () => ({
      handleChatMessage: vi.fn().mockResolvedValue({
        response: 'mocked',
        meta: { tools_used: [], has_async_job: false },
      }),
    }));

    const Fastify = (await import('fastify')).default;
    const app = Fastify();

    // Need to register form body parsing (Twilio sends form data)
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req: any, body: string, done: any) => {
        const parsed: Record<string, string> = {};
        body.split('&').forEach((pair) => {
          const [k, v] = pair.split('=');
          parsed[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
        });
        done(null, parsed);
      },
    );

    const { inboundSmsRoutes } = await import('../src/voice/inbound-sms.routes.js');
    await app.register(inboundSmsRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/twilio/sms/incoming',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'From=%2B15551234567&To=%2B18005551234&Body=HELP&MessageSid=SM_TEST',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');

    const xml = response.body;
    // Must contain the instruction text
    expect(xml).toContain('To book');
    expect(xml).toContain('To cancel');
    expect(xml).toContain('To reschedule');
    expect(xml).toContain('STOP to opt out');

    await app.close();
  });

  it('HELP is silent when user is opted out', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        NODE_ENV: 'test',
        TWILIO_AUTH_TOKEN: 'test',
        SMS_INBOUND_ENABLED: 'true',
        SMS_DEBUG: 'false',
        SMS_INBOUND_RATE_LIMIT_MAX: 20,
        SMS_RATE_LIMIT_MAX: 3,
      },
    }));
    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: {
        isOptedOut: vi.fn().mockResolvedValue(true), // opted out
        optOut: vi.fn(),
        optIn: vi.fn(),
      },
    }));
    vi.doMock('../src/voice/sms-session-resolver.js', () => ({
      resolveSmsSession: vi.fn().mockResolvedValue({
        tenant: { id: 'tenant-1', name: 'Test' },
        sessionId: 'sess-1',
        isNew: false,
        returningContext: null,
      }),
    }));
    vi.doMock('../src/voice/twilio-signature.js', () => ({
      validateTwilioSignature: () => true,
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {
        findOrCreate: vi.fn().mockResolvedValue({ metadata: {} }),
        updateMetadata: vi.fn(),
      },
    }));
    vi.doMock('../src/auth/middleware.js', () => ({
      markPublic: vi.fn((_req: any, _reply: any, done: any) => done()),
      requireAdminKey: vi.fn(),
    }));
    vi.doMock('../src/repos/sms-rate-limit.repo.js', () => ({
      smsRateLimitRepo: {
        checkInbound: vi.fn().mockResolvedValue({ allowed: true, count: 1 }),
        record: vi.fn(),
      },
    }));
    vi.doMock('../src/agent/chat-handler.js', () => ({
      handleChatMessage: vi.fn().mockResolvedValue({
        response: 'mocked',
        meta: { tools_used: [], has_async_job: false },
      }),
    }));

    const Fastify = (await import('fastify')).default;
    const app = Fastify();

    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req: any, body: string, done: any) => {
        const parsed: Record<string, string> = {};
        body.split('&').forEach((pair) => {
          const [k, v] = pair.split('=');
          parsed[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
        });
        done(null, parsed);
      },
    );

    const { inboundSmsRoutes } = await import('../src/voice/inbound-sms.routes.js');
    await app.register(inboundSmsRoutes);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/twilio/sms/incoming',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'From=%2B15551234567&To=%2B18005551234&Body=help&MessageSid=SM_TEST',
    });

    expect(response.statusCode).toBe(200);
    // Empty TwiML — no message sent to opted-out user
    expect(response.body).toContain('<Response></Response>');
    expect(response.body).not.toContain('<Message>');

    await app.close();
  });
});
