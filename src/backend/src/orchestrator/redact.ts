// ============================================================
// PII Redaction — Strips personally identifiable information
// from payloads before writing to audit logs.
//
// Strategy: replace known PII field values with '[REDACTED]'.
// Unknown fields are passed through (defense in depth: the
// audit_log table should NOT be exposed to untrusted consumers).
// ============================================================

/** Fields whose values are always redacted */
const PII_FIELDS = new Set([
  'client_email',
  'client_name',
  'client_notes',
  'client_phone',
  'customer_email',
  'customer_phone',
  'display_name',
  'email',
  'name',
  'phone',
  'caller_phone',
  'callerPhone',
  'recipient',
  'access_token',
  'refresh_token',
  'google_oauth_tokens',
]);

/** Patterns in field names that indicate PII (case-insensitive) */
const PII_PATTERNS = [
  /email/i,
  /phone/i,
  /token/i,
  /password/i,
  /secret/i,
  /ssn/i,
];

function isPIIField(key: string): boolean {
  if (PII_FIELDS.has(key)) return true;
  return PII_PATTERNS.some((p) => p.test(key));
}

/**
 * Deep-clone an object, replacing PII field values with '[REDACTED]'.
 * Handles nested objects and arrays. Primitives and Dates are passed through.
 */
export function redactPII(obj: Record<string, unknown>): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  return redactObject(obj) as Record<string, unknown>;
}

function redactValue(key: string, value: unknown): unknown {
  if (isPIIField(key)) {
    return '[REDACTED]';
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => redactValue(String(i), item));
  }
  if (typeof value === 'object') {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = redactValue(key, value);
  }
  return result;
}
