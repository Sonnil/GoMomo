import type pg from 'pg';
import { query, getClient } from '../db/client.js';
import type { Tenant, GoogleOAuthTokens } from '../domain/types.js';
import { encrypt, decrypt, isEncrypted } from '../crypto/token-cipher.js';
import { env } from '../config/env.js';

// ── OAuth token encryption helpers ──────────────────────────
// Tokens are stored as AES-256-GCM encrypted JSON in the DB.
// In development mode with the placeholder key, we still encrypt
// for consistency, but the placeholder key offers no real security.

function encryptTokens(tokens: GoogleOAuthTokens): string {
  return encrypt(JSON.stringify(tokens), env.ENCRYPTION_KEY);
}

function decryptTokens(raw: string | null | object): GoogleOAuthTokens | null {
  if (raw == null) return null;

  // If it's already an object (Postgres JSONB auto-parsed), it's a legacy
  // unencrypted value — return as-is for migration compatibility
  if (typeof raw === 'object') return raw as GoogleOAuthTokens;

  // If it's a string but NOT encrypted, it's legacy plain JSON
  if (typeof raw === 'string' && !isEncrypted(raw)) {
    try {
      return JSON.parse(raw) as GoogleOAuthTokens;
    } catch {
      return null;
    }
  }

  // Encrypted value — decrypt
  try {
    return JSON.parse(decrypt(raw, env.ENCRYPTION_KEY)) as GoogleOAuthTokens;
  } catch {
    // If decryption fails (key changed, corrupt data), return null
    // rather than crashing the app — caller checks for null
    return null;
  }
}

/** Post-process a tenant row: decrypt OAuth tokens if present */
function hydrateTokens(tenant: Tenant | undefined): Tenant | undefined {
  if (!tenant) return undefined;
  // The pg driver may auto-parse JSONB → object, or return string for TEXT
  // Handle both cases transparently
  (tenant as any).google_oauth_tokens = decryptTokens(
    (tenant as any).google_oauth_tokens,
  );
  return tenant;
}

export const tenantRepo = {
  async findById(id: string): Promise<Tenant | null> {
    const { rows } = await query<Tenant>(
      'SELECT * FROM tenants WHERE id = $1',
      [id],
    );
    return hydrateTokens(rows[0]) ?? null;
  },

  async findBySlug(slug: string): Promise<Tenant | null> {
    const { rows } = await query<Tenant>(
      'SELECT * FROM tenants WHERE slug = $1',
      [slug],
    );
    return hydrateTokens(rows[0]) ?? null;
  },

  async create(data: {
    name: string;
    slug: string;
    timezone?: string;
    slot_duration?: number;
    business_hours?: object;
    services?: object[];
    service_description?: string;
  }): Promise<Tenant> {
    const { rows } = await query<Tenant>(
      `INSERT INTO tenants (name, slug, timezone, slot_duration, business_hours, services, service_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.name,
        data.slug,
        data.timezone ?? 'America/New_York',
        data.slot_duration ?? 30,
        JSON.stringify(data.business_hours ?? {}),
        JSON.stringify(data.services ?? []),
        data.service_description ?? '',
      ],
    );
    return hydrateTokens(rows[0])!;
  },

  async update(
    id: string,
    data: Partial<Pick<Tenant, 'name' | 'slug' | 'timezone' | 'slot_duration' | 'business_hours' | 'services' | 'service_description' | 'service_catalog_mode' | 'google_calendar_id' | 'is_active'>>,
  ): Promise<Tenant | null> {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        const dbValue = typeof value === 'object' ? JSON.stringify(value) : value;
        sets.push(`${key} = $${idx}`);
        values.push(dbValue);
        idx++;
      }
    }

    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const { rows } = await query<Tenant>(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return hydrateTokens(rows[0]) ?? null;
  },

  async updateOAuthTokens(
    id: string,
    tokens: GoogleOAuthTokens,
  ): Promise<void> {
    await query(
      'UPDATE tenants SET google_oauth_tokens = $1 WHERE id = $2',
      [encryptTokens(tokens), id],
    );
  },

  async listAll(): Promise<Tenant[]> {
    const { rows } = await query<Tenant>(
      'SELECT * FROM tenants WHERE is_active = true ORDER BY created_at DESC',
    );
    return rows.map((r) => hydrateTokens(r)!);
  },
};
