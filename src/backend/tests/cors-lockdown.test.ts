// ============================================================
// CORS Lockdown Tests
//
// Verifies:
//  1. Dev mode: localhost origins are allowed
//  2. Dev mode: CORS_ORIGIN (legacy) origins are allowed
//  3. Dev mode: non-localhost, non-listed origins are blocked
//  4. Strict mode: allowlisted origins pass
//  5. Strict mode: non-listed origins are blocked
//  6. Both modes: missing origin (server-to-server) is allowed
//  7. isStrictCors respects NODE_ENV and PILOT_MODE
//  8. getCorsOptions / getSocketIoCorsOptions shape
//  9. fastifyCorsOrigin callback works correctly
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock hoisting, so mockEnv is available in the factory.
const mockEnv = vi.hoisted(() => ({
  NODE_ENV: 'development',
  PILOT_MODE: 'false',
  CORS_ORIGIN: 'http://localhost:5173',
  CORS_ALLOWED_ORIGINS: '',
  CORS_ALLOW_CREDENTIALS: 'true',
}));

vi.mock('../src/config/env.js', () => ({
  env: mockEnv,
}));

// Import after mock is set up
import {
  isStrictCors,
  validateOrigin,
  fastifyCorsOrigin,
  getCorsOptions,
  getSocketIoCorsOptions,
  logCorsPolicy,
} from '../src/config/cors.js';

// ── Helpers ──────────────────────────────────────────────────

function callbackResult(origin: string | undefined): Promise<boolean> {
  return new Promise((resolve, reject) => {
    fastifyCorsOrigin(origin, (err, allow) => {
      if (err) return reject(err);
      resolve(allow);
    });
  });
}

function resetEnvToDevMode() {
  mockEnv.NODE_ENV = 'development';
  mockEnv.PILOT_MODE = 'false';
  mockEnv.CORS_ORIGIN = 'http://localhost:5173';
  mockEnv.CORS_ALLOWED_ORIGINS = '';
  mockEnv.CORS_ALLOW_CREDENTIALS = 'true';
}

function setStrictMode(opts: {
  via?: 'production' | 'pilot';
  allowedOrigins?: string;
  corsOrigin?: string;
} = {}) {
  if (opts.via === 'pilot') {
    mockEnv.NODE_ENV = 'development';
    mockEnv.PILOT_MODE = 'true';
  } else {
    mockEnv.NODE_ENV = 'production';
    mockEnv.PILOT_MODE = 'false';
  }
  mockEnv.CORS_ALLOWED_ORIGINS = opts.allowedOrigins ?? '';
  mockEnv.CORS_ORIGIN = opts.corsOrigin ?? '';
}

// ── Tests ────────────────────────────────────────────────────

