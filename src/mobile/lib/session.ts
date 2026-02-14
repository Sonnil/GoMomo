// ============================================================
// Session Service — SecureStore-backed session management
//
// Acquires a session token from POST /api/auth/session and
// persists token + session_id in Expo SecureStore so that
// sessions survive app restarts.
// ============================================================

import * as SecureStore from 'expo-secure-store';
import { BACKEND_BASE_URL, TENANT_ID } from './config';

const KEY_TOKEN = 'gomomo_session_token';
const KEY_SESSION_ID = 'gomomo_session_id';
const KEY_EXPIRES_AT = 'gomomo_session_expires';

export interface SessionData {
  token: string;
  session_id: string;
  tenant_id: string;
  expires_at: string;
  returning_customer: {
    display_name: string | null;
    booking_count: number;
  } | null;
}

/** Read stored session from SecureStore. Returns null if expired or missing. */
export async function getStoredSession(): Promise<SessionData | null> {
  try {
    const token = await SecureStore.getItemAsync(KEY_TOKEN);
    const sessionId = await SecureStore.getItemAsync(KEY_SESSION_ID);
    const expiresAt = await SecureStore.getItemAsync(KEY_EXPIRES_AT);

    if (!token || !sessionId || !expiresAt) return null;

    // Check expiry — refresh 5 minutes before actual expiry
    const expiryMs = new Date(expiresAt).getTime() - 5 * 60 * 1000;
    if (Date.now() >= expiryMs) return null;

    return {
      token,
      session_id: sessionId,
      tenant_id: TENANT_ID,
      expires_at: expiresAt,
      returning_customer: null, // not persisted — re-fetched on connect
    };
  } catch {
    return null;
  }
}

/** Persist session to SecureStore. */
async function storeSession(session: SessionData): Promise<void> {
  await SecureStore.setItemAsync(KEY_TOKEN, session.token);
  await SecureStore.setItemAsync(KEY_SESSION_ID, session.session_id);
  await SecureStore.setItemAsync(KEY_EXPIRES_AT, session.expires_at);
}

/** Clear stored session. */
export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_TOKEN);
  await SecureStore.deleteItemAsync(KEY_SESSION_ID);
  await SecureStore.deleteItemAsync(KEY_EXPIRES_AT);
}

/**
 * Acquire a session: returns cached if valid, otherwise creates a new one
 * via POST /api/auth/session.
 */
export async function acquireSession(): Promise<SessionData> {
  // Try cached first
  const cached = await getStoredSession();
  if (cached) return cached;

  // Request new session from backend
  const res = await fetch(`${BACKEND_BASE_URL}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: TENANT_ID }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Session creation failed: ${res.status}`);
  }

  const session: SessionData = await res.json();
  await storeSession(session);
  return session;
}
