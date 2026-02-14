/**
 * Seed script — creates the default Gomomo tenant and sample appointments.
 *
 * Creates:
 *   1. Gomomo (ID: 00000000-0000-4000-a000-000000000001) — default tenant
 *   2. Sample appointments for the next 7 days
 *   3. Default policy rules for the autonomous agent runtime
 *
 * Strategy: UPSERT (INSERT ON CONFLICT DO UPDATE) — safe to re-run
 * at any time; always converges to the canonical Gomomo identity.
 *
 * Run:  npx tsx src/db/seed.ts
 */
import { pool } from './client.js';

// ── Fixed tenant ID — deterministic UUID for dev convenience ───
// Matches VOICE_DEFAULT_TENANT_ID in .env.example
const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

async function seed(): Promise<void> {
  console.log('🌱 Seeding database…\n');

  // ── 1. Gomomo (default tenant — UPSERT) ───────────────────
  const defaultHours = {
    monday:    { start: '09:00', end: '18:00' },
    tuesday:   { start: '09:00', end: '18:00' },
    wednesday: { start: '09:00', end: '18:00' },
    thursday:  { start: '09:00', end: '20:00' },
    friday:    { start: '09:00', end: '17:00' },
    saturday:  { start: '10:00', end: '14:00' },
    sunday:    null,
  };

  const defaultServices = [
    { name: 'Demo Consultation', duration: 30, price: '$80',
      description: 'Standard appointment — demonstrates the booking flow' },
    { name: 'Follow-up Appointment', duration: 20, price: '$50',
      description: 'Progress check — demonstrates rescheduling' },
    { name: 'Extended Session', duration: 60, price: '$150',
      description: 'Longer appointment — demonstrates multi-slot booking' },
  ];

  const upsertResult = await pool.query(
    `INSERT INTO tenants (id, name, slug, timezone, slot_duration, business_hours, services, service_catalog_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       name                 = EXCLUDED.name,
       slug                 = EXCLUDED.slug,
       timezone             = EXCLUDED.timezone,
       slot_duration        = EXCLUDED.slot_duration,
       business_hours       = EXCLUDED.business_hours,
       services             = EXCLUDED.services,
       service_catalog_mode = EXCLUDED.service_catalog_mode
     RETURNING (xmax = 0) AS inserted`,
    [
      DEFAULT_TENANT_ID,
      'Gomomo',
      'gomomo',
      'America/New_York',
      30,
      JSON.stringify(defaultHours),
      JSON.stringify(defaultServices),
      'free_text',
    ],
  );

  const wasInserted = upsertResult.rows[0]?.inserted;
  if (wasInserted) {
    console.log('  ✅ Gomomo created (ID: 00000000-0000-4000-a000-000000000001)');
  } else {
    console.log('  🔄 Gomomo updated to match repo defaults (ID: 00000000-0000-4000-a000-000000000001)');
  }
  console.log('     Slug: gomomo | TZ: America/New_York');
  console.log('     Hours: Mon-Wed 9-6, Thu 9-8, Fri 9-5, Sat 10-2, Sun closed');
  console.log('     Services: Demo (30m), Follow-up (20m), Extended (60m)\n');

  // ── 2. Sample Appointments (Gomomo) ───────────────────────
  const apptExists = await pool.query(
    `SELECT 1 FROM appointments WHERE tenant_id = $1 LIMIT 1`,
    [DEFAULT_TENANT_ID],
  );

  if (apptExists.rows.length === 0) {
    console.log('  📅 Creating sample appointments for Gomomo…');

    const now = new Date();
    const sampleAppointments = [
      {
        refCode: 'APT-DEMO-001',
        clientName: 'Sarah Johnson',
        clientEmail: 'sarah.johnson@example.com',
        service: 'Demo Consultation',
        dayOffset: 1, hour: 10, durationMin: 30,
        notes: 'First visit — demo appointment',
      },
      {
        refCode: 'APT-DEMO-002',
        clientName: 'Michael Chen',
        clientEmail: 'michael.chen@example.com',
        service: 'Extended Session',
        dayOffset: 1, hour: 14, durationMin: 60,
        notes: 'Returning client — extended session demo',
      },
      {
        refCode: 'APT-DEMO-003',
        clientName: 'Emily Rodriguez',
        clientEmail: 'emily.r@example.com',
        service: 'Follow-up Appointment',
        dayOffset: 2, hour: 11, durationMin: 20,
        notes: 'Follow-up on previous appointment',
      },
      {
        refCode: 'APT-DEMO-004',
        clientName: 'David Kim',
        clientEmail: 'david.kim@example.com',
        service: 'Demo Consultation',
        dayOffset: 3, hour: 15, durationMin: 30,
        notes: 'New client — referral demo',
      },
      {
        refCode: 'APT-DEMO-005',
        clientName: 'Lisa Thompson',
        clientEmail: 'lisa.t@example.com',
        service: 'Follow-up Appointment',
        dayOffset: 5, hour: 9, durationMin: 20,
        notes: 'Follow-up appointment from last month',
      },
    ];

    for (const appt of sampleAppointments) {
      const startTime = new Date(now);
      startTime.setDate(startTime.getDate() + appt.dayOffset);
      startTime.setHours(appt.hour, 0, 0, 0);

      const endTime = new Date(startTime);
      endTime.setMinutes(endTime.getMinutes() + appt.durationMin);

      await pool.query(
        `INSERT INTO appointments
         (tenant_id, reference_code, client_name, client_email, client_notes,
          service, start_time, end_time, timezone, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          DEFAULT_TENANT_ID,
          appt.refCode,
          appt.clientName,
          appt.clientEmail,
          appt.notes,
          appt.service,
          startTime.toISOString(),
          endTime.toISOString(),
          'America/New_York',
          'confirmed',
        ],
      );
      console.log('     ✅ ' + appt.refCode + ': ' + appt.clientName + ' — ' + appt.service);
    }
    console.log('');
  } else {
    console.log('  ⏭️  Sample appointments already exist — skipping.\n');
  }

  // ── 3. Default Policy Rules (Autonomous Agent Runtime) ──────
  const policyExists = await pool.query(
    `SELECT 1 FROM policy_rules LIMIT 1`,
  );

  if (policyExists.rows.length === 0) {
    console.log('  🛡️  Creating default policy rules…');

    const defaultRules = [
      { action: 'send_confirmation', effect: 'allow', conditions: JSON.stringify({ channel: 'email' }), priority: 10 },
      { action: 'send_cancellation', effect: 'allow', conditions: JSON.stringify({ channel: 'email' }), priority: 10 },
      { action: 'send_reminder', effect: 'allow', conditions: JSON.stringify({ channel: 'email' }), priority: 10 },
      { action: 'retry_calendar_sync', effect: 'allow', conditions: JSON.stringify({ failure_type: 'calendar_write' }), priority: 10 },
      { action: 'auto_cancel_no_show', effect: 'deny', conditions: JSON.stringify({}), priority: 10 },
      { action: 'hold_followup', effect: 'allow', conditions: JSON.stringify({ channel: 'email' }), priority: 10 },
      { action: 'waitlist_notify', effect: 'allow', conditions: JSON.stringify({ channel: 'email' }), priority: 10 },
      { action: 'escalate_calendar_failure', effect: 'allow', conditions: JSON.stringify({ failure_type: 'calendar_write' }), priority: 10 },
      { action: 'send_contact_followup', effect: 'allow', conditions: JSON.stringify({ channel: 'email' }), priority: 10 },
      { action: 'send_contact_followup', effect: 'allow', conditions: JSON.stringify({ channel: 'sms' }), priority: 11 },
      { action: 'send_sms_confirmation', effect: 'allow', conditions: JSON.stringify({ channel: 'sms' }), priority: 10 },
      { action: 'send_contact_followup', effect: 'deny', conditions: JSON.stringify({ max_followup_count: 2 }), priority: 20 },
    ];

    for (const rule of defaultRules) {
      await pool.query(
        `INSERT INTO policy_rules (tenant_id, action, effect, conditions, priority)
         VALUES (NULL, $1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [rule.action, rule.effect, rule.conditions, rule.priority],
      );
      const icon = rule.effect === 'allow' ? '✅' : '🚫';
      console.log('     ' + icon + ' ' + rule.action + ' → ' + rule.effect.toUpperCase() + ' (global)');
    }
    console.log('');
  } else {
    console.log('  ⏭️  Policy rules already exist — skipping.\n');
  }

  await pool.end();

  console.log('──────────────────────────────────────────────');
  console.log('🌱 Seed complete!');
  console.log('');
  console.log('  Gomomo tenant ID: 00000000-0000-4000-a000-000000000001');
  console.log('  Use this ID as tenant_id in the chat widget or');
  console.log('  set VOICE_DEFAULT_TENANT_ID=00000000-0000-4000-a000-000000000001');
  console.log('──────────────────────────────────────────────');
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
