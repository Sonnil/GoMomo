/**
 * CEO Pilot Test — backend endpoint tests.
 *
 * Tests:
 *  1. rejects requests without X-CEO-TEST-TOKEN header (403)
 *  2. rejects requests with wrong token (403)
 *  3. returns 404 when no bookings exist
 *  4. returns latest booking with PII masked
 *  5. response contains NO raw phone or raw email
 *  6. emits ceo_test.last_booking_accessed audit event
 *  7. maskPhone returns "***XX" for valid phones
 *  8. maskPhone returns "(none)" for null
 *  9. maskEmail masks correctly
 * 10. last-sms: rejects without token (403)
 * 11. last-sms: returns 404 when no SMS data exists
 * 12. last-sms: returns outbox rows + audit events (new format)
 * 13. last-sms: response contains NO raw PII (phone/body)
 * 14. last-sms: emits ceo_test.last_sms_accessed audit event
 * 15. last-sms: respects limit parameter (both queries)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Import PII masking helpers directly (they're pure functions) ──
import { maskPhone, maskEmail } from '../src/routes/ceo-test.routes.js';

// ── Mocks ────────────────────────────────────────────────────────

// Mock env
vi.mock('../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'development',
    CEO_TEST_MODE: 'true',
    CEO_TEST_TOKEN: 'test-token-123',
  },
}));

// Mock DB query
const mockQuery = vi.fn();
vi.mock('../src/db/client.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

// Mock audit repo
const mockAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/repos/audit.repo.js', () => ({
  auditRepo: { log: (...args: any[]) => mockAuditLog(...args) },
}));

// We need Fastify to test route registration
import Fastify from 'fastify';
import { ceoTestRoutes } from '../src/routes/ceo-test.routes.js';

describe('CEO Test Endpoints', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(ceoTestRoutes);
    await app.ready();
  });

  // ── Token enforcement ──────────────────────────────────

  it('rejects requests without X-CEO-TEST-TOKEN header (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-booking',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('Forbidden');
  });

  it('rejects requests with wrong token (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-booking',
      headers: { 'x-ceo-test-token': 'wrong-token' },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── No bookings ────────────────────────────────────────

  it('returns 404 when no bookings exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // booking query
    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-booking?tenant_id=tenant-1',
      headers: { 'x-ceo-test-token': 'test-token-123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('No confirmed bookings');
  });

  // ── Successful response with PII masking ───────────────

  it('returns latest booking with PII masked', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'apt-1',
          reference_code: 'APT-ABC123',
          start_time: '2026-02-10T14:00:00Z',
          end_time: '2026-02-10T14:30:00Z',
          timezone: 'America/New_York',
          client_phone: '+15551234567',
          client_email: 'ceo@example.com',
          status: 'confirmed',
          created_at: '2026-02-09T12:00:00Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          reminder_type: 'sms_2h',
          status: 'pending',
          scheduled_at: '2026-02-10T12:00:00Z',
        }],
      });

    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-booking?tenant_id=tenant-1',
      headers: { 'x-ceo-test-token': 'test-token-123' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reference_code).toBe('APT-ABC123');
    expect(body.sms_enabled).toBe(true);
    expect(body.phone_masked).toBe('***67');
    expect(body.email_masked).toBe('c***@e***.com');
    expect(body.reminder_jobs).toHaveLength(1);
    expect(body.reminder_jobs[0].type).toBe('sms_2h');
    expect(body.reminder_jobs[0].status).toBe('pending');
  });

  it('response contains NO raw phone or raw email', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'apt-2',
          reference_code: 'APT-XYZ999',
          start_time: '2026-02-10T14:00:00Z',
          end_time: '2026-02-10T14:30:00Z',
          timezone: 'America/New_York',
          client_phone: '+15559876543',
          client_email: 'secret@company.io',
          status: 'confirmed',
          created_at: '2026-02-09T12:00:00Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-booking?tenant_id=tenant-1',
      headers: { 'x-ceo-test-token': 'test-token-123' },
    });

    const text = res.body;
    expect(text).not.toContain('+15559876543');
    expect(text).not.toContain('secret@company.io');
    expect(text).not.toContain('secret');
    // Masked versions should be present
    expect(text).toContain('***43');
    expect(text).toContain('s***@c***.io');
  });

  // ── Audit logging ──────────────────────────────────────

  it('emits ceo_test.last_booking_accessed audit event', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'apt-3',
          reference_code: 'APT-AUD',
          start_time: '2026-02-10T14:00:00Z',
          end_time: '2026-02-10T14:30:00Z',
          timezone: 'America/New_York',
          client_phone: '+15551111111',
          client_email: 'a@b.com',
          status: 'confirmed',
          created_at: '2026-02-09T12:00:00Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-booking?tenant_id=tenant-aud',
      headers: { 'x-ceo-test-token': 'test-token-123' },
    });

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-aud',
        event_type: 'ceo_test.last_booking_accessed',
        entity_type: 'debug',
        actor: 'ceo-test-panel',
      }),
    );
  });

  // ── /debug/ceo-test/last-sms ───────────────────────────
  // New format: { twilio_mode, outbox[], audit_events[] }
  // Two DB queries: sms_outbox, then audit_log

  it('last-sms: rejects without token (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-sms',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('Forbidden');
  });

  it('last-sms: returns 404 when no SMS data exists', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })   // outbox
      .mockResolvedValueOnce({ rows: [] });  // audit
    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-sms?tenant_id=tenant-1',
      headers: { 'x-ceo-test-token': 'test-token-123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('No SMS data');
  });

  it('last-sms: returns outbox rows and audit events', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-1',
          status: 'sent',
          message_type: 'booking_confirmation',
          booking_id: 'apt-sms-1',
          attempts: 1,
          max_attempts: 3,
          last_error: null,
          abort_reason: null,
          created_at: '2026-02-09T12:00:00Z',
          updated_at: '2026-02-09T12:00:05Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          event_type: 'sms.outbound_sent',
          entity_id: 'outbox-1',
          payload: {
            reference_code: 'APT-SMS1',
            message_sid_last4: 'ab12',
            simulated: true,
          },
          created_at: '2026-02-09T12:00:05Z',
        }],
      });

    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-sms?tenant_id=tenant-1',
      headers: { 'x-ceo-test-token': 'test-token-123' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Top-level shape
    expect(body).toHaveProperty('twilio_mode');
    expect(body.twilio_mode).toBe('simulator'); // env vars are empty in test
    // Outbox
    expect(body.outbox).toHaveLength(1);
    expect(body.outbox[0].id).toBe('outbox-1');
    expect(body.outbox[0].status).toBe('sent');
    expect(body.outbox[0].message_type).toBe('booking_confirmation');
    // Audit events
    expect(body.audit_events).toHaveLength(1);
    expect(body.audit_events[0].event_type).toBe('sms.outbound_sent');
    expect(body.audit_events[0].message_sid_last4).toBe('ab12');
    expect(body.audit_events[0].simulated).toBe(true);
  });

  it('last-sms: response contains NO raw PII (phone/body)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-pii',
          status: 'sent',
          message_type: 'booking_confirmation',
          booking_id: 'apt-pii',
          attempts: 1,
          max_attempts: 3,
          last_error: null,
          abort_reason: null,
          created_at: '2026-02-09T12:00:00Z',
          updated_at: '2026-02-09T12:00:05Z',
          // These would be in real rows but should NOT appear in response:
          phone: '+15559876543',
          body: 'Your appointment is confirmed',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          event_type: 'sms.outbound_sent',
          entity_id: 'outbox-pii',
          payload: {
            reference_code: 'APT-PII',
            phone: '+15559876543',  // Simulate accidental PII in payload
          },
          created_at: '2026-02-09T12:00:05Z',
        }],
      });

    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-sms?tenant_id=tenant-1',
      headers: { 'x-ceo-test-token': 'test-token-123' },
    });

    const text = res.body;
    // Phone and body must NOT appear in response
    expect(text).not.toContain('+15559876543');
    expect(text).not.toContain('Your appointment is confirmed');
    // Structured check: outbox items only include safe fields
    const body = res.json();
    expect(body.outbox[0]).not.toHaveProperty('phone');
    expect(body.outbox[0]).not.toHaveProperty('body');
    // Audit items only include safe fields
    expect(body.audit_events[0]).not.toHaveProperty('phone');
  });

  it('last-sms: emits ceo_test.last_sms_accessed audit event', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })   // outbox
      .mockResolvedValueOnce({ rows: [] });  // audit → 404 but audit still fires

    await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-sms?tenant_id=tenant-aud-sms',
      headers: { 'x-ceo-test-token': 'test-token-123' },
    });

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-aud-sms',
        event_type: 'ceo_test.last_sms_accessed',
        entity_type: 'debug',
        actor: 'ceo-test-panel',
      }),
    );
  });

  it('last-sms: respects limit parameter', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-lim',
          status: 'queued',
          message_type: 'booking_confirmation',
          booking_id: 'apt-lim',
          attempts: 0,
          max_attempts: 3,
          last_error: null,
          abort_reason: null,
          created_at: '2026-02-09T12:00:00Z',
          updated_at: '2026-02-09T12:00:00Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: '/debug/ceo-test/last-sms?tenant_id=tenant-1&limit=2',
      headers: { 'x-ceo-test-token': 'test-token-123' },
    });

    expect(res.statusCode).toBe(200);
    // Check that the sms_outbox SQL query received the limit parameter
    const outboxCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('sms_outbox'),
    );
    expect(outboxCall).toBeDefined();
    expect(outboxCall![1]).toEqual(['tenant-1', 2]);
    // Check that the audit SQL query also received the limit
    const auditCall = mockQuery.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('sms.%'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1]).toEqual(['tenant-1', 2]);
  });
});

// ── Pure function tests: PII masking ─────────────────────

describe('PII Masking', () => {
  it('maskPhone returns "***XX" for valid phones', () => {
    expect(maskPhone('+15551234567')).toBe('***67');
    expect(maskPhone('+442071234567')).toBe('***67');
  });

  it('maskPhone returns "(none)" for null', () => {
    expect(maskPhone(null)).toBe('(none)');
  });

  it('maskEmail masks correctly', () => {
    expect(maskEmail('ceo@example.com')).toBe('c***@e***.com');
    expect(maskEmail('john@company.co.uk')).toBe('j***@c***.uk');
  });
});
