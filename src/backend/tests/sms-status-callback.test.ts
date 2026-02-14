// ============================================================
// Tests — SMS Delivery Tracking (Status Callback + SID persistence)
//
// 1. Repo: markSent stores message_sid
// 2. Repo: updateProviderStatus writes provider_status + error_code
// 3. Repo: updateProviderStatus returns null for unknown SID
// 4. Repo: markFailed stores error_code
// 5. Callback route: valid POST → 200 + repo call
// 6. Callback route: missing fields → 200 (no error)
// 7. Callback route: unknown SID → 200 (audit logged)
// 8. Callback route: undelivered with error code → stored
// 9. PII safety: no phone or body in callback response or audit
// 10. CEO test endpoint: outbox includes delivery tracking fields
//
// Non-PII, mocked (no database, no Twilio).
// Run:  npx vitest run tests/sms-status-callback.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. Outbox Repo — markSent with messageSid ──────────────

describe('Outbox Repo — markSent with messageSid', () => {
  it('calls UPDATE with message_sid when provided', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    vi.doMock('../src/db/client.js', () => ({ query: mockQuery }));

    const { smsOutboxRepo } = await import('../src/repos/sms-outbox.repo.js');
    await smsOutboxRepo.markSent('entry-1', 'SM_test_sid_123');

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('message_sid');
    expect(params).toContain('entry-1');
    expect(params).toContain('SM_test_sid_123');
  });

  it('passes null when messageSid is omitted (backward compatible)', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    vi.doMock('../src/db/client.js', () => ({ query: mockQuery }));

    const { smsOutboxRepo } = await import('../src/repos/sms-outbox.repo.js');
    await smsOutboxRepo.markSent('entry-2');

    expect(mockQuery).toHaveBeenCalledOnce();
    const [_sql, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('entry-2');
    expect(params[1]).toBeNull(); // COALESCE($2, message_sid) with null keeps old value
  });

  beforeEach(() => {
    vi.resetModules();
  });
});

// ── 2. Outbox Repo — updateProviderStatus ───────────────────

describe('Outbox Repo — updateProviderStatus', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('updates provider_status and error_code for matching message_sid', async () => {
    const fakeRow = {
      id: 'entry-1',
      tenant_id: 'tenant-1',
      message_sid: 'SM_abc123',
      provider_status: 'undelivered',
      error_code: 30006,
    };
    const mockQuery = vi.fn().mockResolvedValue({ rows: [fakeRow], rowCount: 1 });
    vi.doMock('../src/db/client.js', () => ({ query: mockQuery }));

    const { smsOutboxRepo } = await import('../src/repos/sms-outbox.repo.js');
    const result = await smsOutboxRepo.updateProviderStatus('SM_abc123', 'undelivered', 30006);

    expect(result).not.toBeNull();
    expect(result!.provider_status).toBe('undelivered');
    expect(result!.error_code).toBe(30006);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('RETURNING');
    expect(params[0]).toBe('SM_abc123');
    expect(params[1]).toBe('undelivered');
    expect(params[2]).toBe(30006);
  });

  it('returns null when message_sid not found', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    vi.doMock('../src/db/client.js', () => ({ query: mockQuery }));

    const { smsOutboxRepo } = await import('../src/repos/sms-outbox.repo.js');
    const result = await smsOutboxRepo.updateProviderStatus('SM_unknown', 'delivered');

    expect(result).toBeNull();
  });

  it('omits error_code when not provided', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'entry-1' }], rowCount: 1 });
    vi.doMock('../src/db/client.js', () => ({ query: mockQuery }));

    const { smsOutboxRepo } = await import('../src/repos/sms-outbox.repo.js');
    await smsOutboxRepo.updateProviderStatus('SM_abc123', 'delivered');

    const [_sql, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBeNull(); // COALESCE(null, error_code) keeps old
  });
});

// ── 3. Outbox Repo — markFailed with errorCode ─────────────

