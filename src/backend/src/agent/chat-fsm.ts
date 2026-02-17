// ============================================================
// Chat FSM — Server-side Finite State Machine
// ============================================================
// Manages conversation state per session. State is persisted in
// chat_sessions.metadata.fsm_state (no new DB columns needed).
//
// States:
//   ANON             — fresh session, no identity
//   SALES_CHAT       — engaged in general Q&A (browsing)
//   EMAIL_REQUESTED  — we asked for email (booking intent)
//   OTP_SENT         — OTP dispatched, waiting for code
//   EMAIL_VERIFIED   — email confirmed, ready to book
//   BOOKING_FLOW     — actively in the booking tool loop
//
// Transitions are driven by (intent, current_state) pairs.
// The FSM does NOT call the LLM — it only decides what the
// router should do next.
// ============================================================

import type { ChatIntent } from './intent-classifier.js';

export type FsmState =
  | 'ANON'
  | 'SALES_CHAT'
  | 'EMAIL_REQUESTED'
  | 'OTP_SENT'
  | 'EMAIL_VERIFIED'
  | 'BOOKING_FLOW';

export interface FsmContext {
  state: FsmState;
  /** Email provided by user (may not yet be verified). */
  pendingEmail: string | null;
  /** Email that has been OTP-verified for this session. */
  verifiedEmail: string | null;
  /** Number of OTP verify attempts this session. */
  otpAttempts: number;
  /** Timestamp when OTP was sent (ISO string). */
  otpSentAt: string | null;
}

/**
 * Action the router should take after a transition.
 */
export type FsmAction =
  | { type: 'TEMPLATE'; template: string; nextState: FsmState; data?: Record<string, unknown> }
  | { type: 'SEND_OTP'; email: string; nextState: FsmState }
  | { type: 'VERIFY_OTP'; code: string; nextState: FsmState }
  | { type: 'PASS_TO_LLM'; nextState: FsmState }
  | { type: 'REJECT_BOOKING'; reason: string; nextState: FsmState };

// ── Default Context ─────────────────────────────────────────

export function defaultFsmContext(): FsmContext {
  return {
    state: 'ANON',
    pendingEmail: null,
    verifiedEmail: null,
    otpAttempts: 0,
    otpSentAt: null,
  };
}

// ── State Persistence Helpers ───────────────────────────────

/**
 * Extract FSM context from session metadata.
 * Returns default context if none exists.
 */
export function getFsmContext(metadata: Record<string, unknown>): FsmContext {
  const raw = metadata?.fsm as Record<string, unknown> | undefined;
  if (!raw) return defaultFsmContext();

  return {
    state: (raw.state as FsmState) ?? 'ANON',
    pendingEmail: (raw.pendingEmail as string) ?? null,
    verifiedEmail: (raw.verifiedEmail as string) ?? null,
    otpAttempts: (raw.otpAttempts as number) ?? 0,
    otpSentAt: (raw.otpSentAt as string) ?? null,
  };
}

/**
 * Serialize FSM context back to session metadata (shallow merge).
 * Returns the updated metadata object.
 */
export function setFsmContext(
  metadata: Record<string, unknown>,
  ctx: FsmContext,
): Record<string, unknown> {
  return { ...metadata, fsm: { ...ctx } };
}

// ── Transition Function ─────────────────────────────────────

/**
 * Compute the next FSM action given a classified intent and current context.
 * This function is pure — it does NOT perform side effects.
 *
 * @param intent   Classified intent from intent-classifier
 * @param ctx      Current FSM context
 * @param extras   Optional extra data (extracted email, OTP code)
 */
