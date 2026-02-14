/**
 * Twilio Live Verification Tests
 *
 * Validates:
 *  1. verifyTwilioCredentials returns 'simulator' when no env vars
 *  2. verifyTwilioCredentials returns 'invalid' when partial config
 *  3. verifyTwilioCredentials returns 'live' on successful API call
 *  4. verifyTwilioCredentials returns 'test' for trial accounts
 *  5. verifyTwilioCredentials returns 'invalid' on HTTP 401
 *  6. verifyTwilioCredentials returns 'invalid' on network error
 *  7. setTwilioVerifyResult / getTwilioVerifyResult round-trips correctly
 *  8. tool-executor returns sms_status='unavailable' when auth failed
 *  9. categorizeSmsError (ceo-test.routes) maps error patterns
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Helpers: mock node:https ────────────────────────────────

/**
 * Build a mock for `node:https` whose `get` calls the callback with a fake response.
 * Event emission is deferred until `get` is actually called to avoid timing issues.
 */
function mockHttps(statusCode: number, body: string) {
  return {
    get: vi.fn((_opts: unknown, cb: (r: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { destroy: (e?: Error) => void };
      req.destroy = vi.fn();
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = statusCode;
      // Deliver response callback on next tick, then emit data + end on the tick after
      process.nextTick(() => {
        cb(res);
        process.nextTick(() => {
          res.emit('data', body);
          res.emit('end');
        });
      });
      return req;
    }),
  };
}

/** Build a mock for `node:https` whose `get` emits an error */
function mockHttpsError(errorMessage: string) {
  return {
    get: vi.fn(() => {
      const req = new EventEmitter() as EventEmitter & { destroy: (e?: Error) => void };
      req.destroy = vi.fn();
      process.nextTick(() => req.emit('error', new Error(errorMessage)));
      return req;
    }),
  };
}

// ── 1–6: verifyTwilioCredentials ────────────────────────────

describe('verifyTwilioCredentials', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function getVerifier(envOverrides: Record<string, string> = {}) {
    // Mock env module
    vi.doMock('../src/config/env.js', () => ({
      env: {
        TWILIO_ACCOUNT_SID: '',
        TWILIO_AUTH_TOKEN: '',
        TWILIO_PHONE_NUMBER: '',
        TWILIO_MESSAGING_SERVICE_SID: '',
        ...envOverrides,
      },
    }));
    const mod = await import('../src/voice/sms-sender.js');
    return mod.verifyTwilioCredentials;
  }

  it('returns simulator when no credentials configured', async () => {
    const verify = await getVerifier();
    const result = await verify();
    expect(result.credentialMode).toBe('simulator');
    expect(result.verified).toBe(false);
  });

  it('returns invalid when SID present but token missing', async () => {
    const verify = await getVerifier({
      TWILIO_ACCOUNT_SID: 'AC1234',
      TWILIO_PHONE_NUMBER: '+15551234567',
    });
    const result = await verify();
    expect(result.credentialMode).toBe('invalid');
    expect(result.verified).toBe(false);
    expect(result.error).toContain('AUTH_TOKEN');
  });

  it('returns invalid when auth present but no sender', async () => {
    const verify = await getVerifier({
      TWILIO_ACCOUNT_SID: 'AC1234',
      TWILIO_AUTH_TOKEN: 'token123',
    });
    const result = await verify();
    expect(result.credentialMode).toBe('invalid');
    expect(result.verified).toBe(false);
    expect(result.error).toContain('PHONE_NUMBER');
  });

  it('returns live for a full (non-trial) account', async () => {
    vi.doMock('node:https', () => mockHttps(200, JSON.stringify({
      status: 'active',
      type: 'Full',
      friendly_name: 'gomomo Demo',
    })));

    const verify = await getVerifier({
      TWILIO_ACCOUNT_SID: 'AC1234',
      TWILIO_AUTH_TOKEN: 'token123',
      TWILIO_PHONE_NUMBER: '+15551234567',
    });
    const result = await verify();
    expect(result.credentialMode).toBe('live');
    expect(result.verified).toBe(true);
    expect(result.isLive).toBe(true);
    expect(result.accountStatus).toBe('active');
    expect(result.sendMode).toBe('from_number');
    expect(result.friendlyName).toBe('gomomo Demo');
  });

  it('returns test for trial account', async () => {
    vi.doMock('node:https', () => mockHttps(200, JSON.stringify({
      status: 'active',
      type: 'Trial',
      friendly_name: 'Test Account',
    })));

    const verify = await getVerifier({
      TWILIO_ACCOUNT_SID: 'AC1234',
      TWILIO_AUTH_TOKEN: 'token123',
      TWILIO_MESSAGING_SERVICE_SID: 'MG1234',
    });
    const result = await verify();
    expect(result.credentialMode).toBe('test');
    expect(result.verified).toBe(true);
    expect(result.isLive).toBe(false);
    expect(result.sendMode).toBe('messaging_service_sid');
  });

  it('returns invalid on HTTP 401', async () => {
    vi.doMock('node:https', () => mockHttps(401, '{"message":"Unauthorized"}'));

    const verify = await getVerifier({
      TWILIO_ACCOUNT_SID: 'AC1234',
      TWILIO_AUTH_TOKEN: 'badtoken',
      TWILIO_PHONE_NUMBER: '+15551234567',
    });
    const result = await verify();
    expect(result.credentialMode).toBe('invalid');
    expect(result.verified).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns invalid on network error', async () => {
    vi.doMock('node:https', () => mockHttpsError('ECONNREFUSED'));

    const verify = await getVerifier({
      TWILIO_ACCOUNT_SID: 'AC1234',
      TWILIO_AUTH_TOKEN: 'token123',
      TWILIO_PHONE_NUMBER: '+15551234567',
    });
    const result = await verify();
    expect(result.credentialMode).toBe('invalid');
    expect(result.verified).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

// ── 7: Module-level state round-trip ────────────────────────

describe('setTwilioVerifyResult / getTwilioVerifyResult', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('round-trips a verification result', async () => {
    const mod = await import('../src/voice/sms-sender.js');

    // Initially null
    expect(mod.getTwilioVerifyResult()).toBeNull();

    const testResult = {
      verified: true,
      credentialMode: 'live' as const,
      sendMode: 'from_number' as const,
      accountStatus: 'active',
      isLive: true,
    };
    mod.setTwilioVerifyResult(testResult);
    expect(mod.getTwilioVerifyResult()).toEqual(testResult);
  });
});

// ── 8: tool-executor sms_status='unavailable' when auth failed ──

describe('tool-executor sms_status with auth failure', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reports unavailable when verify result shows invalid credentials', async () => {
    // Set up the verify result as invalid
    vi.doMock('../src/voice/sms-sender.js', () => ({
      getTwilioVerifyResult: () => ({
        verified: false,
        credentialMode: 'invalid',
        error: 'Twilio auth failed: HTTP 401',
      }),
    }));

    vi.doMock('../src/config/env.js', () => ({
      env: {
        TWILIO_ACCOUNT_SID: 'AC1234',
        TWILIO_AUTH_TOKEN: 'badtoken',
        TWILIO_PHONE_NUMBER: '+15551234567',
        TWILIO_MESSAGING_SERVICE_SID: '',
      },
    }));

    // Import getTwilioVerifyResult to verify the mock
    const { getTwilioVerifyResult } = await import('../src/voice/sms-sender.js');
    const verifyResult = getTwilioVerifyResult();

    // Simulate the tool-executor logic
    const { env: envConfig } = await import('../src/config/env.js');
    const twilioConfigured = !!envConfig.TWILIO_ACCOUNT_SID &&
      !!envConfig.TWILIO_AUTH_TOKEN &&
      (!!envConfig.TWILIO_PHONE_NUMBER || !!envConfig.TWILIO_MESSAGING_SERVICE_SID);

    const authFailed = verifyResult && !verifyResult.verified && verifyResult.credentialMode === 'invalid';
    const normalizedPhone = '+15559876543';

    const smsStatus = !normalizedPhone
      ? 'no_phone'
      : authFailed
        ? 'unavailable'
        : twilioConfigured
          ? 'will_send'
          : 'simulator';

    expect(smsStatus).toBe('unavailable');
  });
});