describe('Outbox Repo — markFailed with errorCode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('stores error_code when provided', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    vi.doMock('../src/db/client.js', () => ({ query: mockQuery }));

    const { smsOutboxRepo } = await import('../src/repos/sms-outbox.repo.js');
    await smsOutboxRepo.markFailed('entry-1', 'Twilio error 30006', 30006);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('error_code');
    expect(params).toContain(30006);
  });

  it('passes null error_code when omitted (backward compatible)', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    vi.doMock('../src/db/client.js', () => ({ query: mockQuery }));

    const { smsOutboxRepo } = await import('../src/repos/sms-outbox.repo.js');
    await smsOutboxRepo.markFailed('entry-2', 'network timeout');

    const [_sql, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBeNull();
  });
});

// ── 4. Status Callback Route ────────────────────────────────

describe('SMS Status Callback Route', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('updates provider status on valid callback (delivered)', async () => {
    const updateMock = vi.fn().mockResolvedValue({
      id: 'entry-1',
      tenant_id: 'tenant-1',
      message_sid: 'SMabc123',
      provider_status: 'delivered',
    });
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        updateProviderStatus: updateMock,
      },
    }));

    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: auditLogMock },
    }));

    vi.doMock('../src/auth/middleware.js', () => ({
      markPublic: vi.fn((_req: any, _reply: any, done: any) => done?.()),
    }));

    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await app.register(await import('@fastify/formbody').then(m => m.default));

    const { smsStatusCallbackRoutes } = await import(
      '../src/voice/sms-status-callback.routes.js'
    );
    await app.register(smsStatusCallbackRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'MessageSid=SMabc123&MessageStatus=delivered&AccountSid=AC123',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledWith('SMabc123', 'delivered', null);

    // Audit event logged
    expect(auditLogMock).toHaveBeenCalledOnce();
    const auditPayload = auditLogMock.mock.calls[0][0];
    expect(auditPayload.event_type).toBe('sms.provider_status_update');
    expect(auditPayload.payload.provider_status).toBe('delivered');
    expect(auditPayload.payload.matched).toBe(true);
    // PII safety: no phone, no body in audit payload
    expect(auditPayload.payload).not.toHaveProperty('phone');
    expect(auditPayload.payload).not.toHaveProperty('body');
    expect(auditPayload.payload).not.toHaveProperty('To');
    expect(auditPayload.payload).not.toHaveProperty('From');

    await app.close();
  });

  it('handles undelivered with error code 30006', async () => {
    const updateMock = vi.fn().mockResolvedValue({
      id: 'entry-2',
      tenant_id: 'tenant-1',
      message_sid: 'SMdef456',
      provider_status: 'undelivered',
      error_code: 30006,
    });
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: { updateProviderStatus: updateMock },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/auth/middleware.js', () => ({
      markPublic: vi.fn((_req: any, _reply: any, done: any) => done?.()),
    }));

    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await app.register(await import('@fastify/formbody').then(m => m.default));

    const { smsStatusCallbackRoutes } = await import(
      '../src/voice/sms-status-callback.routes.js'
    );
    await app.register(smsStatusCallbackRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'MessageSid=SMdef456&MessageStatus=undelivered&ErrorCode=30006',
    });

    expect(res.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledWith('SMdef456', 'undelivered', 30006);

    await app.close();
  });

  it('returns 200 even for unknown message SID', async () => {
    const updateMock = vi.fn().mockResolvedValue(null); // no matching row
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: { updateProviderStatus: updateMock },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/auth/middleware.js', () => ({
      markPublic: vi.fn((_req: any, _reply: any, done: any) => done?.()),
    }));

    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await app.register(await import('@fastify/formbody').then(m => m.default));

    const { smsStatusCallbackRoutes } = await import(
      '../src/voice/sms-status-callback.routes.js'
    );
    await app.register(smsStatusCallbackRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'MessageSid=SM_unknown_999&MessageStatus=delivered',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    await app.close();
  });

  it('returns 200 when MessageSid or MessageStatus is missing', async () => {
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: { updateProviderStatus: vi.fn() },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockResolvedValue(undefined) },
    }));
    vi.doMock('../src/auth/middleware.js', () => ({
      markPublic: vi.fn((_req: any, _reply: any, done: any) => done?.()),
    }));

    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await app.register(await import('@fastify/formbody').then(m => m.default));

    const { smsStatusCallbackRoutes } = await import(
      '../src/voice/sms-status-callback.routes.js'
    );
    await app.register(smsStatusCallbackRoutes);
    await app.ready();

    // Missing MessageStatus
    const res1 = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'MessageSid=SM123',
    });
    expect(res1.statusCode).toBe(200);

    // Missing MessageSid
    const res2 = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'MessageStatus=delivered',
    });
    expect(res2.statusCode).toBe(200);

    // Completely empty
    const res3 = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(res3.statusCode).toBe(200);

    await app.close();
  });

  it('returns 200 even when DB update throws (never trigger Twilio retries)', async () => {
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        updateProviderStatus: vi.fn().mockRejectedValue(new Error('DB down')),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: vi.fn().mockRejectedValue(new Error('Audit DB down')) },
    }));
    vi.doMock('../src/auth/middleware.js', () => ({
      markPublic: vi.fn((_req: any, _reply: any, done: any) => done?.()),
    }));

    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await app.register(await import('@fastify/formbody').then(m => m.default));

    const { smsStatusCallbackRoutes } = await import(
      '../src/voice/sms-status-callback.routes.js'
    );
    await app.register(smsStatusCallbackRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'MessageSid=SM_crash&MessageStatus=failed&ErrorCode=21211',
    });

    expect(res.statusCode).toBe(200);

    await app.close();
  });
});

