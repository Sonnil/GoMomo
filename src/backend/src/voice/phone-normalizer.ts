// ============================================================
// Phone Normalizer — Coerces phone strings to E.164 format
//
// E.164: +{country_code}{subscriber}, e.g. +15551234567
//
// Handles:
//   +15551234567  → +15551234567 (already E.164)
//   15551234567   → +15551234567 (missing +)
//   (555) 123-4567 → +15551234567 (US local with formatting)
//   555-123-4567  → +15551234567 (US local, no area code prefix)
//
// Returns null if the input cannot be normalized.
// ============================================================

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/**
 * Normalize a phone string to E.164 format.
 * Returns the normalized string or null if unrecoverable.
 */
export function normalizePhone(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;

  // Strip everything except digits and leading +
  let digits = raw.replace(/[^\d+]/g, '');

  // If it already starts with + and passes E.164, return as-is
  if (digits.startsWith('+')) {
    if (E164_REGEX.test(digits)) return digits;
    // Strip the + and try to recover
    digits = digits.slice(1);
  }

  // Pure digits now — try to make it E.164
  if (digits.length === 11 && digits.startsWith('1')) {
    // US/CA: 15551234567 → +15551234567
    return `+${digits}`;
  }

  if (digits.length === 10) {
    // US/CA without country code: 5551234567 → +15551234567
    return `+1${digits}`;
  }

  if (digits.length >= 7 && digits.length <= 15) {
    // International: assume the digits are a full international number
    const candidate = `+${digits}`;
    if (E164_REGEX.test(candidate)) return candidate;
  }

  return null;
}

/**
 * Best-effort normalization: returns normalized or the original raw string
 * (for cases where we want to store *something* even if normalization fails).
 */
export function normalizePhoneOrPassthrough(raw: string): string {
  return normalizePhone(raw) ?? raw;
}
