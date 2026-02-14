// ============================================================
// Email Transport Tests
//
// Verifies:
//  1. Console provider — logs to stdout, returns success
//  2. Resend provider — delegates to Resend SDK, handles errors
//  3. Postmark provider — calls REST API, handles errors
//  4. Provider resolution — EMAIL_DEV_MODE overrides, fallbacks
//  5. sendVerificationEmail — correct subject, body, code, expiry
//  6. Route integration — request-code calls sendVerificationEmail
//  7. Route integration — 502 when email delivery fails
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 1. Console Provider ───────────────────────────────────

describe('Email transport: console provider', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('logs email and returns success with messageId=console', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        EMAIL_DEV_MODE: 'true',
        EMAIL_PROVIDER: 'console',
        EMAIL_FROM: 'Gomomo.ai <aireceptionistt@gmail.com>',
        EMAIL_REPLY_TO: '',
      },
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendEmail } = await import('../src/email/transport.js');
    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Test Subject',
      text: 'Test body',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('console');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[EMAIL:console]'),
      'user@example.com',
      'Test Subject',
      'Test body',
    );

    consoleSpy.mockRestore();
  });

  it('uses console provider when EMAIL_DEV_MODE=true even if EMAIL_PROVIDER=resend', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        EMAIL_DEV_MODE: 'true',
        EMAIL_PROVIDER: 'resend',
        EMAIL_FROM: 'Gomomo.ai <aireceptionistt@gmail.com>',
        EMAIL_REPLY_TO: '',
        RESEND_API_KEY: 're_test_123',
      },
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendEmail } = await import('../src/email/transport.js');
    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Test',
      text: 'Body',
    });

    // Should use console, not Resend
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('console');

    consoleSpy.mockRestore();
  });
});

// ── 2. Resend Provider ────────────────────────────────────

describe('Email transport: Resend provider', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('sends email via Resend SDK and returns messageId', async () => {
    const mockSend = vi.fn().mockResolvedValue({
      data: { id: 'resend-msg-123' },
      error: null,
    });

    vi.doMock('resend', () => ({
      Resend: class MockResend {
        emails = { send: mockSend };
      },
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        EMAIL_DEV_MODE: 'false',
        EMAIL_PROVIDER: 'resend',
        EMAIL_FROM: 'Gomomo.ai <aireceptionistt@gmail.com>',
        EMAIL_REPLY_TO: 'support@gomomo.ai',
        RESEND_API_KEY: 're_test_key',
      },
    }));

    const { sendEmail } = await import('../src/email/transport.js');
    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'OTP Code',
      text: 'Your code is 123456',
      html: '<p>Your code is 123456</p>',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('resend-msg-123');
    expect(mockSend).toHaveBeenCalledWith({
      from: 'Gomomo.ai <aireceptionistt@gmail.com>',
      replyTo: 'support@gomomo.ai',
      to: ['user@example.com'],
      subject: 'OTP Code',
      text: 'Your code is 123456',
      html: '<p>Your code is 123456</p>',
    });
  });

  it('returns error when Resend SDK fails', async () => {
    const mockSend = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'Invalid API key' },
    });

    vi.doMock('resend', () => ({
      Resend: class MockResend {
        emails = { send: mockSend };
      },
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        EMAIL_DEV_MODE: 'false',
        EMAIL_PROVIDER: 'resend',
        EMAIL_FROM: 'Gomomo.ai <aireceptionistt@gmail.com>',
        EMAIL_REPLY_TO: '',
        RESEND_API_KEY: 'bad-key',
      },
    }));

    const { sendEmail } = await import('../src/email/transport.js');
    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Test',
      text: 'Body',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });
});

// ── 3. Postmark Provider ──────────────────────────────────

describe('Email transport: Postmark provider', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('sends email via Postmark REST API and returns MessageID', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ MessageID: 'pm-msg-456' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    vi.doMock('../src/config/env.js', () => ({
      env: {
        EMAIL_DEV_MODE: 'false',
        EMAIL_PROVIDER: 'postmark',
        EMAIL_FROM: 'Gomomo.ai <aireceptionistt@gmail.com>',
        EMAIL_REPLY_TO: '',
        POSTMARK_API_TOKEN: 'pm-test-token',
      },
    }));

    const { sendEmail } = await import('../src/email/transport.js');
    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'OTP',
      text: 'Code: 654321',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('pm-msg-456');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.postmarkapp.com/email',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Postmark-Server-Token': 'pm-test-token',
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it('returns error when Postmark API responds with non-ok status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('Invalid sender'),
    });
    vi.stubGlobal('fetch', mockFetch);

    vi.doMock('../src/config/env.js', () => ({
      env: {
        EMAIL_DEV_MODE: 'false',
        EMAIL_PROVIDER: 'postmark',
        EMAIL_FROM: 'Gomomo.ai <aireceptionistt@gmail.com>',
        EMAIL_REPLY_TO: '',
        POSTMARK_API_TOKEN: 'pm-test-token',
      },
    }));

    const { sendEmail } = await import('../src/email/transport.js');
    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Test',
      text: 'Body',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Postmark 422');
    expect(result.error).toContain('Invalid sender');

    vi.unstubAllGlobals();
  });
});

