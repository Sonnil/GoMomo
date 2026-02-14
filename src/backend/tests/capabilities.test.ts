// ============================================================
// Capabilities Model — Unit Tests
//
// Validates:
//   1. deriveCapabilities() maps env flags correctly
//   2. Default (all-true) produces expected shape
//   3. Selective disabling (SMS off, Voice off, etc.)
//   4. Voice requires BOTH FEATURE_VOICE + VOICE_ENABLED
//   5. Frozen singleton is immutable
//   6. capabilitiesSnapshot() returns a safe copy
//   7. Snapshot matches the singleton
//   8. chat is always true regardless of config
//
// No database, no network, no PII.
// Run:  npx vitest run tests/capabilities.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveCapabilities } from '../src/config/capabilities.js';
import type { AppCapabilities } from '../src/config/capabilities.js';

// ── Helpers ──────────────────────────────────────────────────

/** Default config — everything enabled (matches env.ts defaults). */
function defaultConfig() {
  return {
    FEATURE_CALENDAR_BOOKING: 'true',
    FEATURE_SMS: 'true',
    FEATURE_VOICE: 'true',
    FEATURE_VOICE_WEB: 'false',
    VOICE_ENABLED: 'true',
    CALENDAR_MODE: 'real',
    EXCEL_ENABLED: 'false',
    AUTONOMY_ENABLED: 'false',
    REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: 'true',
  };
}

// ── 1. Default capabilities ──────────────────────────────────

describe('deriveCapabilities — defaults', () => {
  it('produces the expected shape with default config', () => {
    const caps = deriveCapabilities(defaultConfig());

    expect(caps).toEqual({
      chat: true,
      booking: true,
      calendar: true,
      sms: true,
      voice: true,
      voiceWeb: false,
      emailGate: true,
      excel: false,
      autonomy: false,
    } satisfies AppCapabilities);
  });

  it('chat is always true regardless of config values', () => {
    const caps = deriveCapabilities({
      ...defaultConfig(),
      FEATURE_SMS: 'false',
      FEATURE_VOICE: 'false',
      FEATURE_CALENDAR_BOOKING: 'false',
    });
    expect(caps.chat).toBe(true);
  });
});

// ── 2. Selective disabling ───────────────────────────────────

describe('deriveCapabilities — selective flags', () => {
  it('SMS disabled when FEATURE_SMS=false', () => {
    const caps = deriveCapabilities({ ...defaultConfig(), FEATURE_SMS: 'false' });
    expect(caps.sms).toBe(false);
    // Other caps unchanged
    expect(caps.booking).toBe(true);
    expect(caps.voice).toBe(true);
  });

  it('booking + calendar disabled when FEATURE_CALENDAR_BOOKING=false', () => {
    const caps = deriveCapabilities({ ...defaultConfig(), FEATURE_CALENDAR_BOOKING: 'false' });
    expect(caps.booking).toBe(false);
    expect(caps.calendar).toBe(false);
  });

  it('emailGate disabled when REQUIRE_EMAIL_AFTER_FIRST_MESSAGE=false', () => {
    const caps = deriveCapabilities({ ...defaultConfig(), REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: 'false' });
    expect(caps.emailGate).toBe(false);
  });

  it('excel enabled when EXCEL_ENABLED=true', () => {
    const caps = deriveCapabilities({ ...defaultConfig(), EXCEL_ENABLED: 'true' });
    expect(caps.excel).toBe(true);
  });

  it('autonomy enabled when AUTONOMY_ENABLED=true', () => {
    const caps = deriveCapabilities({ ...defaultConfig(), AUTONOMY_ENABLED: 'true' });
    expect(caps.autonomy).toBe(true);
  });

  it('voiceWeb enabled when FEATURE_VOICE_WEB=true', () => {
    const caps = deriveCapabilities({ ...defaultConfig(), FEATURE_VOICE_WEB: 'true' });
    expect(caps.voiceWeb).toBe(true);
  });

  it('voiceWeb disabled when FEATURE_VOICE_WEB=false (default)', () => {
    const caps = deriveCapabilities(defaultConfig());
    expect(caps.voiceWeb).toBe(false);
  });

  it('voiceWeb is independent of FEATURE_VOICE (Twilio)', () => {
    // voiceWeb ON even when Twilio voice OFF
    const caps = deriveCapabilities({
      ...defaultConfig(),
      FEATURE_VOICE: 'false',
      VOICE_ENABLED: 'false',
      FEATURE_VOICE_WEB: 'true',
    });
    expect(caps.voice).toBe(false);
    expect(caps.voiceWeb).toBe(true);
  });
});