export function transition(
  intent: ChatIntent,
  ctx: FsmContext,
  extras: { email?: string | null; otpCode?: string | null } = {},
): FsmAction {
  const { state } = ctx;

  // ── GREETING — always deterministic, stay in current state ──
  if (intent === 'GREETING') {
    // If already verified, greeting acknowledges that
    if (state === 'EMAIL_VERIFIED' || state === 'BOOKING_FLOW') {
      return { type: 'TEMPLATE', template: 'GREETING_VERIFIED', nextState: state };
    }
    return { type: 'TEMPLATE', template: 'GREETING', nextState: state === 'ANON' ? 'SALES_CHAT' : state };
  }

  // ── FAQ_BOOKING — deterministic answer ──
  if (intent === 'FAQ_BOOKING') {
    return { type: 'TEMPLATE', template: 'FAQ_BOOKING', nextState: state === 'ANON' ? 'SALES_CHAT' : state };
  }

  // ── GENERAL_SALES_Q — pass to existing storefront router / LLM ──
  if (intent === 'GENERAL_SALES_Q') {
    return { type: 'PASS_TO_LLM', nextState: state === 'ANON' ? 'SALES_CHAT' : state };
  }

  // ── BOOK_DEMO — depends on current state ──
  if (intent === 'BOOK_DEMO') {
    switch (state) {
      case 'ANON':
      case 'SALES_CHAT':
        // Not verified yet → ask for email
        if (ctx.verifiedEmail) {
          // Already verified (e.g., from a previous flow)
          return { type: 'PASS_TO_LLM', nextState: 'BOOKING_FLOW' };
        }
        return { type: 'TEMPLATE', template: 'ASK_EMAIL', nextState: 'EMAIL_REQUESTED' };

      case 'EMAIL_REQUESTED':
        // Still waiting for email — re-prompt
        return { type: 'TEMPLATE', template: 'ASK_EMAIL_AGAIN', nextState: 'EMAIL_REQUESTED' };

      case 'OTP_SENT':
        // Still waiting for OTP — remind them
        return {
          type: 'TEMPLATE',
          template: 'OTP_PENDING',
          nextState: 'OTP_SENT',
          data: { email: ctx.pendingEmail },
        };

      case 'EMAIL_VERIFIED':
      case 'BOOKING_FLOW':
        // Ready to book → pass to LLM (booking tools)
        return { type: 'PASS_TO_LLM', nextState: 'BOOKING_FLOW' };
    }
  }

  // ── PROVIDE_EMAIL — expected in EMAIL_REQUESTED state ──
  if (intent === 'PROVIDE_EMAIL') {
    const email = extras.email;
    if (!email) {
      return { type: 'TEMPLATE', template: 'INVALID_EMAIL', nextState: state as FsmState };
    }

    if (state === 'EMAIL_REQUESTED' || state === 'ANON' || state === 'SALES_CHAT') {
      return { type: 'SEND_OTP', email, nextState: 'OTP_SENT' };
    }

    // If already verified and they give a different email → force re-verify
    if ((state === 'EMAIL_VERIFIED' || state === 'BOOKING_FLOW') && email !== ctx.verifiedEmail) {
      return { type: 'SEND_OTP', email, nextState: 'OTP_SENT' };
    }

    // Same email as verified — acknowledge
    if ((state === 'EMAIL_VERIFIED' || state === 'BOOKING_FLOW') && email === ctx.verifiedEmail) {
      return { type: 'TEMPLATE', template: 'ALREADY_VERIFIED', nextState: state };
    }

    // In OTP_SENT — they might be correcting their email
    if (state === 'OTP_SENT' && email !== ctx.pendingEmail) {
      return { type: 'SEND_OTP', email, nextState: 'OTP_SENT' };
    }

    return { type: 'SEND_OTP', email, nextState: 'OTP_SENT' };
  }

  // ── PROVIDE_OTP — expected in OTP_SENT state ──
  if (intent === 'PROVIDE_OTP') {
    const code = extras.otpCode;
    if (!code) {
      return { type: 'TEMPLATE', template: 'INVALID_OTP', nextState: state as FsmState };
    }

    if (state === 'OTP_SENT') {
      if (ctx.otpAttempts >= 10) {
        return { type: 'TEMPLATE', template: 'OTP_MAX_ATTEMPTS', nextState: 'EMAIL_REQUESTED' };
      }
      return { type: 'VERIFY_OTP', code, nextState: 'EMAIL_VERIFIED' };
    }

    // OTP outside of OTP_SENT state — ignore gracefully
    return { type: 'TEMPLATE', template: 'OTP_NOT_EXPECTED', nextState: state as FsmState };
  }

  // ── CHANGE_EMAIL — force re-verification ──
  if (intent === 'CHANGE_EMAIL') {
    return {
      type: 'TEMPLATE',
      template: 'ASK_NEW_EMAIL',
      nextState: 'EMAIL_REQUESTED',
      data: { previousEmail: ctx.verifiedEmail ?? ctx.pendingEmail },
    };
  }

  // ── OTHER — pass to LLM ──
  return { type: 'PASS_TO_LLM', nextState: state === 'ANON' ? 'SALES_CHAT' : state };
}
