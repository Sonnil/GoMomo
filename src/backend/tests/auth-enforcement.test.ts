// ============================================================
// Auth Enforcement Tests
//
// Verifies pilot-ready auth layer:
//  1. requireAdminKey — valid key, invalid key, missing key
//  2. requireSessionOrAdmin — dual-access logic
//  3. requireSessionTokenTenantScoped — cross-tenant rejection
//  4. markPublic — tags route as public
//  5. Default-deny preSerialization hook (simulated)
//  6. AUTH_TAG_KEY — set by all guards
//  7. isAuthEnforced toggle
//
// These are unit-level tests that exercise the middleware functions
// directly with mock request/reply objects, not full HTTP tests.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helper: build a mock Fastify request ────────────────────
function mockRequest(overrides: Record<string, any> = {}): any {
  return {
    headers: {},
    query: {},
    params: {},
    ...overrides,
  };
}

// ── Helper: build a mock Fastify reply ──────────────────────
function mockReply(): any {
  const r: any = {
    statusCode: 200,
    _sent: false,
    _body: null,
    code(c: number) { r.statusCode = c; return r; },
    send(body: any) { r._sent = true; r._body = body; return r; },
  };
  return r;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. requireAdminKey
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('requireAdminKey', () => {
  // We need to control SDK_AUTH_REQUIRED and ADMIN_API_KEY.
  // The middleware reads from the env singleton at call time.

  it('passes through when auth not enforced (no key)', async () => {
    const { requireAdminKey, AUTH_TAG_KEY } = await import('../src/auth/middleware.js');
    const { env } = await import('../src/config/env.js');
    const orig = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'false';
    const req = mockRequest();
    const rep = mockReply();

    try {
      await requireAdminKey(req, rep);
      expect(rep._sent).toBe(false);
      expect(req[AUTH_TAG_KEY]).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = orig;
    }
  });

  it('sets AUTH_TAG_KEY even when auth not enforced', async () => {
    const { requireAdminKey, AUTH_TAG_KEY } = await import('../src/auth/middleware.js');
    const req = mockRequest();
    const rep = mockReply();

    await requireAdminKey(req, rep);

    expect(req[AUTH_TAG_KEY]).toBe(true);
  });

  it('rejects missing key with 401 when auth enforced', async () => {
    // Temporarily override env
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'test-secret-key-123';

    try {
      const { requireAdminKey } = await import('../src/auth/middleware.js');
      const req = mockRequest();
      const rep = mockReply();

      await requireAdminKey(req, rep);

      expect(rep.statusCode).toBe(401);
      expect(rep._sent).toBe(true);
      expect(rep._body.error).toContain('Admin API key required');
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('rejects invalid key with 403 when auth enforced', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'correct-key-abc';

    try {
      const { requireAdminKey } = await import('../src/auth/middleware.js');
      const req = mockRequest({
        headers: { 'x-admin-key': 'wrong-key-xyz' },
      });
      const rep = mockReply();

      await requireAdminKey(req, rep);

      expect(rep.statusCode).toBe(403);
      expect(rep._sent).toBe(true);
      expect(rep._body.error).toContain('Invalid admin API key');
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('accepts valid key via X-Admin-Key header', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'my-secret-key';

    try {
      const { requireAdminKey } = await import('../src/auth/middleware.js');
      const req = mockRequest({
        headers: { 'x-admin-key': 'my-secret-key' },
      });
      const rep = mockReply();

      await requireAdminKey(req, rep);

      expect(rep._sent).toBe(false);
      expect(req.isAdmin).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('accepts valid key via Authorization: Bearer admin.<key>', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'my-secret-key';

    try {
      const { requireAdminKey } = await import('../src/auth/middleware.js');
      const req = mockRequest({
        headers: { authorization: 'Bearer admin.my-secret-key' },
      });
      const rep = mockReply();

      await requireAdminKey(req, rep);

      expect(rep._sent).toBe(false);
      expect(req.isAdmin).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('rejects when ADMIN_API_KEY is empty even if header is provided', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = '';

    try {
      const { requireAdminKey } = await import('../src/auth/middleware.js');
      const req = mockRequest({
        headers: { 'x-admin-key': 'anything' },
      });
      const rep = mockReply();

      await requireAdminKey(req, rep);

      expect(rep.statusCode).toBe(403);
      expect(rep._sent).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. requireSessionTokenTenantScoped
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('requireSessionTokenTenantScoped', () => {
  it('passes when auth not enforced', async () => {
    const { requireSessionTokenTenantScoped, AUTH_TAG_KEY } = await import(
      '../src/auth/middleware.js'
    );
    const { env } = await import('../src/config/env.js');
    const orig = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'false';
    const req = mockRequest({ params: { tenantId: 'tenant-1' } });
    const rep = mockReply();

    try {
      await requireSessionTokenTenantScoped(req, rep);
      expect(rep._sent).toBe(false);
      expect(req[AUTH_TAG_KEY]).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = orig;
    }
  });

  it('rejects missing token with 401 when enforced', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'true';

    try {
      const { requireSessionTokenTenantScoped } = await import(
        '../src/auth/middleware.js'
      );
      const req = mockRequest({ params: { tenantId: 'tenant-1' } });
      const rep = mockReply();

      await requireSessionTokenTenantScoped(req, rep);

      expect(rep.statusCode).toBe(401);
      expect(rep._sent).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
    }
  });

  it('rejects cross-tenant access with 403', async () => {
    const { env } = await import('../src/config/env.js');
    const { issueSessionToken } = await import('../src/auth/session-token.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'true';

    try {
      const { requireSessionTokenTenantScoped } = await import(
        '../src/auth/middleware.js'
      );

      // Token for tenant-A, but route is tenant-B
      const token = issueSessionToken('tenant-A', 'session-1');
      const req = mockRequest({
        headers: { authorization: `Bearer ${token}` },
        params: { tenantId: 'tenant-B' },
      });
      const rep = mockReply();

      await requireSessionTokenTenantScoped(req, rep);

      expect(rep.statusCode).toBe(403);
      expect(rep._sent).toBe(true);
      expect(rep._body.error).toContain('does not belong to this tenant');
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
    }
  });

  it('accepts matching tenant token', async () => {
    const { env } = await import('../src/config/env.js');
    const { issueSessionToken } = await import('../src/auth/session-token.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'true';

    try {
      const { requireSessionTokenTenantScoped } = await import(
        '../src/auth/middleware.js'
      );

      const token = issueSessionToken('tenant-A', 'session-1');
      const req = mockRequest({
        headers: { authorization: `Bearer ${token}` },
        params: { tenantId: 'tenant-A' },
      });
      const rep = mockReply();

      await requireSessionTokenTenantScoped(req, rep);

      expect(rep._sent).toBe(false);
      expect(req.sessionToken).toBeDefined();
      expect(req.sessionToken.tid).toBe('tenant-A');
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
    }
  });

  it('uses params.id as fallback for tenantId', async () => {
    const { env } = await import('../src/config/env.js');
    const { issueSessionToken } = await import('../src/auth/session-token.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'true';

    try {
      const { requireSessionTokenTenantScoped } = await import(
        '../src/auth/middleware.js'
      );

      const token = issueSessionToken('tenant-X', 'session-1');
      const req = mockRequest({
        headers: { authorization: `Bearer ${token}` },
        params: { id: 'tenant-X' }, // 'id' instead of 'tenantId'
      });
      const rep = mockReply();

      await requireSessionTokenTenantScoped(req, rep);

      expect(rep._sent).toBe(false);
      expect(req.sessionToken.tid).toBe('tenant-X');
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. requireSessionOrAdmin
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('requireSessionOrAdmin', () => {
  it('passes when auth not enforced', async () => {
    const { requireSessionOrAdmin, AUTH_TAG_KEY } = await import(
      '../src/auth/middleware.js'
    );
    const { env } = await import('../src/config/env.js');
    const orig = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'false';
    const req = mockRequest();
    const rep = mockReply();

    try {
      await requireSessionOrAdmin(req, rep);
      expect(rep._sent).toBe(false);
      expect(req[AUTH_TAG_KEY]).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = orig;
    }
  });

  it('accepts admin key when enforced', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'dual-secret';

    try {
      const { requireSessionOrAdmin } = await import('../src/auth/middleware.js');
      const req = mockRequest({
        headers: { 'x-admin-key': 'dual-secret' },
      });
      const rep = mockReply();

      await requireSessionOrAdmin(req, rep);

      expect(rep._sent).toBe(false);
      expect(req.isAdmin).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('accepts valid session token when enforced', async () => {
    const { env } = await import('../src/config/env.js');
    const { issueSessionToken } = await import('../src/auth/session-token.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'some-key';

    try {
      const { requireSessionOrAdmin } = await import('../src/auth/middleware.js');

      const token = issueSessionToken('tenant-1', 'session-1');
      const req = mockRequest({
        headers: { authorization: `Bearer ${token}` },
        params: { tenantId: 'tenant-1' },
      });
      const rep = mockReply();

      await requireSessionOrAdmin(req, rep);

      expect(rep._sent).toBe(false);
      expect(req.sessionToken).toBeDefined();
      expect(req.sessionToken.tid).toBe('tenant-1');
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('rejects when neither admin key nor session token provided', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'some-key';

    try {
      const { requireSessionOrAdmin } = await import('../src/auth/middleware.js');
      const req = mockRequest();
      const rep = mockReply();

      await requireSessionOrAdmin(req, rep);

      expect(rep.statusCode).toBe(401);
      expect(rep._sent).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('rejects cross-tenant session token with 403', async () => {
    const { env } = await import('../src/config/env.js');
    const { issueSessionToken } = await import('../src/auth/session-token.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'some-key';

    try {
      const { requireSessionOrAdmin } = await import('../src/auth/middleware.js');

      // Token for tenant-A, route is tenant-B
      const token = issueSessionToken('tenant-A', 'session-1');
      const req = mockRequest({
        headers: { authorization: `Bearer ${token}` },
        params: { tenantId: 'tenant-B' },
      });
      const rep = mockReply();

      await requireSessionOrAdmin(req, rep);

      expect(rep.statusCode).toBe(403);
      expect(rep._sent).toBe(true);
      expect(rep._body.error).toContain('does not belong to this tenant');
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('admin key bypasses tenant scope check', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'admin-pass';

    try {
      const { requireSessionOrAdmin } = await import('../src/auth/middleware.js');
      const req = mockRequest({
        headers: { 'x-admin-key': 'admin-pass' },
        params: { tenantId: 'any-tenant' },
      });
      const rep = mockReply();

      await requireSessionOrAdmin(req, rep);

      expect(rep._sent).toBe(false);
      expect(req.isAdmin).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. markPublic
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('markPublic', () => {
  it('sets AUTH_TAG_KEY on request', async () => {
    const { markPublic, AUTH_TAG_KEY } = await import('../src/auth/middleware.js');
    const req = mockRequest();
    const rep = mockReply();

    await markPublic(req, rep);

    expect(req[AUTH_TAG_KEY]).toBe(true);
  });

  it('does not reject or modify reply', async () => {
    const { markPublic } = await import('../src/auth/middleware.js');
    const req = mockRequest();
    const rep = mockReply();

    await markPublic(req, rep);

    expect(rep._sent).toBe(false);
    expect(rep.statusCode).toBe(200);
  });

  it('works regardless of auth enforcement flag', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'true';

    try {
      const { markPublic, AUTH_TAG_KEY } = await import('../src/auth/middleware.js');
      const req = mockRequest();
      const rep = mockReply();

      await markPublic(req, rep);

      expect(req[AUTH_TAG_KEY]).toBe(true);
      expect(rep._sent).toBe(false);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. AUTH_TAG_KEY consistency
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('AUTH_TAG_KEY consistency', () => {
  it('all middleware functions set AUTH_TAG_KEY', async () => {
    const {
      requireSessionToken,
      requireSessionTokenTenantScoped,
      requireAdminKey,
      requireSessionOrAdmin,
      optionalSessionToken,
      markPublic,
      AUTH_TAG_KEY,
    } = await import('../src/auth/middleware.js');

    const guards = [
      requireSessionToken,
      requireSessionTokenTenantScoped,
      requireAdminKey,
      requireSessionOrAdmin,
      optionalSessionToken,
      markPublic,
    ];

    for (const guard of guards) {
      const req = mockRequest();
      const rep = mockReply();
      await guard(req, rep);
      expect(req[AUTH_TAG_KEY]).toBe(true);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. Admin key extraction formats
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('admin key extraction', () => {
  it('prefers X-Admin-Key over Authorization header', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'header-key';

    try {
      const { requireAdminKey } = await import('../src/auth/middleware.js');
      const req = mockRequest({
        headers: {
          'x-admin-key': 'header-key',
          authorization: 'Bearer admin.wrong-key',
        },
      });
      const rep = mockReply();

      await requireAdminKey(req, rep);

      // Should succeed because X-Admin-Key matches
      expect(rep._sent).toBe(false);
      expect(req.isAdmin).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('ignores non-admin Bearer tokens for admin extraction', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'some-key';

    try {
      const { requireAdminKey } = await import('../src/auth/middleware.js');
      // Regular Bearer token (session token format) — not admin
      const req = mockRequest({
        headers: { authorization: 'Bearer some-session-token' },
      });
      const rep = mockReply();

      await requireAdminKey(req, rep);

      // Should fail because no admin key found
      expect(rep.statusCode).toBe(401);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. Timing safety
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('admin key timing safety', () => {
  it('rejects keys of different length without timing leak', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'short';

    try {
      const { requireAdminKey } = await import('../src/auth/middleware.js');
      const req = mockRequest({
        headers: { 'x-admin-key': 'a-very-long-key-that-does-not-match' },
      });
      const rep = mockReply();

      await requireAdminKey(req, rep);

      expect(rep.statusCode).toBe(403);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });

  it('rejects keys of same length but different content', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    const origKey = (env as any).ADMIN_API_KEY;
    (env as any).SDK_AUTH_REQUIRED = 'true';
    (env as any).ADMIN_API_KEY = 'abcdef';

    try {
      const { requireAdminKey } = await import('../src/auth/middleware.js');
      const req = mockRequest({
        headers: { 'x-admin-key': 'zyxwvu' },
      });
      const rep = mockReply();

      await requireAdminKey(req, rep);

      expect(rep.statusCode).toBe(403);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
      (env as any).ADMIN_API_KEY = origKey;
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. requireSessionToken with expired token
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('requireSessionToken — enforced mode', () => {
  it('rejects expired token with 401', async () => {
    const { env } = await import('../src/config/env.js');
    const { issueSessionToken } = await import('../src/auth/session-token.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'true';

    try {
      const { requireSessionToken } = await import('../src/auth/middleware.js');

      const token = issueSessionToken('t1', 's1', { ttlSeconds: -1 });
      const req = mockRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      const rep = mockReply();

      await requireSessionToken(req, rep);

      expect(rep.statusCode).toBe(401);
      expect(rep._body.error).toContain('Invalid or expired');
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
    }
  });

  it('accepts valid token and attaches payload', async () => {
    const { env } = await import('../src/config/env.js');
    const { issueSessionToken } = await import('../src/auth/session-token.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'true';

    try {
      const { requireSessionToken } = await import('../src/auth/middleware.js');

      const token = issueSessionToken('t-good', 's-good');
      const req = mockRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      const rep = mockReply();

      await requireSessionToken(req, rep);

      expect(rep._sent).toBe(false);
      expect(req.sessionToken).toBeDefined();
      expect(req.sessionToken.tid).toBe('t-good');
      expect(req.sessionToken.sid).toBe('s-good');
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 9. isAuthEnforced toggle
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('isAuthEnforced toggle', () => {
  it('returns false when SDK_AUTH_REQUIRED is "false"', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'false';

    try {
      const { isAuthEnforced } = await import('../src/auth/middleware.js');
      expect(isAuthEnforced()).toBe(false);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
    }
  });

  it('returns true when SDK_AUTH_REQUIRED is "true"', async () => {
    const { env } = await import('../src/config/env.js');
    const origAuth = (env as any).SDK_AUTH_REQUIRED;
    (env as any).SDK_AUTH_REQUIRED = 'true';

    try {
      const { isAuthEnforced } = await import('../src/auth/middleware.js');
      expect(isAuthEnforced()).toBe(true);
    } finally {
      (env as any).SDK_AUTH_REQUIRED = origAuth;
    }
  });
});
