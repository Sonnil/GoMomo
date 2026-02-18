// ============================================================
// Chat Router — Hybrid FSM + LLM Orchestrator
// ============================================================
// Intercepts every inbound chat message BEFORE the LLM loop.
//
//   1. Classify intent (zero-token, regex-based)
//   2. Compute FSM transition
//   3. If deterministic → return template immediately (no LLM)
//      If SEND_OTP   → call email-verification repo + return template
//      If VERIFY_OTP → call email-verification repo + return template
//      If PASS_TO_LLM → fall through to handleChatMessage
//
// The router replaces the direct call to handleChatMessage in
// index.ts (WebSocket) and chat.routes.ts (REST).
//
// Benefits:
//   • Greeting, FAQ, email/OTP flows: 0 tokens, <5ms
//   • LLM only called for sales Q&A and actual booking tool use
//   • Server-side verified email → booking gate enforced
// ============================================================

import { classifyIntent, extractEmail, extractOtp } from './intent-classifier.js';
import { transition, getFsmContext, setFsmContext, type FsmContext, type FsmAction } from './chat-fsm.js';
import { renderTemplate, type TemplateId } from './deterministic-templates.js';
import { handleChatMessage, type ChatHandlerOptions, type ChatResponseMeta } from './chat-handler.js';
import { resolveDatetime, type DatetimeResolverResult } from './datetime-resolver.js';
import { emailVerificationRepo, validateEmail } from '../repos/email-verification.repo.js';
import { sessionRepo } from '../repos/session.repo.js';
import { sendVerificationEmail } from '../email/transport.js';
import { env } from '../config/env.js';
import { customerService } from '../services/customer.service.js';
import type { Tenant, CustomerIdentity } from '../domain/types.js';

// ── Public API ──────────────────────────────────────────────

export interface ChatRouterResult {
  /** The final text response to send to the user. */
  response: string;
  /** Metadata about what the router did. */
  meta: ChatResponseMeta;
  /** Whether this was a deterministic (no-LLM) response. */
  deterministic: boolean;
  /** Updated FSM context (caller should persist to session metadata). */
  fsmContext: FsmContext;
}

export interface ChatRouterOptions extends ChatHandlerOptions {
  /** Session metadata (must include fsm state). */
  metadata?: Record<string, unknown>;
  /** Client IP for rate limiting. */
  clientIp?: string;
  /** Client timezone / locale metadata from the widget. */
  clientMeta?: {
    client_now_iso?: string;
    client_tz?: string;
    client_utc_offset_minutes?: number;
    locale?: string;
  };
}

/**
 * Route a chat message through the FSM → template / LLM pipeline.
 *
 * Call this instead of handleChatMessage directly.
 */
export async function routeChat(
  sessionId: string,
  tenantId: string,
  userMessage: string,
  tenant: Tenant,
  options: ChatRouterOptions = {},
): Promise<ChatRouterResult> {
  // 1. Load FSM context from session metadata
  const session = await sessionRepo.findOrCreate(sessionId, tenantId);
  const metadata = { ...(session.metadata ?? {}), ...(options.metadata ?? {}) };
  const fsmCtx = getFsmContext(metadata);

  // 2. Classify intent (context-aware)
  const { intent } = classifyIntent(userMessage, fsmCtx.state);

  // 3. Extract extras
  const email = extractEmail(userMessage);
  const otpCode = extractOtp(userMessage);

  // 4. Compute transition
  const action = transition(intent, fsmCtx, { email, otpCode });

  // 4b. Resolve date/time deterministically for booking intents
  //     Run resolver when the message will reach the LLM in a booking context.
  //     This ensures "today at 3pm" is resolved to an absolute ISO before
  //     the LLM sees it, eliminating timezone/date misinterpretation.
  //     EMAIL_VERIFIED is included because after OTP verification the user
  //     may supply a date/time (e.g. "4pm on friday") before the intent
  //     classifier tags it as BOOK_DEMO — the FSM keeps state=EMAIL_VERIFIED
  //     and nextState=EMAIL_VERIFIED, so without this gate the resolver
  //     would never run and the LLM would hallucinate the date.
  let resolvedDatetime: DatetimeResolverResult | null = null;
  if (
    action.type === 'PASS_TO_LLM' &&
    (intent === 'BOOK_DEMO' ||
      action.nextState === 'BOOKING_FLOW' ||
      fsmCtx.state === 'BOOKING_FLOW' ||
      fsmCtx.state === 'EMAIL_VERIFIED')
  ) {
    resolvedDatetime = resolveDatetime({
      userMessage,
      clientMeta: options.clientMeta,
      tenantTimezone: tenant.timezone,
      businessHours: tenant.business_hours,
    });
  }

  // 5. Execute action
  const result = await executeAction(action, fsmCtx, {
    sessionId,
    tenantId,
    userMessage,
    tenant,
    options,
    metadata,
    email,
    otpCode,
    resolvedDatetime,
  });

  return result;
}

