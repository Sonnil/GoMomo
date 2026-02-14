# Secret Hardening & OAuth Token Encryption — Migration Guide

**Date:** 2025-07-22  
**Scope:** Secret enforcement, OAuth token encryption at rest  
**Affects:** All environments transitioning from dev to pilot/production  

---

## What Changed

### 1. Secret Enforcement (env.ts)

The Zod env schema now includes `superRefine` cross-field validation:

| Secret | Dev/Test Mode | Production Mode |
|--------|--------------|-----------------|
| `ENCRYPTION_KEY` | Defaults to `dev-only-placeholder-key-0000000000` | **Required**, ≥ 32 chars, known placeholders rejected |
| `SESSION_TOKEN_SECRET` | Empty (falls back to `ENCRYPTION_KEY`) | **Required**, ≥ 32 chars |
| `ADMIN_API_KEY` | Empty (only checked when `SDK_AUTH_REQUIRED=true`) | ≥ 16 chars when `SDK_AUTH_REQUIRED=true` |

**Impact:** The server will **refuse to start** in `NODE_ENV=production` without real secrets. Development and test modes are unchanged.

### 2. Fallback Removal

| File | Before | After |
|------|--------|-------|
| `session-token.ts` | `(env as any).SESSION_TOKEN_SECRET \|\| env.ENCRYPTION_KEY` | `env.SESSION_TOKEN_SECRET \|\| env.ENCRYPTION_KEY` with null check + throw |
| `handoff-token.ts` | `env.ENCRYPTION_KEY \|\| 'dev-handoff-signing-key'` | `env.ENCRYPTION_KEY` with null check + throw |

**Impact:** In dev mode, `ENCRYPTION_KEY` placeholder still works. In production, the validated secret is used directly.

### 3. OAuth Token Encryption at Rest

OAuth tokens (`access_token`, `refresh_token`, `expiry_date`) are now encrypted with AES-256-GCM before storing in PostgreSQL.

- **Wire format:** `enc:v1:<iv-hex>:<tag-hex>:<ciphertext-hex>`
- **Key derivation:** HMAC-SHA256 of `ENCRYPTION_KEY` with domain context
- **Column change:** `google_oauth_tokens` migrated from `JSONB` to `TEXT` (migration `010_oauth_encryption.sql`)

### 4. `ENCRYPTION_KEY` Naming Clarification

Despite the name, `ENCRYPTION_KEY` is used for:
1. **HMAC-SHA256 signing** — session tokens (fallback in dev), handoff tokens
2. **AES-256-GCM encryption** — OAuth tokens at rest (NEW)
3. **Key derivation** — The raw key is never used directly for AES; it's domain-separated via HMAC-SHA256

---

## Migration Steps

### For Existing Development Environments

**No action required.** Dev mode continues to work with placeholder keys.

### For New Pilot/Production Deployments

1. Copy `docs/pilot.env.template` to `.env`
2. Generate real secrets:
   ```bash
   # ENCRYPTION_KEY (32+ bytes)
   echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
   
   # SESSION_TOKEN_SECRET (32+ bytes, separate from ENCRYPTION_KEY)
   echo "SESSION_TOKEN_SECRET=$(openssl rand -base64 32)"
   
   # ADMIN_API_KEY (16+ bytes)
   echo "ADMIN_API_KEY=$(openssl rand -base64 24)"
   ```
3. Run migrations: the app auto-runs `010_oauth_encryption.sql` on startup

### For Existing Databases with Plain-Text OAuth Tokens

The `decryptTokens()` function in `tenant.repo.ts` handles legacy data automatically:

1. **JSONB objects** (pre-migration, auto-parsed by pg driver) → returned as-is
2. **Plain JSON strings** (post-migration, not encrypted) → parsed with `JSON.parse`
3. **Encrypted strings** (`enc:v1:...`) → decrypted with AES-256-GCM

**No manual data migration is needed.** Existing plain-text tokens will be read correctly. They will be re-encrypted the next time they are written (e.g., when Google refreshes the access token).

### If ENCRYPTION_KEY Changes

If you need to rotate `ENCRYPTION_KEY`:

1. Tokens encrypted with the old key will fail to decrypt
2. The `decryptTokens()` function returns `null` on failure (graceful degradation)
3. Affected tenants will need to re-authenticate via the OAuth flow
4. For a zero-downtime rotation, you'd need a key-rotation mechanism (not implemented yet — acceptable for pilot)

---

## Files Changed

| File | Change |
|------|--------|
| `src/backend/src/config/env.ts` | Added `KNOWN_WEAK_SECRETS` set + `superRefine` validation |
| `src/backend/src/auth/session-token.ts` | Removed `(env as any)` cast, added null-check throw |
| `src/backend/src/voice/handoff-token.ts` | Removed `'dev-handoff-signing-key'` fallback, added null-check throw |
| `src/backend/src/crypto/token-cipher.ts` | **NEW** — AES-256-GCM encrypt/decrypt/isEncrypted utilities |
| `src/backend/src/repos/tenant.repo.ts` | Added encrypt-on-write + decrypt-on-read for OAuth tokens |
| `src/backend/src/db/migrations/010_oauth_encryption.sql` | **NEW** — Alters `google_oauth_tokens` from JSONB to TEXT |
| `src/backend/tests/secret-hardening.test.ts` | **NEW** — 20+ tests for cipher + env validation |
| `docs/pilot.env.template` | **NEW** — Complete pilot environment template |
| `docs/SECRET-HARDENING-MIGRATION.md` | **NEW** — This file |