// ── 3. Voice requires both flags ────────────────────────────

describe('deriveCapabilities — voice dual-flag', () => {
  it('voice ON when both FEATURE_VOICE=true and VOICE_ENABLED=true', () => {
    const caps = deriveCapabilities({
      ...defaultConfig(),
      FEATURE_VOICE: 'true',
      VOICE_ENABLED: 'true',
    });
    expect(caps.voice).toBe(true);
  });

  it('voice OFF when FEATURE_VOICE=false (even if VOICE_ENABLED=true)', () => {
    const caps = deriveCapabilities({
      ...defaultConfig(),
      FEATURE_VOICE: 'false',
      VOICE_ENABLED: 'true',
    });
    expect(caps.voice).toBe(false);
  });

  it('voice OFF when VOICE_ENABLED=false (even if FEATURE_VOICE=true)', () => {
    const caps = deriveCapabilities({
      ...defaultConfig(),
      FEATURE_VOICE: 'true',
      VOICE_ENABLED: 'false',
    });
    expect(caps.voice).toBe(false);
  });

  it('voice OFF when both flags are false', () => {
    const caps = deriveCapabilities({
      ...defaultConfig(),
      FEATURE_VOICE: 'false',
      VOICE_ENABLED: 'false',
    });
    expect(caps.voice).toBe(false);
  });
});

// ── 4. All-disabled (booking-only-mode equivalent) ──────────

describe('deriveCapabilities — full booking-only mode', () => {
  it('matches expected shape when SMS + Voice disabled', () => {
    const caps = deriveCapabilities({
      ...defaultConfig(),
      FEATURE_SMS: 'false',
      FEATURE_VOICE: 'false',
      VOICE_ENABLED: 'false',
    });

    expect(caps).toEqual({
      chat: true,
      booking: true,
      calendar: true,
      sms: false,
      voice: false,
      voiceWeb: false,
      emailGate: true,
      excel: false,
      autonomy: false,
    });
  });
});

// ── 5. Frozen singleton immutability ────────────────────────

describe('capabilities singleton', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is frozen and rejects mutation', async () => {
    const mod = await import('../src/config/capabilities.js');
    expect(Object.isFrozen(mod.capabilities)).toBe(true);

    // Attempting to mutate should throw in strict mode or be a no-op
    expect(() => {
      (mod.capabilities as any).sms = !mod.capabilities.sms;
    }).toThrow();
  });
});

// ── 6. capabilitiesSnapshot() ───────────────────────────────

describe('capabilitiesSnapshot', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns a plain (non-frozen) copy', async () => {
    const mod = await import('../src/config/capabilities.js');
    const snap = mod.capabilitiesSnapshot();

    // Same values
    expect(snap).toEqual({ ...mod.capabilities });

    // Not the same reference
    expect(snap).not.toBe(mod.capabilities);

    // Not frozen (safe for mutation / serialisation)
    expect(Object.isFrozen(snap)).toBe(false);
  });

  it('matches the singleton values exactly', async () => {
    const mod = await import('../src/config/capabilities.js');
    const snap = mod.capabilitiesSnapshot();

    for (const key of Object.keys(mod.capabilities) as (keyof AppCapabilities)[]) {
      expect(snap[key]).toBe(mod.capabilities[key]);
    }
  });
});
