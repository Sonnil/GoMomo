// ============================================================
// Calendar Provider Factory
// ============================================================
// Selects the correct CalendarProvider based on CALENDAR_MODE:
//
//   CALENDAR_MODE=real  → GoogleCalendarProvider (requires OAuth)
//   CALENDAR_MODE=mock  → MockCalendarProvider   (local testing)
//
// The provider instance is created once at startup and reused.
// ============================================================

import { env } from '../../config/env.js';
import type { CalendarProvider } from './types.js';
import { GoogleCalendarProvider } from './google-calendar.js';
import { MockCalendarProvider } from './mock-calendar.js';

export type { CalendarProvider, CalendarEvent } from './types.js';

let _provider: CalendarProvider | null = null;

/**
 * Get the active calendar provider (singleton).
 *
 * Resolution:
 * 1. CALENDAR_MODE=real  → GoogleCalendarProvider
 * 2. CALENDAR_MODE=mock  → MockCalendarProvider
 */
export function getCalendarProvider(): CalendarProvider {
  if (_provider) return _provider;

  switch (env.CALENDAR_MODE) {
    case 'real':
      _provider = new GoogleCalendarProvider();
      console.log('📅 Calendar provider: Google (real mode)');
      break;

    case 'mock':
      _provider = new MockCalendarProvider();
      console.log('📅 Calendar provider: Mock (local testing — DB-only)');
      break;

    default:
      // Should never happen — Zod validates the enum
      _provider = new MockCalendarProvider();
      console.warn(`📅 Unknown CALENDAR_MODE "${env.CALENDAR_MODE}" — falling back to mock`);
  }

  return _provider;
}

/**
 * Reset the provider singleton (useful for tests).
 */
export function resetCalendarProvider(): void {
  _provider = null;
}
