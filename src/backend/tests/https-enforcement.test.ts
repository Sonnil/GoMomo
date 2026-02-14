// ============================================================
// HTTPS Enforcement Tests
//
// Verifies:
//  1. isHttpsRequired() reflects REQUIRE_HTTPS env var
//  2. getEffectiveScheme() reads X-Forwarded-Proto correctly
//  3. REQUIRE_HTTPS=false: plain HTTP requests pass through
//  4. REQUIRE_HTTPS=true: plain HTTP requests get 403
//  5. REQUIRE_HTTPS=true + X-Forwarded-Proto: https passes
//  6. /health is exempt even when REQUIRE_HTTPS=true
//  7. logHttpsPolicy() doesn't throw in either mode
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock hoisting
const mockEnv = vi.hoisted(() => ({
  REQUIRE_HTTPS: 'false',
  NODE_ENV: 'development',
  CORS_ORIGIN: 'http://localhost:5173',
  CORS_ALLOWED_ORIGINS: '',
  CORS_ALLOW_CREDENTIALS: 'true',
  PILOT_MODE: 'false',
}));

vi.mock('../src/config/env.js', () => ({
  env: mockEnv,
}));

import {
  isHttpsRequired,
  getEffectiveScheme,
  logHttpsPolicy,
} from '../src/config/https.js';

// ── Helpers ──────────────────────────────────────────────────

/** Build a minimal mock Fastify request */
function mockRequest(opts: {
  url?: string;
  protocol?: string;
  headers?: Record<string, string>;
}): any {
  return {
    url: opts.url ?? '/api/test',
    protocol: opts.protocol ?? 'http',
    headers: opts.headers ?? {},
  };
}

function resetEnv() {
  mockEnv.REQUIRE_HTTPS = 'false';
  mockEnv.NODE_ENV = 'development';
}

// ── Tests ────────────────────────────────────────────────────

describe('HTTPS enforcement', () => {
  beforeEach(() => {
    resetEnv();
  });

  // ── 1. isHttpsRequired ─────────────────────────────────────

  describe('isHttpsRequired()', () => {
    it('returns false when REQUIRE_HTTPS=false', () => {
      mockEnv.REQUIRE_HTTPS = 'false';
      expect(isHttpsRequired()).toBe(false);
    });

    it('returns true when REQUIRE_HTTPS=true', () => {
      mockEnv.REQUIRE_HTTPS = 'true';
      expect(isHttpsRequired()).toBe(true);
    });
  });

  // ── 2. getEffectiveScheme ──────────────────────────────────

  describe('getEffectiveScheme()', () => {
    it('returns "http" when no forwarded header and protocol=http', () => {
      const req = mockRequest({ protocol: 'http' });
      expect(getEffectiveScheme(req)).toBe('http');
    });

    it('returns "https" when no forwarded header and protocol=https', () => {
      const req = mockRequest({ protocol: 'https' });
      expect(getEffectiveScheme(req)).toBe('https');
    });

    it('returns "https" from X-Forwarded-Proto header', () => {
      const req = mockRequest({
        protocol: 'http',
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(getEffectiveScheme(req)).toBe('https');
    });

    it('returns "http" from X-Forwarded-Proto header when explicitly http', () => {
      const req = mockRequest({
        protocol: 'http',
        headers: { 'x-forwarded-proto': 'http' },
      });
      expect(getEffectiveScheme(req)).toBe('http');
    });

    it('handles comma-separated X-Forwarded-Proto (uses first)', () => {
      const req = mockRequest({
        protocol: 'http',
        headers: { 'x-forwarded-proto': 'https, http' },
      });
      expect(getEffectiveScheme(req)).toBe('https');
    });

    it('falls back to protocol when X-Forwarded-Proto is empty', () => {
      const req = mockRequest({
        protocol: 'http',
        headers: { 'x-forwarded-proto': '' },
      });
      expect(getEffectiveScheme(req)).toBe('http');
    });

    it('falls back to protocol when X-Forwarded-Proto is garbage', () => {
      const req = mockRequest({
        protocol: 'http',
        headers: { 'x-forwarded-proto': 'ftp' },
      });
      // ftp is not 'http' or 'https', so falls back to protocol
      expect(getEffectiveScheme(req)).toBe('http');
    });
  });

  // ── 3. registerHttpsEnforcement via Fastify inject ─────────
  //
  // We test the full hook behavior by building a real Fastify
  // instance with the hook registered, then using inject().

  describe('Fastify integration', () => {
    // Dynamically import so mocked env is used
    async function buildApp(requireHttps: boolean) {
      mockEnv.REQUIRE_HTTPS = requireHttps ? 'true' : 'false';

      // Dynamic import to pick up the latest mockEnv value
      const { registerHttpsEnforcement } = await import('../src/config/https.js');
      const Fastify = (await import('fastify')).default;

      const app = Fastify({ trustProxy: requireHttps });

      // Register the HTTPS hook
      registerHttpsEnforcement(app);

      // Add test routes
      app.get('/api/test', async () => ({ ok: true }));
      app.get('/health', async () => ({ status: 'ok' }));
      app.post('/api/data', async () => ({ created: true }));

      await app.ready();
      return app;
    }

    it('REQUIRE_HTTPS=false: plain HTTP passes through', async () => {
      const app = await buildApp(false);
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          // No X-Forwarded-Proto → plain HTTP
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    });

    it('REQUIRE_HTTPS=true: plain HTTP is rejected with 403', async () => {
      const app = await buildApp(true);
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          // No X-Forwarded-Proto → plain HTTP
        });
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('HTTPS required');
      } finally {
        await app.close();
      }
    });

    it('REQUIRE_HTTPS=true + X-Forwarded-Proto: https passes', async () => {
      const app = await buildApp(true);
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/test',
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    });

    it('REQUIRE_HTTPS=true: POST also rejected on plain HTTP', async () => {
      const app = await buildApp(true);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/data',
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('REQUIRE_HTTPS=true: /health is exempt (returns 200)', async () => {
      const app = await buildApp(true);
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/health',
          // No X-Forwarded-Proto → plain HTTP, but /health is exempt
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({ status: 'ok' });
      } finally {
        await app.close();
      }
    });

    it('REQUIRE_HTTPS=true: /health?check=1 is exempt', async () => {
      const app = await buildApp(true);
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/health?check=1',
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  // ── 4. logHttpsPolicy ──────────────────────────────────────

  describe('logHttpsPolicy()', () => {
    it('does not throw when REQUIRE_HTTPS=false', () => {
      mockEnv.REQUIRE_HTTPS = 'false';
      expect(() => logHttpsPolicy()).not.toThrow();
    });

    it('does not throw when REQUIRE_HTTPS=true', () => {
      mockEnv.REQUIRE_HTTPS = 'true';
      expect(() => logHttpsPolicy()).not.toThrow();
    });
  });
});