// ── Action Executor ─────────────────────────────────────────

interface ActionContext {
  sessionId: string;
  tenantId: string;
  userMessage: string;
  tenant: Tenant;
  options: ChatRouterOptions;
  metadata: Record<string, unknown>;
  email: string | null;
  otpCode: string | null;
  /** Deterministic date/time resolved from the user message (booking intents only). */
  resolvedDatetime: DatetimeResolverResult | null;
}

async function executeAction(
  action: FsmAction,
  fsmCtx: FsmContext,
  ctx: ActionContext,
): Promise<ChatRouterResult> {
  const updatedCtx: FsmContext = { ...fsmCtx, state: action.nextState };

  switch (action.type) {
    // ── Deterministic template response ──
    case 'TEMPLATE': {
      const templateData: Record<string, unknown> = {
        email: fsmCtx.pendingEmail ?? fsmCtx.verifiedEmail,
        verifiedEmail: fsmCtx.verifiedEmail,
        ...(action.data ?? {}),
      };
      const response = renderTemplate(action.template as TemplateId, templateData);

      // Persist FSM state
      const newMeta = setFsmContext(ctx.metadata, updatedCtx);
      await sessionRepo.updateMetadata(ctx.sessionId, newMeta);

      // Save to conversation history (so context is preserved)
      await appendToConversation(ctx.sessionId, ctx.userMessage, response);

      return {
        response,
        meta: { tools_used: [], has_async_job: false },
        deterministic: true,
        fsmContext: updatedCtx,
      };
    }

    // ── Send OTP ──
    case 'SEND_OTP': {
      const email = action.email;

      // Validate email format
      const emailError = validateEmail(email);
      if (emailError) {
        const response = renderTemplate('INVALID_EMAIL');
        updatedCtx.state = 'EMAIL_REQUESTED'; // stay in email requested
        const newMeta = setFsmContext(ctx.metadata, updatedCtx);
        await sessionRepo.updateMetadata(ctx.sessionId, newMeta);
        await appendToConversation(ctx.sessionId, ctx.userMessage, response);
        return {
          response,
          meta: { tools_used: [], has_async_job: false },
          deterministic: true,
          fsmContext: updatedCtx,
        };
      }

      // Rate limit check
      const recentCount = await emailVerificationRepo.countRecent(email, ctx.tenantId);
      if (recentCount >= Number(env.EMAIL_VERIFICATION_RATE_LIMIT)) {
        const response = 'Too many verification requests for this email. Please wait a few minutes and try again.';
        const newMeta = setFsmContext(ctx.metadata, updatedCtx);
        await sessionRepo.updateMetadata(ctx.sessionId, newMeta);
        await appendToConversation(ctx.sessionId, ctx.userMessage, response);
        return {
          response,
          meta: { tools_used: [], has_async_job: false },
          deterministic: true,
          fsmContext: updatedCtx,
        };
      }

      // Create OTP and send email
      const result = await emailVerificationRepo.create(email, ctx.sessionId, ctx.tenantId);
      const emailResult = await sendVerificationEmail(
        email,
        result.code,
        Number(env.EMAIL_VERIFICATION_TTL_MINUTES),
      );

      if (!emailResult.success) {
        const response = 'I had trouble sending the verification email. Please try again in a moment.';
        updatedCtx.state = 'EMAIL_REQUESTED';
        const newMeta = setFsmContext(ctx.metadata, updatedCtx);
        await sessionRepo.updateMetadata(ctx.sessionId, newMeta);
        await appendToConversation(ctx.sessionId, ctx.userMessage, response);
        return {
          response,
          meta: { tools_used: [], has_async_job: false },
          deterministic: true,
          fsmContext: updatedCtx,
        };
      }

      // Update FSM context with pending email
      updatedCtx.pendingEmail = email;
      updatedCtx.otpAttempts = 0;
      updatedCtx.otpSentAt = new Date().toISOString();

      const response = renderTemplate('OTP_SENT', { email });
      const newMeta = setFsmContext(ctx.metadata, updatedCtx);
      await sessionRepo.updateMetadata(ctx.sessionId, newMeta);
      await appendToConversation(ctx.sessionId, ctx.userMessage, response);

      // In dev mode, log the code
      if (env.NODE_ENV !== 'production') {
        console.log(`[chat-router] OTP for ${email}: ${result.code} (dev mode)`);
      }

      return {
        response,
        meta: { tools_used: [], has_async_job: false },
        deterministic: true,
        fsmContext: updatedCtx,
      };
    }

    // ── Verify OTP ──
    case 'VERIFY_OTP': {
      const code = action.code;
      const email = fsmCtx.pendingEmail;

      if (!email) {
        const response = renderTemplate('OTP_NOT_EXPECTED');
        const newMeta = setFsmContext(ctx.metadata, updatedCtx);
        await sessionRepo.updateMetadata(ctx.sessionId, newMeta);
        await appendToConversation(ctx.sessionId, ctx.userMessage, response);
        return {
          response,
          meta: { tools_used: [], has_async_job: false },
          deterministic: true,
          fsmContext: updatedCtx,
        };
      }

      // Attempt verification
      const verified = await emailVerificationRepo.verify(email, code, ctx.sessionId);
      updatedCtx.otpAttempts = fsmCtx.otpAttempts + 1;

      if (!verified) {
        // Failed verification
        updatedCtx.state = 'OTP_SENT'; // stay in OTP_SENT
        const attemptsLeft = 10 - updatedCtx.otpAttempts;
        const response = renderTemplate('OTP_FAILED', { attemptsLeft });
        const newMeta = setFsmContext(ctx.metadata, updatedCtx);
        await sessionRepo.updateMetadata(ctx.sessionId, newMeta);
        await appendToConversation(ctx.sessionId, ctx.userMessage, response);
        return {
          response,
          meta: { tools_used: [], has_async_job: false },
          deterministic: true,
          fsmContext: updatedCtx,
        };
      }

      // ── Verified! ──
      updatedCtx.verifiedEmail = email;
      updatedCtx.pendingEmail = null;
      updatedCtx.state = 'EMAIL_VERIFIED';

      // Mark session as email-verified (existing system)
      await sessionRepo.markEmailVerified(ctx.sessionId);

      // Resolve or create customer + link to session
      try {
        const { customer } = await customerService.resolveByEmail(email, ctx.tenantId);
        await sessionRepo.linkCustomer(ctx.sessionId, customer.id);
      } catch {
        // best-effort
      }

      const response = renderTemplate('OTP_VERIFIED');
      const newMeta = setFsmContext(ctx.metadata, updatedCtx);
      await sessionRepo.updateMetadata(ctx.sessionId, newMeta);
      await appendToConversation(ctx.sessionId, ctx.userMessage, response);

      return {
        response,
        meta: { tools_used: [], has_async_job: false },
        deterministic: true,
        fsmContext: updatedCtx,
      };
    }

    // ── Pass to LLM ──
    case 'PASS_TO_LLM': {
      // Persist FSM state transition before calling LLM
      const newMeta = setFsmContext(ctx.metadata, updatedCtx);
      await sessionRepo.updateMetadata(ctx.sessionId, newMeta);

      // Build customer identity from FSM verified email
      let customerIdentity: CustomerIdentity | null = ctx.options.customerIdentity ?? null;
      if (!customerIdentity && updatedCtx.verifiedEmail) {
        customerIdentity = await sessionRepo.getCustomerIdentity(ctx.sessionId);
      }

      // Call the existing LLM chat handler
      const { response, meta } = await handleChatMessage(
        ctx.sessionId,
        ctx.tenantId,
        ctx.userMessage,
        ctx.tenant,
        {
          ...ctx.options,
          verifiedEmail: updatedCtx.verifiedEmail ?? ctx.options.verifiedEmail,
          customerIdentity,
          resolvedDatetime: ctx.resolvedDatetime ?? undefined,
        },
      );

      return {
        response,
        meta,
        deterministic: false,
        fsmContext: updatedCtx,
      };
    }

    // ── Reject booking ──
    case 'REJECT_BOOKING': {
      const response = renderTemplate('BOOKING_REQUIRES_EMAIL');
      const newMeta = setFsmContext(ctx.metadata, { ...updatedCtx, state: 'EMAIL_REQUESTED' });
      await sessionRepo.updateMetadata(ctx.sessionId, newMeta);
      await appendToConversation(ctx.sessionId, ctx.userMessage, response);
      return {
        response,
        meta: { tools_used: [], has_async_job: false },
        deterministic: true,
        fsmContext: { ...updatedCtx, state: 'EMAIL_REQUESTED' },
      };
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Append a user message + assistant response to the session conversation.
 * This ensures deterministic responses are part of the conversation history
 * so the LLM has full context when it eventually gets called.
 */
async function appendToConversation(
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  const session = await sessionRepo.findById(sessionId);
  if (!session) return;

  const conversation = Array.isArray(session.conversation) ? [...session.conversation] : [];
  const now = new Date().toISOString();

  conversation.push({
    role: 'user',
    content: userMessage,
    timestamp: now,
  });

  conversation.push({
    role: 'assistant',
    content: assistantResponse,
    timestamp: now,
  });

  await sessionRepo.updateConversation(sessionId, conversation);
}