// ── 4. Provider Resolution ────────────────────────────────

describe('Email transport: provider resolution', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to console when EMAIL_PROVIDER=console', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        EMAIL_DEV_MODE: 'false',
        EMAIL_PROVIDER: 'console',
        EMAIL_FROM: 'Gomomo.ai <aireceptionistt@gmail.com>',
        EMAIL_REPLY_TO: '',
      },
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendEmail } = await import('../src/email/transport.js');
    const result = await sendEmail({
      to: 'test@test.com',
      subject: 'Hi',
      text: 'Hello',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('console');

    consoleSpy.mockRestore();
  });
});

// ── 5. sendVerificationEmail Builder ──────────────────────

describe('sendVerificationEmail', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('sends email with correct subject, code, and expiry', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        EMAIL_DEV_MODE: 'true',
        EMAIL_PROVIDER: 'console',
        EMAIL_FROM: 'Gomomo.ai <aireceptionistt@gmail.com>',
        EMAIL_REPLY_TO: '',
      },
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { sendVerificationEmail } = await import('../src/email/transport.js');
    const result = await sendVerificationEmail('user@example.com', '123456', 10);

    expect(result.success).toBe(true);

    // Verify console.log was called with correct subject
    const logCall = consoleSpy.mock.calls[0];
    expect(logCall[1]).toBe('user@example.com');
    expect(logCall[2]).toBe('Your gomomo verification code');
    // Body should contain the code and expiry
    const body = logCall[3] as string;
    expect(body).toContain('123456');
    expect(body).toContain('10 minutes');
    expect(body).toContain("didn't request this");

    consoleSpy.mockRestore();
  });

  it('includes HTML with the code', async () => {
    vi.doMock('../src/config/env.js', () => ({
      env: {
        EMAIL_DEV_MODE: 'true',
        EMAIL_PROVIDER: 'console',
        EMAIL_FROM: 'Gomomo.ai <aireceptionistt@gmail.com>',
        EMAIL_REPLY_TO: '',
      },
    }));

    const { buildVerificationEmail } = await import('../src/email/transport.js');
    const payload = buildVerificationEmail('user@example.com', '987654', 15);

    expect(payload.to).toBe('user@example.com');
    expect(payload.subject).toBe('Your gomomo verification code');
    expect(payload.text).toContain('987654');
    expect(payload.text).toContain('15 minutes');
    expect(payload.text).toContain("didn't request this");
    expect(payload.html).toContain('987654');
    expect(payload.html).toContain('15 minutes');
    expect(payload.html).toContain("didn't request this");
    expect(payload.html).toContain('gomomo.ai');
  });
});

// ── 6. Route Integration: request-code sends email ────────

