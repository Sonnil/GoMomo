// ============================================================
// Application Capabilities Model
//
// Single source of truth for what features are active in this
// instance. Derived from existing environment feature flags
// (FEATURE_SMS, FEATURE_VOICE, FEATURE_CALENDAR_BOOKING, etc.)
// so it is NON-BREAKING — no new env vars needed.
//
// Usage:
//   import { capabilities } from './config/capabilities.js';
//   if (capabilities.sms) { … }
//
// The object is frozen — immutable after boot.
//
// See docs/CAPABILITIES.md for the full mapping and future plans.
// ============================================================

import { env } from './env.js';

// ── Capability Interface ────────────────────────────────────

export interface AppCapabilities {
  /** Web chat (always on — core product). */
  chat: boolean;
  /** Calendar-based availability + appointment booking. */
  booking: boolean;
  /** Google Calendar integration (real or mock). */
  calendar: boolean;
  /** Outbound + inbound SMS via Twilio. */
  sms: boolean;
  /** Inbound voice calls via Twilio. */
  voice: boolean;
  /** Browser push-to-talk STT + optional TTS. */
  voiceWeb: boolean;
  /** Email-gated lead capture after first message. */
  emailGate: boolean;
  /** Excel export / sync integration. */
  excel: boolean;
  /** Autonomous agent runtime (event bus + job runner). */
  autonomy: boolean;
}

// ── Derivation Logic ────────────────────────────────────────

/**
 * Build capabilities from the current env config.
 * This is a pure function — easy to test in isolation.
 */
export function deriveCapabilities(config: {
  FEATURE_CALENDAR_BOOKING: string;
  FEATURE_SMS: string;
  FEATURE_VOICE: string;
  FEATURE_VOICE_WEB: string;
  VOICE_ENABLED: string;
  CALENDAR_MODE: string;
  EXCEL_ENABLED: string;
  AUTONOMY_ENABLED: string;
  REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: string;
}): AppCapabilities {
  return {
    chat: true, // always on — core product
    booking: config.FEATURE_CALENDAR_BOOKING === 'true',
    calendar: config.FEATURE_CALENDAR_BOOKING === 'true',
    sms: config.FEATURE_SMS === 'true',
    voice: config.FEATURE_VOICE === 'true' && config.VOICE_ENABLED === 'true',
    voiceWeb: config.FEATURE_VOICE_WEB === 'true',
    emailGate: config.REQUIRE_EMAIL_AFTER_FIRST_MESSAGE === 'true',
    excel: config.EXCEL_ENABLED === 'true',
    autonomy: config.AUTONOMY_ENABLED === 'true',
  };
}

// ── Singleton (frozen) ──────────────────────────────────────

/**
 * The active capabilities for this process.
 * Frozen at import time — cannot be mutated.
 */
export const capabilities: Readonly<AppCapabilities> = Object.freeze(
  deriveCapabilities(env),
);

// ── Serialization (for API / health responses) ──────────────

/**
 * Returns a plain object safe for JSON responses.
 * Consumers (health endpoint, /api/capabilities, frontend hook)
 * all use this shape.
 */
export function capabilitiesSnapshot(): AppCapabilities {
  return { ...capabilities };
}
