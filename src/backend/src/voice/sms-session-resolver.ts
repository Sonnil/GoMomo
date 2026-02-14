/**
 * SMS Session Resolver
 *
 * Maps an inbound SMS phone number to:
 *   1. A tenant (via sms_phone_number on tenant row, or default tenant)
 *   2. A persistent chat_session (created or resumed)
 *
 * This gives SMS conversations the same multi-turn persistence
 * as web chat sessions, using the same chat_sessions table.
 *
 * Session ID format: `sms:<phone>:<tenantId>` — deterministic,
 * so the same phone always maps to the same session per tenant.
 */

import { query } from '../db/client.js';
import { tenantRepo } from '../repos/tenant.repo.js';
import { sessionRepo } from '../repos/session.repo.js';
import { env } from '../config/env.js';
import type { Tenant, ChatSession, Customer, ReturningCustomerContext } from '../domain/types.js';
import { v5 as uuidv5 } from 'uuid';

// Deterministic namespace UUID for SMS session IDs
const SMS_SESSION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Generate a deterministic session ID from phone + tenant.
 * Uses UUID v5 so the same phone+tenant always produces the same session ID.
 */
export function buildSmsSessionId(phone: string, tenantId: string): string {
  return uuidv5(`sms:${phone}:${tenantId}`, SMS_SESSION_NAMESPACE);
}

export interface SmsSessionResolution {
  tenant: Tenant;
  session: ChatSession;
  sessionId: string;
  isNew: boolean;
  /** Customer identity resolved from the phone number. */
  customer: Customer | null;
  /** Returning customer context for system prompt injection (null if new customer). */
  returningContext: ReturningCustomerContext | null;
}

/**
 * Resolve an inbound SMS to a tenant + chat session.
 *
 * Tenant resolution order:
 *   1. Match `To` number against tenants.sms_phone_number
 *   2. Fall back to VOICE_DEFAULT_TENANT_ID (dev mode)
 *
 * Session resolution:
 *   1. Look up sms_phone_sessions for this phone+tenant
 *   2. If found → resume that chat_session
 *   3. If not found → create a new chat_session + mapping
 */
export async function resolveSmsSession(
  fromPhone: string,
  toPhone: string,
): Promise<SmsSessionResolution | null> {
  // ── Step 1: Resolve tenant ──────────────────────────────
  let tenant: Tenant | null = null;

  // Try matching the To number against tenant phone numbers
  if (toPhone) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM tenants
       WHERE sms_phone_number = $1 AND is_active = true
       LIMIT 1`,
      [toPhone],
    );
    if (rows[0]) {
      tenant = await tenantRepo.findById(rows[0].id);
    }
  }

  // Fallback: default tenant (dev mode)
  if (!tenant) {
    tenant = await tenantRepo.findById(env.VOICE_DEFAULT_TENANT_ID);
  }

  if (!tenant) return null;

  // ── Step 2: Resolve or create session ───────────────────
  const sessionId = buildSmsSessionId(fromPhone, tenant.id);
  let isNew = false;

  // Check for existing mapping
  const { rows: mappingRows } = await query<{ session_id: string }>(
    `SELECT session_id FROM sms_phone_sessions
     WHERE phone = $1 AND tenant_id = $2`,
    [fromPhone, tenant.id],
  );

  if (mappingRows[0]) {
    // Resume existing session
    const session = await sessionRepo.findOrCreate(mappingRows[0].session_id, tenant.id, 'sms');

    // Update the touched timestamp
    await query(
      `UPDATE sms_phone_sessions SET updated_at = NOW()
       WHERE phone = $1 AND tenant_id = $2`,
      [fromPhone, tenant.id],
    );

    // Resolve customer identity from phone
    const { customer, returningContext } = await resolveCustomerFromPhone(fromPhone, tenant.id, mappingRows[0].session_id);

    return { tenant, session, sessionId: mappingRows[0].session_id, isNew, customer, returningContext };
  }

  // Create new session + mapping
  isNew = true;
  const session = await sessionRepo.findOrCreate(sessionId, tenant.id, 'sms');

  // Store phone → session mapping
  await query(
    `INSERT INTO sms_phone_sessions (phone, tenant_id, session_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone, tenant_id) DO UPDATE SET
       session_id = EXCLUDED.session_id,
       updated_at = NOW()`,
    [fromPhone, tenant.id, sessionId],
  );

  // Store phone number in session metadata for follow-up workflows
  try {
    const meta = (session.metadata ?? {}) as Record<string, unknown>;
    await sessionRepo.updateMetadata(sessionId, {
      ...meta,
      channel: 'sms',
      client_phone: fromPhone,
    });
  } catch { /* best-effort */ }

  // Resolve customer identity from phone
  const { customer, returningContext } = await resolveCustomerFromPhone(fromPhone, tenant.id, sessionId);

  return { tenant, session, sessionId, isNew, customer, returningContext };
}

/**
 * Look up the session for a phone number + tenant (without creating).
 */
export async function findSmsSession(
  phone: string,
  tenantId: string,
): Promise<string | null> {
  const { rows } = await query<{ session_id: string }>(
    `SELECT session_id FROM sms_phone_sessions
     WHERE phone = $1 AND tenant_id = $2`,
    [phone, tenantId],
  );
  return rows[0]?.session_id ?? null;
}

// ── Customer Resolution Helper ────────────────────────────

/**
 * Resolve customer identity from a phone number and link to session.
 * Best-effort: returns nulls if customer service fails.
 */
async function resolveCustomerFromPhone(
  phone: string,
  tenantId: string,
  sessionId: string,
): Promise<{ customer: Customer | null; returningContext: ReturningCustomerContext | null }> {
  try {
    const { customerService } = await import('../services/customer.service.js');
    const { customer } = await customerService.resolveByPhone(phone, tenantId);

    // Link customer to session
    await sessionRepo.linkCustomer(sessionId, customer.id);

    // Build returning context (null if new customer with no bookings)
    const returningContext = await customerService.getReturningContext(customer.id);

    return { customer, returningContext };
  } catch {
    return { customer: null, returningContext: null };
  }
}