describe('request-code route + email delivery', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls sendVerificationEmail and returns success', async () => {
    const mockSendVerificationEmail = vi.fn().mockResolvedValue({
      success: true,
      messageId: 'test-msg-id',
    });

    vi.doMock('../src/email/transport.js', () => ({
      sendVerificationEmail: mockSendVerificationEmail,
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        NODE_ENV: 'development',
        EMAIL_VERIFICATION_RATE_LIMIT: 5,
        EMAIL_VERIFICATION_TTL_MINUTES: 10,
      },
    }));

    vi.doMock('../src/repos/email-verification.repo.js', () => ({
      validateEmail: vi.fn().mockReturnValue(null),
      emailVerificationRepo: {
        countRecent: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({
          id: 'ver-1',
          code: '123456',
          expires_at: new Date(Date.now() + 600000),
        }),
      },
    }));

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {},
    }));

    vi.doMock('../src/services/customer.service.js', () => ({
      customerService: {},
    }));

    vi.doMock('@fastify/rate-limit', () => ({
      default: vi.fn().mockImplementation(async () => {}),
    }));

    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn(),
    }));

    vi.doMock('./middleware.js', () => ({
      markPublic: vi.fn(),
    }));

    // Build a minimal Fastify-like app to test route registration
    const registeredRoutes: Record<string, any> = {};
    const mockApp = {
      register: vi.fn().mockImplementation(async (plugin: any) => {
        if (typeof plugin === 'function') await plugin();
      }),
      post: vi.fn().mockImplementation((path: string, _opts: any, handler: any) => {
        registeredRoutes[path] = handler;
      }),
    };

    const { emailVerificationRoutes } = await import('../src/auth/email-verification.routes.js');
    await emailVerificationRoutes(mockApp as any);

    // Simulate calling the request-code handler
    const handler = registeredRoutes['/api/auth/request-code'];
    expect(handler).toBeDefined();

    const mockReq = {
      body: { email: 'user@example.com', session_id: 'sess-1', tenant_id: 'tenant-1' },
      log: { info: vi.fn(), error: vi.fn() },
    };
    const mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    const result = await handler(mockReq, mockReply);

    expect(mockSendVerificationEmail).toHaveBeenCalledWith(
      'user@example.com',
      '123456',
      10,
    );
    expect(result.success).toBe(true);
    expect(result.code).toBe('123456'); // dev mode includes code
    expect(result.expires_in_minutes).toBe(10);
  });

  it('returns 502 when email delivery fails', async () => {
    const mockSendVerificationEmail = vi.fn().mockResolvedValue({
      success: false,
      error: 'Resend API error',
    });

    vi.doMock('../src/email/transport.js', () => ({
      sendVerificationEmail: mockSendVerificationEmail,
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        NODE_ENV: 'development',
        EMAIL_VERIFICATION_RATE_LIMIT: 5,
        EMAIL_VERIFICATION_TTL_MINUTES: 10,
      },
    }));

    vi.doMock('../src/repos/email-verification.repo.js', () => ({
      validateEmail: vi.fn().mockReturnValue(null),
      emailVerificationRepo: {
        countRecent: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({
          id: 'ver-1',
          code: '123456',
          expires_at: new Date(Date.now() + 600000),
        }),
      },
    }));

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {},
    }));

    vi.doMock('../src/services/customer.service.js', () => ({
      customerService: {},
    }));

    vi.doMock('@fastify/rate-limit', () => ({
      default: vi.fn().mockImplementation(async () => {}),
    }));

    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn(),
    }));

    vi.doMock('./middleware.js', () => ({
      markPublic: vi.fn(),
    }));

    const registeredRoutes: Record<string, any> = {};
    const mockApp = {
      register: vi.fn().mockImplementation(async (plugin: any) => {
        if (typeof plugin === 'function') await plugin();
      }),
      post: vi.fn().mockImplementation((path: string, _opts: any, handler: any) => {
        registeredRoutes[path] = handler;
      }),
    };

    const { emailVerificationRoutes } = await import('../src/auth/email-verification.routes.js');
    await emailVerificationRoutes(mockApp as any);

    const handler = registeredRoutes['/api/auth/request-code'];
    const mockReq = {
      body: { email: 'user@example.com', session_id: 'sess-1', tenant_id: 'tenant-1' },
      log: { info: vi.fn(), error: vi.fn() },
    };
    const mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    await handler(mockReq, mockReply);

    expect(mockReply.code).toHaveBeenCalledWith(502);
    expect(mockReply.send).toHaveBeenCalledWith({
      error: 'Unable to send verification email. Please try again shortly.',
    });
    expect(mockReq.log.error).toHaveBeenCalled();
  });

  it('does NOT include code in response when NODE_ENV=production', async () => {
    const mockSendVerificationEmail = vi.fn().mockResolvedValue({
      success: true,
      messageId: 'prod-msg-id',
    });

    vi.doMock('../src/email/transport.js', () => ({
      sendVerificationEmail: mockSendVerificationEmail,
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        NODE_ENV: 'production',
        EMAIL_VERIFICATION_RATE_LIMIT: 5,
        EMAIL_VERIFICATION_TTL_MINUTES: 10,
      },
    }));

    vi.doMock('../src/repos/email-verification.repo.js', () => ({
      validateEmail: vi.fn().mockReturnValue(null),
      emailVerificationRepo: {
        countRecent: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({
          id: 'ver-1',
          code: '999888',
          expires_at: new Date(Date.now() + 600000),
        }),
      },
    }));

    vi.doMock('../src/repos/session.repo.js', () => ({
      sessionRepo: {},
    }));

    vi.doMock('../src/services/customer.service.js', () => ({
      customerService: {},
    }));

    vi.doMock('@fastify/rate-limit', () => ({
      default: vi.fn().mockImplementation(async () => {}),
    }));

    vi.doMock('../src/db/client.js', () => ({
      query: vi.fn(),
    }));

    vi.doMock('./middleware.js', () => ({
      markPublic: vi.fn(),
    }));

    const registeredRoutes: Record<string, any> = {};
    const mockApp = {
      register: vi.fn().mockImplementation(async (plugin: any) => {
        if (typeof plugin === 'function') await plugin();
      }),
      post: vi.fn().mockImplementation((path: string, _opts: any, handler: any) => {
        registeredRoutes[path] = handler;
      }),
    };

    const { emailVerificationRoutes } = await import('../src/auth/email-verification.routes.js');
    await emailVerificationRoutes(mockApp as any);

    const handler = registeredRoutes['/api/auth/request-code'];
    const mockReq = {
      body: { email: 'user@example.com', session_id: 'sess-1', tenant_id: 'tenant-1' },
      log: { info: vi.fn(), error: vi.fn() },
    };
    const mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    const result = await handler(mockReq, mockReply);

    expect(result.success).toBe(true);
    // Code must NOT be in the response in production
    expect(result.code).toBeUndefined();
    expect(result.expires_in_minutes).toBe(10);

    // Log should NOT contain the code
    const logCalls = mockReq.log.info.mock.calls;
    const loggedObj = logCalls[0][0];
    expect(loggedObj.code).toBeUndefined();
  });
});
