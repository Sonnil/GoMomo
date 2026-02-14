// ============================================================
// Admin Onboarding Routes — Tests
//
// Verifies:
//  1. POST /api/admin/tenants/:id/settings — updates name, slug, timezone, etc.
//  2. POST /api/admin/tenants/:id/settings — validates timezone
//  3. POST /api/admin/tenants/:id/settings — validates slot_duration range
//  4. POST /api/admin/tenants/:id/settings — validates slug uniqueness
//  5. POST /api/admin/tenants/:id/settings — rejects empty body
//  6. POST /api/admin/tenants/:id/settings — 404 for unknown tenant
//  7. GET /api/admin/tenants/:id/widget-snippet — returns embed code + URL
//  8. GET /api/admin/tenants/:id/widget-snippet — 404 for unknown tenant
//  9. GET /api/admin/tenants/:id/onboarding-status — returns checklist
// 10. GET /api/admin/tenants/:id/onboarding-status — marks calendar connected
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────

const mockTenant = {
  id: 'tenant-001',
  name: 'Test Business',
  slug: 'test-business',
  timezone: 'America/New_York',
  slot_duration: 30,
  business_hours: {
    monday: { start: '09:00', end: '17:00' },
    tuesday: { start: '09:00', end: '17:00' },
    wednesday: null,
    thursday: null,
    friday: null,
    saturday: null,
    sunday: null,
  },
  services: [{ name: 'Consultation', duration: 30 }],
  service_description: '',
  google_calendar_id: null,
  google_oauth_tokens: null,
  excel_integration: null,
  quiet_hours_start: '21:00',
  quiet_hours_end: '08:00',
  sms_outbound_enabled: true,
  sms_retry_enabled: true,
  sms_quiet_hours_enabled: true,
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

const mockFindById = vi.fn();
const mockFindBySlug = vi.fn();
const mockUpdate = vi.fn();
const mockCreate = vi.fn();
const mockListAll = vi.fn();

vi.doMock('../src/repos/tenant.repo.js', () => ({
  tenantRepo: {
    findById: mockFindById,
    findBySlug: mockFindBySlug,
    update: mockUpdate,
    create: mockCreate,
    listAll: mockListAll,
    updateOAuthTokens: vi.fn(),
  },
}));

vi.doMock('../src/auth/middleware.js', () => ({
  requireAdminKey: async () => {},
  markPublic: async () => {},
  AUTH_TAG_KEY: '__authTagged',
}));

vi.doMock('../src/config/env.js', () => ({
  env: {
    CORS_ORIGIN: 'http://localhost:5173',
    HOST: '0.0.0.0',
    PORT: 3000,
  },
}));

// ── Helpers ──────────────────────────────────────────────

async function buildApp() {
  const Fastify = (await import('fastify')).default;
  const { adminOnboardingRoutes } = await import('../src/routes/admin-onboarding.routes.js');
  const app = Fastify();
  await app.register(adminOnboardingRoutes);
  return app;
}

// ── Tests ────────────────────────────────────────────────

describe('POST /api/admin/tenants/:id/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({ ...mockTenant });
    mockUpdate.mockImplementation((_id: string, data: Record<string, unknown>) =>
      Promise.resolve({ ...mockTenant, ...data }),
    );
  });

  it('updates tenant settings successfully', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants/tenant-001/settings',
      payload: {
        name: 'Updated Business',
        timezone: 'America/Chicago',
        slot_duration: 45,
        service_description: 'We offer haircuts and styling.',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Updated Business');
    expect(mockUpdate).toHaveBeenCalledWith('tenant-001', expect.objectContaining({
      name: 'Updated Business',
      timezone: 'America/Chicago',
      slot_duration: 45,
      service_description: 'We offer haircuts and styling.',
    }));
  });

  it('rejects invalid timezone', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants/tenant-001/settings',
      payload: { timezone: 'Not/A/Timezone' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Invalid timezone');
  });

  it('rejects slot_duration out of range', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants/tenant-001/settings',
      payload: { slot_duration: 2 },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('slot_duration');
  });

  it('rejects slot_duration above 480', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants/tenant-001/settings',
      payload: { slot_duration: 500 },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate slug', async () => {
    mockFindBySlug.mockResolvedValue({ ...mockTenant, id: 'other-tenant', slug: 'taken-slug' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants/tenant-001/settings',
      payload: { slug: 'taken-slug' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain('Slug is already in use');
  });

  it('allows same slug for same tenant', async () => {
    mockFindBySlug.mockResolvedValue({ ...mockTenant, id: 'tenant-001' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants/tenant-001/settings',
      payload: { slug: 'new-slug' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects empty body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants/tenant-001/settings',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('No settings provided');
  });

  it('returns 404 for unknown tenant', async () => {
    mockFindById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants/nonexistent/settings',
      payload: { name: 'New Name' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('strips OAuth tokens from response', async () => {
    mockUpdate.mockResolvedValue({
      ...mockTenant,
      name: 'Updated',
      google_oauth_tokens: { access_token: 'secret', refresh_token: 'secret', expiry_date: 0 },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants/tenant-001/settings',
      payload: { name: 'Updated' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.google_oauth_tokens).toBeUndefined();
  });
});

describe('GET /api/admin/tenants/:id/widget-snippet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({ ...mockTenant });
  });

  it('returns embed snippet and booking URL', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/tenants/tenant-001/widget-snippet',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tenant_id).toBe('tenant-001');
    expect(body.booking_url).toContain('tenant=tenant-001');
    expect(body.iframe_snippet).toContain('<iframe');
    expect(body.iframe_snippet).toContain('tenant-001');
    expect(body.iframe_snippet).toContain('embed=true');
    expect(body.script_snippet).toContain('<script');
    expect(body.script_snippet).toContain('data-tenant-id');
  });

  it('returns 404 for unknown tenant', async () => {
    mockFindById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/tenants/nonexistent/widget-snippet',
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/admin/tenants/:id/onboarding-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns checklist with correct completion states', async () => {
    mockFindById.mockResolvedValue({ ...mockTenant });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/tenants/tenant-001/onboarding-status',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tenant_id).toBe('tenant-001');
    expect(body.steps).toBeInstanceOf(Array);
    expect(body.steps.length).toBeGreaterThanOrEqual(5);

    // business_name should be complete
    const nameStep = body.steps.find((s: any) => s.key === 'business_name');
    expect(nameStep?.completed).toBe(true);

    // calendar should NOT be complete (no tokens)
    const calStep = body.steps.find((s: any) => s.key === 'calendar');
    expect(calStep?.completed).toBe(false);

    // ready_to_go_live should be true (required steps are complete)
    expect(body.ready_to_go_live).toBe(true);
    // fully_configured false (calendar not connected)
    expect(body.fully_configured).toBe(false);
  });

  it('marks calendar connected when tokens present', async () => {
    mockFindById.mockResolvedValue({
      ...mockTenant,
      google_oauth_tokens: { access_token: 'a', refresh_token: 'r', expiry_date: 0 },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/tenants/tenant-001/onboarding-status',
    });

    const body = JSON.parse(res.body);
    const calStep = body.steps.find((s: any) => s.key === 'calendar');
    expect(calStep?.completed).toBe(true);
  });

  it('returns 404 for unknown tenant', async () => {
    mockFindById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/tenants/nonexistent/onboarding-status',
    });

    expect(res.statusCode).toBe(404);
  });
});

// ── GET /api/admin/tenants (list) ────────────────────────

describe('GET /api/admin/tenants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns list of tenants without OAuth tokens', async () => {
    mockListAll.mockResolvedValue([
      { ...mockTenant, google_oauth_tokens: { access_token: 'secret' } },
      { ...mockTenant, id: 'tenant-002', name: 'Other Biz', google_oauth_tokens: null },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/tenants',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body[0].google_oauth_tokens).toBeUndefined();
    expect(body[1].google_oauth_tokens).toBeUndefined();
    expect(body[0].name).toBe('Test Business');
  });

  it('returns empty array when no tenants', async () => {
    mockListAll.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/tenants',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});

// ── POST /api/admin/tenants (create) ─────────────────────

describe('POST /api/admin/tenants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindBySlug.mockResolvedValue(null); // slug available
    mockCreate.mockImplementation((data: Record<string, unknown>) =>
      Promise.resolve({ ...mockTenant, ...data, id: 'new-tenant-id', google_oauth_tokens: null }),
    );
  });

  it('creates a tenant with auto-slug', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      payload: { name: "Bella's Hair Studio" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("Bella's Hair Studio");
    expect(body.google_oauth_tokens).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: "Bella's Hair Studio",
      slug: 'bella-s-hair-studio',
    }));
  });

  it('creates a tenant with explicit slug', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      payload: { name: 'My Shop', slug: 'my-shop' },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'my-shop',
    }));
  });

  it('rejects duplicate slug', async () => {
    mockFindBySlug.mockResolvedValue({ ...mockTenant, id: 'other' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      payload: { name: 'Test Business' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain('already in use');
  });

  it('rejects missing name', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('name is required');
  });
});

// ── GET /api/admin/tenants/:id ───────────────────────────

describe('GET /api/admin/tenants/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns tenant without OAuth tokens', async () => {
    mockFindById.mockResolvedValue({
      ...mockTenant,
      google_oauth_tokens: { access_token: 'secret' },
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/tenants/tenant-001',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Test Business');
    expect(body.google_oauth_tokens).toBeUndefined();
  });

  it('returns 404 for unknown tenant', async () => {
    mockFindById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/tenants/nonexistent',
    });

    expect(res.statusCode).toBe(404);
  });
});