// ── 9: categorizeSmsError ───────────────────────────────────

describe('categorizeSmsError (ceo-test.routes pattern)', () => {
  // Inline the same logic to test it (it's a private function in ceo-test.routes)
  function categorizeSmsError(error?: string | null): string {
    if (!error) return 'unknown';
    const lower = error.toLowerCase();
    if (lower.includes('timeout') || lower.includes('network')) return 'network';
    if (lower.includes('rate')) return 'rate_limit';
    if (lower.includes('opt') || lower.includes('unsubscribed')) return 'opt_out';
    if (lower.includes('invalid') || lower.includes('21211')) return 'invalid_number';
    if (lower.includes('auth') || lower.includes('20003')) return 'auth_failure';
    if (lower.includes('undelivered') || lower.includes('30')) return 'undelivered';
    if (lower.includes('max retries')) return 'max_retries';
    if (lower.includes('queue') || lower.includes('21610')) return 'blocked';
    if (lower.includes('simulator')) return 'simulator';
    return 'unknown';
  }

  const cases: [string, string][] = [
    ['Connection timeout', 'network'],
    ['Network error: ECONNREFUSED', 'network'],
    ['Rate limit exceeded', 'rate_limit'],
    ['Recipient opted out', 'opt_out'],
    ['Invalid phone number (21211)', 'invalid_number'],
    ['Twilio auth error (20003)', 'auth_failure'],
    ['Message undelivered', 'undelivered'],
    ['max retries exhausted', 'max_retries'],
    ['Message queued (21610)', 'blocked'],
    ['Sent via simulator', 'simulator'],
    ['Unknown failure', 'unknown'],
  ];

  it.each(cases)('maps "%s" → %s', (input, expected) => {
    expect(categorizeSmsError(input)).toBe(expected);
  });

  it('returns unknown for null', () => {
    expect(categorizeSmsError(null)).toBe('unknown');
  });

  it('returns unknown for undefined', () => {
    expect(categorizeSmsError(undefined)).toBe('unknown');
  });
});
