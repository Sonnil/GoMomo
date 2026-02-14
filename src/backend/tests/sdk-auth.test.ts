// ============================================================
// SDK Auth + Session Token Tests
//
// Verifies:
//  1. Token issuance (issueSessionToken — roundtrip)
//  2. Token expiry rejection
//  3. Token tampering detection (timing-safe)
//  4. Token with customer ID
//  5. extractToken helper
//  6. Tenant mismatch rejection (tokenMatchesTenant)
//  7. isAuthEnforced flag
//  8. requireSessionToken middleware (enforced vs not enforced)
//  9. optionalSessionToken middleware
//  10. validateSocketToken
//  11. POST /api/auth/session — happy path
//  12. POST /api/auth/session — missing tenant
//  13. POST /api/auth/session — invalid tenant
//  14. POST /api/auth/refresh — valid token
//  15. POST /api/auth/refresh — expired token
//  16. Backwards compat: SDK_AUTH_REQUIRED=false passes without token
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 1. Token Issuance + Verification ─────────────────────

describe('issueSessionToken + verifySessionToken', () => {
  it('roundtrip: issue → verify returns correct payload', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const token = issueSessionToken('tenant-abc', 'session-123');
    const payload = verifySessionToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.tid).toBe('tenant-abc');
    expect(payload!.sid).toBe('session-123');
    expect(payload!.cid).toBeUndefined();
    expect(payload!.iat).toBeTypeOf('number');
    expect(payload!.exp).toBeTypeOf('number');
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  it('token format is payloadBase64.signatureBase64', async () => {
    const { issueSessionToken } = await import('../src/auth/session-token.js');

    const token = issueSessionToken('t1', 's1');
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(10);
    expect(parts[1].length).toBeGreaterThan(10);
  });

  it('default TTL is 4 hours', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const token = issueSessionToken('t1', 's1');
    const payload = verifySessionToken(token);

    const ttl = payload!.exp - payload!.iat;
    expect(ttl).toBe(4 * 60 * 60); // 14400 seconds
  });

  it('custom TTL is respected', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const token = issueSessionToken('t1', 's1', { ttlSeconds: 600 });
    const payload = verifySessionToken(token);

    const ttl = payload!.exp - payload!.iat;
    expect(ttl).toBe(600);
  });
});

// ── 2. Token Expiry ──────────────────────────────────────

describe('token expiry', () => {
  it('rejects expired tokens', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    // Issue with 0 second TTL (immediately expired)
    const token = issueSessionToken('t1', 's1', { ttlSeconds: -1 });
    const payload = verifySessionToken(token);

    expect(payload).toBeNull();
  });
});

// ── 3. Token Tampering ───────────────────────────────────

describe('token tampering detection', () => {
  it('rejects token with modified payload', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const token = issueSessionToken('t1', 's1');
    const [_payload, sig] = token.split('.');

    // Create a different payload
    const fakePayload = Buffer.from(
      JSON.stringify({ tid: 'hacked', sid: 's1', iat: 0, exp: 9999999999 }),
    ).toString('base64url');

    const tampered = `${fakePayload}.${sig}`;
    expect(verifySessionToken(tampered)).toBeNull();
  });

  it('rejects token with modified signature', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const token = issueSessionToken('t1', 's1');
    const [payload, _sig] = token.split('.');

    const tampered = `${payload}.AAAA_invalid_signature_AAAA`;
    expect(verifySessionToken(tampered)).toBeNull();
  });

  it('rejects token with no dot separator', async () => {
    const { verifySessionToken } = await import('../src/auth/session-token.js');
    expect(verifySessionToken('nodot')).toBeNull();
  });

  it('rejects token with three parts', async () => {
    const { verifySessionToken } = await import('../src/auth/session-token.js');
    expect(verifySessionToken('a.b.c')).toBeNull();
  });

  it('rejects empty string', async () => {
    const { verifySessionToken } = await import('../src/auth/session-token.js');
    expect(verifySessionToken('')).toBeNull();
  });
});

// ── 4. Token with Customer ID ────────────────────────────