describe('CORS lockdown', () => {
  beforeEach(() => {
    resetEnvToDevMode();
  });

  // ── 1. isStrictCors ────────────────────────────────────────

  describe('isStrictCors()', () => {
    it('returns false in dev mode', () => {
      expect(isStrictCors()).toBe(false);
    });

    it('returns true when NODE_ENV=production', () => {
      mockEnv.NODE_ENV = 'production';
      expect(isStrictCors()).toBe(true);
    });

    it('returns true when PILOT_MODE=true', () => {
      mockEnv.PILOT_MODE = 'true';
      expect(isStrictCors()).toBe(true);
    });

    it('returns true when both production and PILOT_MODE', () => {
      mockEnv.NODE_ENV = 'production';
      mockEnv.PILOT_MODE = 'true';
      expect(isStrictCors()).toBe(true);
    });
  });

  // ── 2. Dev mode ────────────────────────────────────────────

  describe('dev mode (permissive)', () => {
    it('allows http://localhost:5173', () => {
      expect(validateOrigin('http://localhost:5173')).toBe(true);
    });

    it('allows http://localhost:3000 (any localhost port)', () => {
      expect(validateOrigin('http://localhost:3000')).toBe(true);
    });

    it('allows https://localhost:8443', () => {
      expect(validateOrigin('https://localhost:8443')).toBe(true);
    });

    it('allows http://127.0.0.1:5173', () => {
      expect(validateOrigin('http://127.0.0.1:5173')).toBe(true);
    });

    it('allows http://[::1]:5173', () => {
      expect(validateOrigin('http://[::1]:5173')).toBe(true);
    });

    it('allows CORS_ORIGIN value', () => {
      mockEnv.CORS_ORIGIN = 'https://my-ngrok.io';
      expect(validateOrigin('https://my-ngrok.io')).toBe(true);
    });

    it('blocks non-localhost, non-CORS_ORIGIN origin', () => {
      expect(validateOrigin('https://evil.com')).toBe(false);
    });

    it('allows missing origin (server-to-server)', () => {
      expect(validateOrigin(undefined)).toBe(true);
    });
  });

  // ── 3. Strict mode via NODE_ENV=production ─────────────────

  describe('strict mode (NODE_ENV=production)', () => {
    beforeEach(() => {
      setStrictMode({
        via: 'production',
        allowedOrigins: 'https://pilot.gomomo-demo.com,https://admin.gomomo-demo.com',
      });
    });

    it('allows listed origin (pilot)', () => {
      expect(validateOrigin('https://pilot.gomomo-demo.com')).toBe(true);
    });

    it('allows listed origin (admin)', () => {
      expect(validateOrigin('https://admin.gomomo-demo.com')).toBe(true);
    });

    it('blocks unlisted origin', () => {
      expect(validateOrigin('https://evil.com')).toBe(false);
    });

    it('blocks localhost in production', () => {
      expect(validateOrigin('http://localhost:5173')).toBe(false);
    });

    it('allows missing origin (server-to-server)', () => {
      expect(validateOrigin(undefined)).toBe(true);
    });

    it('allows legacy CORS_ORIGIN in strict mode too', () => {
      setStrictMode({
        via: 'production',
        allowedOrigins: 'https://pilot.gomomo-demo.com',
        corsOrigin: 'https://legacy.example.com',
      });
      expect(validateOrigin('https://legacy.example.com')).toBe(true);
    });

    it('blocks everything if no origins configured', () => {
      setStrictMode({ via: 'production', allowedOrigins: '', corsOrigin: '' });
      expect(validateOrigin('https://pilot.gomomo-demo.com')).toBe(false);
      expect(validateOrigin('http://localhost:5173')).toBe(false);
    });
  });

  // ── 4. Strict mode via PILOT_MODE ──────────────────────────

  describe('strict mode (PILOT_MODE=true)', () => {
    beforeEach(() => {
      setStrictMode({
        via: 'pilot',
        allowedOrigins: 'https://pilot.gomomo-demo.com',
      });
    });

    it('allows listed origin', () => {
      expect(validateOrigin('https://pilot.gomomo-demo.com')).toBe(true);
    });

    it('blocks unlisted origin', () => {
      expect(validateOrigin('https://evil.com')).toBe(false);
    });

    it('blocks localhost', () => {
      expect(validateOrigin('http://localhost:5173')).toBe(false);
    });
  });

  // ── 5. fastifyCorsOrigin callback ──────────────────────────

  describe('fastifyCorsOrigin()', () => {
    it('calls back with true for allowed origin', async () => {
      const result = await callbackResult('http://localhost:5173');
      expect(result).toBe(true);
    });

    it('calls back with false for blocked origin', async () => {
      const result = await callbackResult('https://evil.com');
      expect(result).toBe(false);
    });

    it('calls back with true for undefined origin', async () => {
      const result = await callbackResult(undefined);
      expect(result).toBe(true);
    });
  });

  // ── 6. getCorsOptions / getSocketIoCorsOptions shape ───────

  describe('getCorsOptions()', () => {
    it('returns expected shape', () => {
      const opts = getCorsOptions();
      expect(opts).toHaveProperty('origin');
      expect(typeof opts.origin).toBe('function');
      expect(opts.methods).toEqual(expect.arrayContaining(['GET', 'POST', 'OPTIONS']));
      expect(opts.credentials).toBe(true);
    });

    it('credentials false when CORS_ALLOW_CREDENTIALS=false', () => {
      mockEnv.CORS_ALLOW_CREDENTIALS = 'false';
      const opts = getCorsOptions();
      expect(opts.credentials).toBe(false);
    });
  });

  describe('getSocketIoCorsOptions()', () => {
    it('returns expected shape', () => {
      const opts = getSocketIoCorsOptions();
      expect(opts).toHaveProperty('origin');
      expect(typeof opts.origin).toBe('function');
      expect(opts.methods).toEqual(expect.arrayContaining(['GET', 'POST']));
      expect(opts.credentials).toBe(true);
    });
  });

  // ── 7. logCorsPolicy (no crash, logs expected strings) ─────

  describe('logCorsPolicy()', () => {
    it('does not throw in dev mode', () => {
      expect(() => logCorsPolicy()).not.toThrow();
    });

    it('does not throw in strict mode', () => {
      setStrictMode({
        via: 'production',
        allowedOrigins: 'https://example.com',
      });
      expect(() => logCorsPolicy()).not.toThrow();
    });

    it('warns when no origins configured in strict mode', () => {
      setStrictMode({ via: 'production', allowedOrigins: '', corsOrigin: '' });
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logCorsPolicy();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('No CORS_ALLOWED_ORIGINS'),
      );
      spy.mockRestore();
    });
  });

  // ── 8. Edge cases ──────────────────────────────────────────

  describe('edge cases', () => {
    it('handles whitespace in CORS_ALLOWED_ORIGINS', () => {
      setStrictMode({
        via: 'production',
        allowedOrigins: '  https://a.com , https://b.com  ',
      });
      expect(validateOrigin('https://a.com')).toBe(true);
      expect(validateOrigin('https://b.com')).toBe(true);
    });

    it('deduplicates origins between CORS_ORIGIN and CORS_ALLOWED_ORIGINS', () => {
      setStrictMode({
        via: 'production',
        allowedOrigins: 'https://pilot.com',
        corsOrigin: 'https://pilot.com',
      });
      // Just ensure it doesn't break and still allows
      expect(validateOrigin('https://pilot.com')).toBe(true);
    });

    it('handles malformed origin gracefully in dev mode', () => {
      // Not a valid URL → isLocalhostOrigin returns false
      expect(validateOrigin('not-a-url')).toBe(false);
    });
  });
});
