// ============================================================
// Admin Onboarding Routes — SMB self-serve setup
//
// GET  /api/admin/tenants                     — list all tenants
// POST /api/admin/tenants                     — create tenant
// GET  /api/admin/tenants/:id                 — get single tenant
// POST /api/admin/tenants/:id/settings        — update tenant settings
// GET  /api/admin/tenants/:id/widget-snippet  — HTML embed snippet
// GET  /api/admin/tenants/:id/onboarding-status — checklist
//
// All routes require admin key (requireAdminKey middleware).
// ============================================================

import { FastifyInstance } from 'fastify';
import { tenantRepo } from '../repos/tenant.repo.js';
import { requireAdminKey } from '../auth/middleware.js';
import { env } from '../config/env.js';

export async function adminOnboardingRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /api/admin/tenants ────────────────────────────────
  // List all active tenants (admin dashboard).
  app.get('/api/admin/tenants', {
    preHandler: requireAdminKey,
  }, async () => {
    const tenants = await tenantRepo.listAll();
    return tenants.map(({ google_oauth_tokens: _t, ...safe }) => safe);
  });

  // ── POST /api/admin/tenants ───────────────────────────────
  // Create a new tenant with defaults ready for onboarding.
  app.post<{
    Body: {
      name: string;
      slug?: string;
      timezone?: string;
      business_hours?: Record<string, { start: string; end: string } | null>;
    };
  }>('/api/admin/tenants', {
    preHandler: requireAdminKey,
  }, async (req, reply) => {
    const { name, slug, timezone, business_hours } = req.body ?? {};

    if (!name) {
      return reply.code(400).send({ error: 'name is required.' });
    }

    const autoSlug = slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    // Check slug uniqueness
    const existing = await tenantRepo.findBySlug(autoSlug);
    if (existing) {
      return reply.code(409).send({ error: `Slug "${autoSlug}" is already in use.` });
    }

    const tenant = await tenantRepo.create({
      name,
      slug: autoSlug,
      timezone: timezone ?? 'America/New_York',
      business_hours: business_hours ?? {
        monday: { start: '09:00', end: '17:00' },
        tuesday: { start: '09:00', end: '17:00' },
        wednesday: { start: '09:00', end: '17:00' },
        thursday: { start: '09:00', end: '17:00' },
        friday: { start: '09:00', end: '17:00' },
        saturday: null,
        sunday: null,
      },
    });

    const { google_oauth_tokens: _t, ...safe } = tenant;
    return reply.code(201).send(safe);
  });

  // ── GET /api/admin/tenants/:id ────────────────────────────
  // Get a single tenant (for the detail page).
  app.get<{ Params: { id: string } }>('/api/admin/tenants/:id', {
    preHandler: requireAdminKey,
  }, async (req, reply) => {
    const tenant = await tenantRepo.findById(req.params.id);
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });
    const { google_oauth_tokens: _t, ...safe } = tenant;
    return safe;
  });

  // ── POST /api/admin/tenants/:id/settings ──────────────────
  // Partial update of tenant settings for the onboarding flow.
  app.post<{
    Params: { id: string };
    Body: {
      name?: string;
      slug?: string;
      timezone?: string;
      slot_duration?: number;
      business_hours?: Record<string, { start: string; end: string } | null>;
      services?: Array<{ name: string; duration: number; description?: string }>;
      service_description?: string;
    };
  }>('/api/admin/tenants/:id/settings', {
    preHandler: requireAdminKey,
  }, async (req, reply) => {
    const existing = await tenantRepo.findById(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'Tenant not found' });

    const {
      name,
      slug,
      timezone,
      slot_duration,
      business_hours,
      services,
      service_description,
    } = req.body ?? {};

    // Validate slug uniqueness if changing
    if (slug && slug !== existing.slug) {
      const slugTaken = await tenantRepo.findBySlug(slug);
      if (slugTaken && slugTaken.id !== existing.id) {
        return reply.code(409).send({ error: 'Slug is already in use by another tenant.' });
      }
    }

    // Validate timezone (basic check)
    if (timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch {
        return reply.code(400).send({ error: `Invalid timezone: ${timezone}` });
      }
    }

    // Validate slot_duration
    if (slot_duration !== undefined && (slot_duration < 5 || slot_duration > 480)) {
      return reply.code(400).send({
        error: 'slot_duration must be between 5 and 480 minutes.',
      });
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (slug !== undefined) updateData.slug = slug;
    if (timezone !== undefined) updateData.timezone = timezone;
    if (slot_duration !== undefined) updateData.slot_duration = slot_duration;
    if (business_hours !== undefined) updateData.business_hours = business_hours;
    if (services !== undefined) updateData.services = services;
    if (service_description !== undefined) updateData.service_description = service_description;

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({ error: 'No settings provided to update.' });
    }

    const updated = await tenantRepo.update(req.params.id, updateData as Parameters<typeof tenantRepo.update>[1]);
    if (!updated) return reply.code(500).send({ error: 'Failed to update tenant.' });

    // Strip OAuth tokens from response
    const { google_oauth_tokens: _tokens, ...safe } = updated;
    return safe;
  });

  // ── GET /api/admin/tenants/:id/widget-snippet ─────────────
  // Returns the embeddable HTML snippet + booking URL.
  app.get<{
    Params: { id: string };
  }>('/api/admin/tenants/:id/widget-snippet', {
    preHandler: requireAdminKey,
  }, async (req, reply) => {
    const tenant = await tenantRepo.findById(req.params.id);
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    // Determine the base URLs
    const frontendOrigin = env.CORS_ORIGIN || 'http://localhost:5173';
    const backendOrigin = `http://${env.HOST === '0.0.0.0' ? 'localhost' : env.HOST}:${env.PORT}`;

    // Direct booking URL (loads the chat widget standalone)
    const bookingUrl = `${frontendOrigin}/?tenant=${tenant.id}`;

    // Embeddable iframe snippet
    const iframeSnippet = `<!-- gomomo.ai Booking Widget -->
<iframe
  src="${frontendOrigin}/?tenant=${tenant.id}&embed=true"
  style="width: 100%; min-height: 600px; border: none; border-radius: 12px;"
  title="${tenant.name} — Book Online"
  allow="clipboard-write; microphone"
></iframe>`;

    // Script tag snippet (future — widget SDK)
    const scriptSnippet = `<!-- gomomo.ai Booking Widget (SDK) -->
<div id="gomomo-widget"></div>
<script
  src="${frontendOrigin}/widget.js"
  data-tenant-id="${tenant.id}"
  data-backend-url="${backendOrigin}"
  async
></script>`;

    return {
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      tenant_slug: tenant.slug,
      booking_url: bookingUrl,
      iframe_snippet: iframeSnippet,
      script_snippet: scriptSnippet,
    };
  });

  // ── GET /api/admin/tenants/:id/onboarding-status ──────────
  // Returns a checklist of setup steps and their completion state.
  app.get<{
    Params: { id: string };
  }>('/api/admin/tenants/:id/onboarding-status', {
    preHandler: requireAdminKey,
  }, async (req, reply) => {
    const tenant = await tenantRepo.findById(req.params.id);
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    const hasCalendar = !!(tenant.google_calendar_id || tenant.google_oauth_tokens);
    const hasBusinessHours = tenant.business_hours && Object.values(tenant.business_hours).some(v => v !== null);
    const hasServices = Array.isArray(tenant.services) && tenant.services.length > 0;
    const hasName = !!tenant.name && tenant.name.length > 0;
    const hasTimezone = !!tenant.timezone && tenant.timezone.length > 0;

    const steps = [
      {
        key: 'business_name',
        label: 'Set business name',
        completed: hasName,
        required: true,
      },
      {
        key: 'timezone',
        label: 'Set timezone',
        completed: hasTimezone,
        required: true,
      },
      {
        key: 'business_hours',
        label: 'Configure operating hours',
        completed: hasBusinessHours,
        required: true,
      },
      {
        key: 'default_duration',
        label: 'Set default appointment duration',
        completed: tenant.slot_duration > 0,
        required: true,
      },
      {
        key: 'calendar',
        label: 'Connect Google Calendar',
        completed: hasCalendar,
        required: false,
      },
      {
        key: 'services',
        label: 'Define services',
        completed: hasServices,
        required: false,
      },
    ];

    const requiredComplete = steps.filter(s => s.required).every(s => s.completed);
    const allComplete = steps.every(s => s.completed);

    return {
      tenant_id: tenant.id,
      ready_to_go_live: requiredComplete,
      fully_configured: allComplete,
      steps,
    };
  });
}