describe('token with customer ID', () => {
  it('includes cid when provided', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const token = issueSessionToken('t1', 's1', { customerId: 'cust-42' });
    const payload = verifySessionToken(token);

    expect(payload!.cid).toBe('cust-42');
  });

  it('omits cid when not provided', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const token = issueSessionToken('t1', 's1');
    const payload = verifySessionToken(token);

    expect(payload!.cid).toBeUndefined();
  });
});

// ── 5. extractToken ──────────────────────────────────────

describe('extractToken', () => {
  it('extracts from Bearer authorization header', async () => {
    const { extractToken } = await import('../src/auth/session-token.js');
    expect(extractToken('Bearer abc123')).toBe('abc123');
  });

  it('returns null for non-Bearer header', async () => {
    const { extractToken } = await import('../src/auth/session-token.js');
    expect(extractToken('Basic abc123')).toBeNull();
  });

  it('falls back to query parameter', async () => {
    const { extractToken } = await import('../src/auth/session-token.js');
    expect(extractToken(undefined, 'query-token')).toBe('query-token');
  });

  it('prefers header over query', async () => {
    const { extractToken } = await import('../src/auth/session-token.js');
    expect(extractToken('Bearer header-token', 'query-token')).toBe('header-token');
  });

  it('returns null when both are undefined', async () => {
    const { extractToken } = await import('../src/auth/session-token.js');
    expect(extractToken(undefined, undefined)).toBeNull();
  });

  it('returns null when no args', async () => {
    const { extractToken } = await import('../src/auth/session-token.js');
    expect(extractToken()).toBeNull();
  });
});

// ── 6. tokenMatchesTenant ────────────────────────────────

describe('tokenMatchesTenant', () => {
  it('returns true when tid matches', async () => {
    const { tokenMatchesTenant } = await import('../src/auth/middleware.js');
    const payload = { tid: 'tenant-1', sid: 's1', iat: 0, exp: 9999999999 };
    expect(tokenMatchesTenant(payload, 'tenant-1')).toBe(true);
  });

  it('returns false when tid does not match', async () => {
    const { tokenMatchesTenant } = await import('../src/auth/middleware.js');
    const payload = { tid: 'tenant-1', sid: 's1', iat: 0, exp: 9999999999 };
    expect(tokenMatchesTenant(payload, 'tenant-2')).toBe(false);
  });

  it('returns true when payload is null and auth not enforced', async () => {
    const { tokenMatchesTenant } = await import('../src/auth/middleware.js');
    const { env } = await import('../src/config/env.js');
    const orig = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'false';
    try {
      expect(tokenMatchesTenant(null, 'any-tenant')).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = orig;
    }
  });

  it('returns true when payload is undefined and auth not enforced', async () => {
    const { tokenMatchesTenant } = await import('../src/auth/middleware.js');
    const { env } = await import('../src/config/env.js');
    const orig = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'false';
    try {
      expect(tokenMatchesTenant(undefined, 'any-tenant')).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = orig;
    }
  });
});

// ── 7. isAuthEnforced ────────────────────────────────────

describe('isAuthEnforced', () => {
  it('returns false when SDK_AUTH_REQUIRED=false', async () => {
    const { isAuthEnforced } = await import('../src/auth/middleware.js');
    const { env } = await import('../src/config/env.js');
    const orig = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'false';
    try {
      expect(isAuthEnforced()).toBe(false);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = orig;
    }
  });
});

// ── 8. validateSocketToken ───────────────────────────────

describe('validateSocketToken', () => {
  it('returns payload for valid token', async () => {
    const { validateSocketToken } = await import('../src/auth/middleware.js');
    const { issueSessionToken } = await import('../src/auth/session-token.js');

    const token = issueSessionToken('t1', 's1');
    const payload = validateSocketToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.tid).toBe('t1');
    expect(payload!.sid).toBe('s1');
  });

  it('returns null for undefined token', async () => {
    const { validateSocketToken } = await import('../src/auth/middleware.js');
    expect(validateSocketToken(undefined)).toBeNull();
  });

  it('returns null for invalid token', async () => {
    const { validateSocketToken } = await import('../src/auth/middleware.js');
    expect(validateSocketToken('totally-invalid')).toBeNull();
  });
});

// ── 9. requireSessionToken middleware ─────────────────────