// ── 5. PII Safety ───────────────────────────────────────────

describe('PII Safety — Status Callback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('audit event does not contain phone, body, To, or From', async () => {
    const auditLogMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/repos/sms-outbox.repo.js', () => ({
      smsOutboxRepo: {
        updateProviderStatus: vi.fn().mockResolvedValue({ id: 'e1', tenant_id: 't1' }),
      },
    }));
    vi.doMock('../src/repos/audit.repo.js', () => ({
      auditRepo: { log: auditLogMock },
    }));
    vi.doMock('../src/auth/middleware.js', () => ({
      markPublic: vi.fn((_req: any, _reply: any, done: any) => done?.()),
    }));

    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    await app.register(await import('@fastify/formbody').then(m => m.default));

    const { smsStatusCallbackRoutes } = await import(
      '../src/voice/sms-status-callback.routes.js'
    );
    await app.register(smsStatusCallbackRoutes);
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // Twilio sends To/From in real callbacks — we must NOT store them
      payload: 'MessageSid=SM_pii_test&MessageStatus=delivered&To=%2B15551234567&From=%2B18005551234&Body=Hello',
    });

    expect(auditLogMock).toHaveBeenCalledOnce();
    const payload = auditLogMock.mock.calls[0][0].payload;
    expect(payload).not.toHaveProperty('phone');
    expect(payload).not.toHaveProperty('body');
    expect(payload).not.toHaveProperty('To');
    expect(payload).not.toHaveProperty('From');
    expect(payload).not.toHaveProperty('Body');
    // Only safe fields
    expect(payload).toHaveProperty('message_sid_last4');
    expect(payload).toHaveProperty('provider_status');
    expect(payload).toHaveProperty('matched');

    await app.close();
  });
});

// ── 6. StatusCallback URL in sendSms ────────────────────────

