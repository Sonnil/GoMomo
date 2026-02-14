// ============================================================
// Mobile Config — centralizes backend URL + tenant ID
//
// Values come from app.json → expo.extra. Override for device
// testing by editing app.json or using environment variables.
//
// For simulator: http://localhost:3000 works.
// For physical device on LAN: use your machine's IP, e.g.
//   "backendBaseUrl": "http://192.168.1.42:3000"
// ============================================================

import Constants from 'expo-constants';

const extra = Constants.expoConfig?.extra ?? {};

/** Base URL of the gomomo backend (no trailing slash). */
export const BACKEND_BASE_URL: string =
  extra.backendBaseUrl || 'http://localhost:3000';

/** Default tenant ID for dev / single-tenant mode. */
export const TENANT_ID: string =
  extra.tenantId || '00000000-0000-4000-a000-000000000001';

/** WebSocket path used by Socket.IO on the backend. */
export const WS_PATH = '/ws';