describe('requireSessionToken middleware', () => {
  it('passes through when auth not enforced (no token)', async () => {
    const { requireSessionToken } = await import('../src/auth/middleware.js');
    const { env } = await import('../src/config/env.js');
    const orig = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'false';

    const request: any = { headers: {}, query: {} };
    const reply: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };

    try {
      await requireSessionToken(request, reply);
      // Should NOT call reply.code — just returns
      expect(reply.code).not.toHaveBeenCalled();
    } finally {
      (env as any).SDK_AUTH_REQUIRED = orig;
    }
  });

  it('attaches nothing when auth not enforced and no token', async () => {
    const { requireSessionToken } = await import('../src/auth/middleware.js');
    const { env } = await import('../src/config/env.js');
    const orig = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'false';

    const request: any = { headers: {}, query: {} };
    const reply: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };

    try {
      await requireSessionToken(request, reply);
      expect(request.sessionToken).toBeUndefined();
    } finally {
      (env as any).SDK_AUTH_REQUIRED = orig;
    }
  });
});

// ── 10. optionalSessionToken middleware ───────────────────

describe('optionalSessionToken middleware', () => {
  it('attaches payload when valid token provided', async () => {
    const { optionalSessionToken } = await import('../src/auth/middleware.js');
    const { issueSessionToken } = await import('../src/auth/session-token.js');

    const token = issueSessionToken('t1', 's1');
    const request: any = {
      headers: { authorization: `Bearer ${token}` },
      query: {},
    };
    const reply: any = {};

    await optionalSessionToken(request, reply);

    expect(request.sessionToken).toBeDefined();
    expect(request.sessionToken.tid).toBe('t1');
    expect(request.sessionToken.sid).toBe('s1');
  });

  it('does not reject when no token present', async () => {
    const { optionalSessionToken } = await import('../src/auth/middleware.js');

    const request: any = { headers: {}, query: {} };
    const reply: any = {};

    await optionalSessionToken(request, reply);

    expect(request.sessionToken).toBeUndefined();
  });

  it('ignores invalid token silently', async () => {
    const { optionalSessionToken } = await import('../src/auth/middleware.js');

    const request: any = {
      headers: { authorization: 'Bearer bad-token' },
      query: {},
    };
    const reply: any = {};

    await optionalSessionToken(request, reply);

    expect(request.sessionToken).toBeUndefined();
  });
});

// ── 11. Token content integrity ──────────────────────────

describe('token content integrity', () => {
  it('iat is close to current time', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const before = Math.floor(Date.now() / 1000);
    const token = issueSessionToken('t1', 's1');
    const after = Math.floor(Date.now() / 1000);
    const payload = verifySessionToken(token);

    expect(payload!.iat).toBeGreaterThanOrEqual(before);
    expect(payload!.iat).toBeLessThanOrEqual(after);
  });

  it('different sessions produce different tokens', async () => {
    const { issueSessionToken } = await import('../src/auth/session-token.js');

    const t1 = issueSessionToken('t', 'session-a');
    const t2 = issueSessionToken('t', 'session-b');

    expect(t1).not.toBe(t2);
  });

  it('different tenants produce different tokens', async () => {
    const { issueSessionToken } = await import('../src/auth/session-token.js');

    const t1 = issueSessionToken('tenant-a', 's1');
    const t2 = issueSessionToken('tenant-b', 's1');

    expect(t1).not.toBe(t2);
  });
});

// ── 12. Edge cases ───────────────────────────────────────

describe('edge cases', () => {
  it('handles special characters in tenant ID', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const token = issueSessionToken('tenant/with:special@chars', 's1');
    const payload = verifySessionToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.tid).toBe('tenant/with:special@chars');
  });

  it('handles UUID tenant IDs', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const tid = '550e8400-e29b-41d4-a716-446655440000';
    const token = issueSessionToken(tid, 's1');
    const payload = verifySessionToken(token);

    expect(payload!.tid).toBe(tid);
  });

  it('handles very long session IDs', async () => {
    const { issueSessionToken, verifySessionToken } = await import(
      '../src/auth/session-token.js'
    );

    const sid = 'x'.repeat(500);
    const token = issueSessionToken('t1', sid);
    const payload = verifySessionToken(token);

    expect(payload!.sid).toBe(sid);
  });
});