describe('sendSms — StatusCallback URL', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('includes StatusCallback in form params when env var is set', async () => {
    let capturedFormData = '';

    vi.doMock('../src/config/env.js', () => ({
      env: {
        TWILIO_ACCOUNT_SID: 'ACtest123',
        TWILIO_AUTH_TOKEN: 'token123',
        TWILIO_PHONE_NUMBER: '+15551234567',
        TWILIO_MESSAGING_SERVICE_SID: '',
        SMS_STATUS_CALLBACK_URL: 'https://example.com/webhooks/twilio/status',
      },
    }));
    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));
    vi.doMock('../src/repos/sms-rate-limit.repo.js', () => ({
      smsRateLimitRepo: {
        check: vi.fn().mockResolvedValue({ allowed: true, remaining: 3, count: 0 }),
        record: vi.fn().mockResolvedValue(undefined),
      },
    }));

    // Mock the node:https module to capture the POST body
    vi.doMock('node:https', () => ({
      request: vi.fn().mockImplementation((_opts: any, callback: any) => {
        const res = {
          statusCode: 201,
          on: vi.fn().mockImplementation((event: string, handler: any) => {
            if (event === 'data') handler(JSON.stringify({ sid: 'SM_test_result' }));
            if (event === 'end') handler();
          }),
        };
        // Capture callback immediately
        setTimeout(() => callback(res), 0);
        return {
          on: vi.fn(),
          write: (data: string) => { capturedFormData = data; },
          end: vi.fn(),
        };
      }),
      get: vi.fn(),
    }));

    const { sendSms } = await import('../src/voice/sms-sender.js');
    await sendSms('+16892568400', 'Test message');

    // The form data should contain the StatusCallback URL
    const params = new URLSearchParams(capturedFormData);
    expect(params.get('StatusCallback')).toBe('https://example.com/webhooks/twilio/status');
    expect(params.get('To')).toBe('+16892568400');
  });

  it('omits StatusCallback when env var is empty', async () => {
    let capturedFormData = '';

    vi.doMock('../src/config/env.js', () => ({
      env: {
        TWILIO_ACCOUNT_SID: 'ACtest123',
        TWILIO_AUTH_TOKEN: 'token123',
        TWILIO_PHONE_NUMBER: '+15551234567',
        TWILIO_MESSAGING_SERVICE_SID: '',
        SMS_STATUS_CALLBACK_URL: '',
      },
    }));
    vi.doMock('../src/repos/sms-opt-out.repo.js', () => ({
      smsOptOutRepo: { isOptedOut: vi.fn().mockResolvedValue(false) },
    }));
    vi.doMock('../src/repos/sms-rate-limit.repo.js', () => ({
      smsRateLimitRepo: {
        check: vi.fn().mockResolvedValue({ allowed: true, remaining: 3, count: 0 }),
        record: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock('node:https', () => ({
      request: vi.fn().mockImplementation((_opts: any, callback: any) => {
        const res = {
          statusCode: 201,
          on: vi.fn().mockImplementation((event: string, handler: any) => {
            if (event === 'data') handler(JSON.stringify({ sid: 'SM_test2' }));
            if (event === 'end') handler();
          }),
        };
        setTimeout(() => callback(res), 0);
        return {
          on: vi.fn(),
          write: (data: string) => { capturedFormData = data; },
          end: vi.fn(),
        };
      }),
      get: vi.fn(),
    }));

    const { sendSms } = await import('../src/voice/sms-sender.js');
    await sendSms('+16892568400', 'Test message');

    const params = new URLSearchParams(capturedFormData);
    expect(params.has('StatusCallback')).toBe(false);
  });
});

// ── 7. SmsOutboxEntry Interface ─────────────────────────────

describe('SmsOutboxEntry interface includes delivery tracking fields', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('repo exports updateProviderStatus and findByMessageSid', async () => {
    // Mock DB client so importing the real repo doesn't need a DB connection
    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }));
    // Clear any stale repo mocks from previous tests
    vi.doUnmock('../src/repos/sms-outbox.repo.js');

    const { smsOutboxRepo } = await import('../src/repos/sms-outbox.repo.js');
    expect(smsOutboxRepo.updateProviderStatus).toBeDefined();
    expect(smsOutboxRepo.findByMessageSid).toBeDefined();
    expect(typeof smsOutboxRepo.updateProviderStatus).toBe('function');
    expect(typeof smsOutboxRepo.findByMessageSid).toBe('function');
  });
});
