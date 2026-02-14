/**
 * Tests for GET /health/email endpoint — response shape + logic.
 *
 * Mirrors the inline handler in index.ts. Tests the resolution logic
 * (dev_mode, effective_provider, credentials_present) without needing
 * a running server.
 */
import { describe, it, expect } from 'vitest';

// ── Helper mirrors /health/email handler logic in index.ts ──

interface EmailHealthEnv {
  EMAIL_PROVIDER: 'resend' | 'postmark' | 'console';
  EMAIL_DEV_MODE: 'true' | 'false';
  RESEND_API_KEY: string;
  POSTMARK_API_TOKEN: string;
  REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: 'true' | 'false';
  EMAIL_VERIFICATION_TTL_MINUTES: number;
  EMAIL_VERIFICATION_RATE_LIMIT: number;
}

function getEmailHealthResponse(env: EmailHealthEnv) {
  const devMode = env.EMAIL_DEV_MODE === 'true';
  const provider = env.EMAIL_PROVIDER;
  const effectiveProvider = devMode ? 'console' : provider;
  const credentialsPresent =
    provider === 'resend'   ? !!env.RESEND_API_KEY :
    provider === 'postmark' ? !!env.POSTMARK_API_TOKEN :
    true; // console needs no credentials

  return {
    status: 'ok' as const,
    provider,
    dev_mode: devMode,
    effective_provider: effectiveProvider,
    credentials_present: credentialsPresent,
    email_gate_enabled: env.REQUIRE_EMAIL_AFTER_FIRST_MESSAGE === 'true',
    ttl_minutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
    rate_limit: env.EMAIL_VERIFICATION_RATE_LIMIT,
  };
}

// ── Defaults for test helper ────────────────────────────────

const BASE_ENV: EmailHealthEnv = {
  EMAIL_PROVIDER: 'console',
  EMAIL_DEV_MODE: 'true',
  RESEND_API_KEY: '',
  POSTMARK_API_TOKEN: '',
  REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: 'true',
  EMAIL_VERIFICATION_TTL_MINUTES: 10,
  EMAIL_VERIFICATION_RATE_LIMIT: 5,
};

// ── Tests ───────────────────────────────────────────────────

describe('/health/email response shape', () => {
  it('returns all required fields', () => {
    const res = getEmailHealthResponse(BASE_ENV);
    expect(res).toHaveProperty('status', 'ok');
    expect(res).toHaveProperty('provider');
    expect(res).toHaveProperty('dev_mode');
    expect(res).toHaveProperty('effective_provider');
    expect(res).toHaveProperty('credentials_present');
    expect(res).toHaveProperty('email_gate_enabled');
    expect(res).toHaveProperty('ttl_minutes');
    expect(res).toHaveProperty('rate_limit');
  });

  it('status is always "ok"', () => {
    const res = getEmailHealthResponse(BASE_ENV);
    expect(res.status).toBe('ok');
  });
});

describe('/health/email dev_mode logic', () => {
  it('dev_mode=true → effective_provider is console regardless of EMAIL_PROVIDER', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      EMAIL_PROVIDER: 'resend',
      EMAIL_DEV_MODE: 'true',
    });
    expect(res.dev_mode).toBe(true);
    expect(res.effective_provider).toBe('console');
    expect(res.provider).toBe('resend');
  });

  it('dev_mode=false → effective_provider matches EMAIL_PROVIDER', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      EMAIL_PROVIDER: 'resend',
      EMAIL_DEV_MODE: 'false',
      RESEND_API_KEY: 're_test_key',
    });
    expect(res.dev_mode).toBe(false);
    expect(res.effective_provider).toBe('resend');
  });
});

describe('/health/email credentials_present', () => {
  it('resend with key → credentials_present true', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_key_123',
    });
    expect(res.credentials_present).toBe(true);
  });

  it('resend without key → credentials_present false', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: '',
    });
    expect(res.credentials_present).toBe(false);
  });

  it('postmark with token → credentials_present true', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      EMAIL_PROVIDER: 'postmark',
      POSTMARK_API_TOKEN: 'pmk-test-token',
    });
    expect(res.credentials_present).toBe(true);
  });

  it('postmark without token → credentials_present false', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      EMAIL_PROVIDER: 'postmark',
      POSTMARK_API_TOKEN: '',
    });
    expect(res.credentials_present).toBe(false);
  });

  it('console provider → credentials_present always true', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      EMAIL_PROVIDER: 'console',
      RESEND_API_KEY: '',
      POSTMARK_API_TOKEN: '',
    });
    expect(res.credentials_present).toBe(true);
  });
});

describe('/health/email gate + verification config', () => {
  it('REQUIRE_EMAIL_AFTER_FIRST_MESSAGE=true → email_gate_enabled true', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: 'true',
    });
    expect(res.email_gate_enabled).toBe(true);
  });

  it('REQUIRE_EMAIL_AFTER_FIRST_MESSAGE=false → email_gate_enabled false', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: 'false',
    });
    expect(res.email_gate_enabled).toBe(false);
  });

  it('passes through ttl_minutes and rate_limit from env', () => {
    const res = getEmailHealthResponse({
      ...BASE_ENV,
      EMAIL_VERIFICATION_TTL_MINUTES: 15,
      EMAIL_VERIFICATION_RATE_LIMIT: 3,
    });
    expect(res.ttl_minutes).toBe(15);
    expect(res.rate_limit).toBe(3);
  });
});
