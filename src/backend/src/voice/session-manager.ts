/**
 * Voice Session Manager
 *
 * In-memory store of active voice sessions keyed by Twilio CallSid.
 * Each session tracks the conversation state machine, collected fields,
 * and references to backend resources (holds, appointments).
 */

import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.js';
import type { VoiceSession, VoiceCallState, VoiceIntent } from '../domain/types.js';

// ── Session Store ───────────────────────────────────────────────

const sessions = new Map<string, VoiceSession>();

export function createVoiceSession(callSid: string, tenantId: string, callerPhone?: string): VoiceSession {
  const session: VoiceSession = {
    callSid,
    tenantId,
    sessionId: `voice-${uuidv4()}`,
    state: 'greeting',
    intent: 'unknown',
    retries: 0,
    turnCount: 0,
    startedAt: Date.now(),
    lastPrompt: '',
    callerPhone: callerPhone ?? null,
    service: null,
    date: null,
    selectedSlot: null,
    holdId: null,
    clientName: null,
    clientEmail: null,
    clientNotes: null,
    bookingId: null,
    referenceCode: null,
    appointmentId: null,
    lookupResults: [],
    availableSlots: [],
  };
  sessions.set(callSid, session);
  return session;
}

export function getVoiceSession(callSid: string): VoiceSession | undefined {
  return sessions.get(callSid);
}

export function deleteVoiceSession(callSid: string): void {
  sessions.delete(callSid);
}

export function getAllVoiceSessions(): Map<string, VoiceSession> {
  return sessions;
}

// ── Session Mutation Helpers ────────────────────────────────────

export function advanceState(session: VoiceSession, newState: VoiceCallState): void {
  session.state = newState;
  session.retries = 0; // Reset retries on state advance
}

export function setIntent(session: VoiceSession, intent: VoiceIntent): void {
  session.intent = intent;
}

export function incrementRetry(session: VoiceSession): number {
  session.retries += 1;
  return session.retries;
}

export function incrementTurn(session: VoiceSession): number {
  session.turnCount += 1;
  return session.turnCount;
}

// ── Limit Checks ────────────────────────────────────────────────

export function isCallExpired(session: VoiceSession): boolean {
  return Date.now() - session.startedAt >= env.VOICE_MAX_CALL_DURATION_MS;
}

export function isTurnLimitReached(session: VoiceSession): boolean {
  return session.turnCount >= env.VOICE_MAX_TURNS;
}

export function isRetryLimitReached(session: VoiceSession): boolean {
  return session.retries >= env.VOICE_MAX_RETRIES;
}

// ── Cleanup (for graceful shutdown / tests) ─────────────────────

export function clearAllSessions(): void {
  sessions.clear();
}

/**
 * Count active sessions for a given tenant (for rate limiting).
 */
export function countActiveSessions(tenantId: string): number {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.tenantId === tenantId && s.state !== 'completed' && s.state !== 'error') {
      count++;
    }
  }
  return count;
}
