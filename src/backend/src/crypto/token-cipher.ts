// ============================================================
// Token Cipher — AES-256-GCM encryption for secrets at rest
//
// Used to encrypt OAuth tokens (and any future sensitive data)
// before storing in the database. Each encryption produces a
// unique IV + auth tag, so the same plaintext encrypts to
// different ciphertext every time.
//
// Wire format: "enc:v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>"
//   - "enc:v1:" prefix for easy detection of encrypted values
//   - iv: 12 bytes (96-bit, standard for GCM)
//   - authTag: 16 bytes (128-bit, GCM default)
//   - ciphertext: variable length
//
// The key is derived from ENCRYPTION_KEY using HKDF-SHA256 with
// a domain-specific context string, so the raw ENCRYPTION_KEY
// isn't used directly (belt-and-suspenders).
// ============================================================

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // 96-bit IV (standard for GCM)
const TAG_LENGTH = 16;      // 128-bit auth tag
const PREFIX = 'enc:v1:';

/**
 * Derive a 256-bit encryption key from the raw ENCRYPTION_KEY
 * using HKDF-like derivation (HMAC-SHA256 with domain context).
 */
function deriveKey(rawKey: string): Buffer {
  return createHmac('sha256', rawKey)
    .update('ai-receptionist:oauth-token-encryption:v1')
    .digest(); // 32 bytes = 256 bits
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a prefixed string: "enc:v1:<iv>:<tag>:<ciphertext>"
 */
export function encrypt(plaintext: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an encrypted string produced by `encrypt()`.
 * Returns the original plaintext.
 * Throws if the value is tampered, the key is wrong, or the format is invalid.
 */
export function decrypt(encryptedValue: string, rawKey: string): string {
  if (!encryptedValue.startsWith(PREFIX)) {
    throw new Error('Not an encrypted value (missing enc:v1: prefix)');
  }

  const parts = encryptedValue.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const key = deriveKey(rawKey);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Check whether a string looks like an encrypted value (has the prefix).
 * Useful for migration: detect unencrypted legacy values.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}
