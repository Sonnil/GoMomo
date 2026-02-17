import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { env } from '../config/env.js';
import { buildSystemPrompt, buildIdentityContextSection, IDENTITY_CONTEXT_MARKER, GOMOMO_PLATFORM_SLUG } from './system-prompt.js';
import { agentTools, debugAvailabilityTool, type ToolName } from './tools.js';
import { executeToolCall } from './tool-executor.js';
import { postProcessResponse } from './response-post-processor.js';
import type { Tenant, ConversationMessage, ReturningCustomerContext, CustomerIdentity } from '../domain/types.js';
import type { DatetimeResolverResult } from './datetime-resolver.js';
import { sessionRepo } from '../repos/session.repo.js';
import { normalizePhone } from '../voice/phone-normalizer.js';
import { routeStorefrontQuestion, buildStorefrontContextPrompt } from '../storefront/router.js';
import { GOMOMO_FACTS } from '../storefront/gomomo-facts.js';

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.OPENAI_BASE_URL,
});

/** Structured booking data surfaced to clients when confirm_booking succeeds. */
export interface BookingData {
  appointment_id: string;
  reference_code: string;
  client_name: string;
  service: string | null;
  start_time: string;
  end_time: string;
  display_time: string;
  timezone: string;
  add_to_calendar_url: string;
}

/** Metadata about what the AI did while processing a message. */
export interface ChatResponseMeta {
  /** Tool names invoked during this turn (e.g. 'check_availability', 'confirm_booking'). */
  tools_used: string[];
  /** True when the response triggered an async background job (waitlist, retry, reminder). */
  has_async_job: boolean;
  /** Present when confirm_booking succeeded — structured data for rich UI rendering. */
  booking_data?: BookingData;
}

// Tools that trigger async follow-up workflows
const ASYNC_JOB_TOOLS = new Set(['confirm_booking', 'create_inquiry', 'schedule_contact_followup']);

export interface ChatHandlerOptions {
  /** If set, returning-customer context is injected into the system prompt. */
  customerContext?: ReturningCustomerContext | null;
  /** Customer ID to link to the session after booking. */
  customerId?: string | null;
  /** Channel: 'web' (default), 'sms', or 'voice'. Affects system prompt tone. */
  channel?: 'web' | 'sms' | 'voice';
  /** Email address already verified via the email gate. Prevents re-asking. @deprecated Use customerIdentity. */
  verifiedEmail?: string | null;
  /** Full customer identity from a verified session (email, phone, name). */
  customerIdentity?: CustomerIdentity | null;
  /** Client timezone / locale metadata from the widget. */
  clientMeta?: {
    client_now_iso?: string;
    client_tz?: string;
    client_utc_offset_minutes?: number;
    locale?: string;
  };
  /** Streaming: called for each text token as it arrives from OpenAI. */
  onToken?: (token: string) => void;
  /** Streaming: called when the agent starts executing a tool. */
  onStatus?: (phase: string, detail: string) => void;
  /** Deterministic date/time resolved from the user message (booking intents only). */
  resolvedDatetime?: DatetimeResolverResult | null;
}

export async function handleChatMessage(
  sessionId: string,
  tenantId: string,
  userMessage: string,
  tenant: Tenant,
  options: ChatHandlerOptions = {},
): Promise<{ response: string; meta: ChatResponseMeta }> {
  // 1. Load or create session
  const session = await sessionRepo.findOrCreate(sessionId, tenantId);
  const conversation: ConversationMessage[] = Array.isArray(session.conversation)
    ? session.conversation
    : [];

  // 2. Add system prompt if first message
  if (conversation.length === 0) {
    conversation.push({
      role: 'system',
      content: buildSystemPrompt(tenant, {
        returningCustomer: options.customerContext,
        channel: options.channel,
        verifiedEmail: options.verifiedEmail,
        customerIdentity: options.customerIdentity,
        clientMeta: options.clientMeta,
      }),
      timestamp: new Date().toISOString(),
    });
  } else if (options.customerIdentity || options.verifiedEmail) {
    // Mid-conversation identity injection: inject a system message so the
    // agent learns what identity fields are already known (the original
    // system prompt was built before verification happened).
    const alreadyInjected = conversation.some(
      (m) => m.role === 'system' && (m.content.includes(IDENTITY_CONTEXT_MARKER) || m.content.includes('VERIFIED EMAIL (EMAIL GATE)')),
    );
    if (!alreadyInjected) {
      const section = buildIdentityContextSection(options.customerIdentity, options.verifiedEmail).trim();
      if (section) {
        conversation.push({
          role: 'system',
          content: section,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // 3. Add user message
  conversation.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
  });

  // 3a. Inject deterministic datetime context for booking intents
  //     When the datetime-resolver produced a result, inject it as a
  //     system message so the LLM has the absolute ISO timestamp and
  //     does NOT need to guess what "today at 3pm" means.
  if (options.resolvedDatetime) {
    const rd = options.resolvedDatetime;
    const parts = [
      `RESOLVED_DATETIME_ISO=${rd.start_iso}`,
      rd.end_iso ? `RESOLVED_DATETIME_END_ISO=${rd.end_iso}` : null,
      `CONFIDENCE=${rd.confidence}`,
      `RESOLUTION_DETAILS: ${rd.reasons.join(', ')}`,
    ].filter(Boolean).join(' | ');

    conversation.push({
      role: 'system',
      content:
        `[DATETIME RESOLUTION] The user's date/time expression has been ` +
        `deterministically resolved. Use the following absolute timestamp ` +
        `when calling check_availability or confirm_booking tools. ` +
        `Do NOT reinterpret the user's relative time expression.\n${parts}`,
      timestamp: new Date().toISOString(),
    });
  }

  // 3b. Storefront Knowledge Router (Gomomo platform tenant only)
  //     Routes storefront questions through: facts → approved FAQs → RAG → fallback
  //     Booking intents bypass this and go straight to the LLM tool loop.
  if (tenant.slug === GOMOMO_PLATFORM_SLUG) {
    // Identity reinforcement — remind the LLM who it is on every turn
    conversation.push({
      role: 'system',
      content:
        `IDENTITY REMINDER: You are Gomomo. ${GOMOMO_FACTS.agent_identity_statement} ` +
        `Never refer to yourself as an "assistant", "virtual assistant", or "chatbot". ` +
        `Never say you are "powered by" anything.`,
      timestamp: new Date().toISOString(),
    });

    try {
      const storefrontResult = await routeStorefrontQuestion(userMessage);

      // For facts and approved_faq results, return the deterministic answer
      // directly WITHOUT calling the LLM. This saves tokens and prevents
      // any possibility of hallucinated pricing, contacts, or brand details.
      if (storefrontResult.type === 'facts' || storefrontResult.type === 'approved_faq') {
        const answer = storefrontResult.answer;

        conversation.push({
          role: 'assistant',
          content: answer,
          timestamp: new Date().toISOString(),
        });

        // Save conversation and return — LLM is never invoked
        await sessionRepo.updateConversation(sessionId, conversation);

        const processed = postProcessResponse(answer, {
          toolsUsed: [],
          channel: options.channel,
        });

        return {
          response: processed,
          meta: { tools_used: [], has_async_job: false },
        };
      }
      // For RAG results, inject retrieved context as a system message
      // so the LLM composes a friendly answer grounded in approved docs.
      else if (storefrontResult.type === 'rag') {
        const contextPrompt = buildStorefrontContextPrompt(storefrontResult);
        if (contextPrompt) {
          conversation.push({
            role: 'system',
            content: contextPrompt,
            timestamp: new Date().toISOString(),
          });
        }
      }
      // 'bypass' (booking intent) and 'unknown' — no injection, normal flow
    } catch (err) {
      // Storefront routing failure is non-fatal — fall through to normal agent
      console.warn('[storefront-router] Error (non-fatal):', err);
    }
  }

  // 4. Call the model (with tool loop)
  const maxToolRounds = 5; // Safety limit
  let finalResponse = '';
  const toolsUsed: string[] = [];
  let bookingData: BookingData | undefined;

  for (let round = 0; round < maxToolRounds; round++) {
    const messages: ChatCompletionMessageParam[] = conversation.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.tool_call_id!,
        };
      }
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: tc.function,
          })),
        };
      }
      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      };
    });

    // Build the tools list — include debug tool only when CALENDAR_DEBUG=true
    const tools = env.CALENDAR_DEBUG === 'true'
      ? [...agentTools, debugAvailabilityTool]
      : agentTools;

    const completion = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages,
      tools: tools as any,
      tool_choice: 'auto',
      temperature: 0.3, // Low temperature for deterministic behavior
      stream: true,
    });

    // ── Accumulate streamed chunks ──────────────────────────
    let contentAccum = '';
    const toolCallAccum: Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }> = new Map();
    let isToolRound = false;

    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Text content tokens — stream to client
      if (delta.content) {
        contentAccum += delta.content;
        options.onToken?.(delta.content);
      }

      // Tool call deltas — accumulate without streaming
      if (delta.tool_calls) {
        isToolRound = true;
        for (const tc of delta.tool_calls) {
          const existing = toolCallAccum.get(tc.index);
          if (!existing) {
            toolCallAccum.set(tc.index, {
              id: tc.id ?? '',
              type: 'function',
              function: {
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              },
            });
          } else {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name += tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          }
        }
      }
    }

    const assembledToolCalls = [...toolCallAccum.values()];

    if (isToolRound && assembledToolCalls.length > 0) {
      // Agent wants to call tools
      conversation.push({
        role: 'assistant',
        content: contentAccum || '',
        tool_calls: assembledToolCalls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
        timestamp: new Date().toISOString(),
      });

      // Execute each tool call
      for (const toolCall of assembledToolCalls) {
        // Emit granular status for the tool being executed
        const statusMap: Record<string, string> = {
          check_availability: 'Checking the schedule…',
          hold_slot: 'Reserving that slot…',
          confirm_booking: 'Booking that now…',
          reschedule_booking: 'Rescheduling your appointment…',
          cancel_booking: 'Processing cancellation…',
          lookup_booking: 'Looking up your booking…',
          create_inquiry: 'Adding you to the waitlist…',
          schedule_contact_followup: 'Scheduling a follow-up…',
        };
        const statusDetail = statusMap[toolCall.function.name] ?? 'Working on it…';
        options.onStatus?.('tool_call', statusDetail);

        toolsUsed.push(toolCall.function.name);
        const toolArgs = JSON.parse(toolCall.function.arguments);

        // Auto-inject client_phone from session metadata for SMS bookings
        // (SMS callers' phone is seeded into session metadata on first message)
        if (toolCall.function.name === 'confirm_booking' && !toolArgs.client_phone) {
          const meta = (session.metadata ?? {}) as Record<string, unknown>;
          if (meta.client_phone) {
            toolArgs.client_phone = meta.client_phone;
          }
        }
        // Normalize client_phone to E.164 regardless of source
        if (toolArgs.client_phone) {
          toolArgs.client_phone = normalizePhone(toolArgs.client_phone) ?? toolArgs.client_phone;
        }

        const toolResult = await executeToolCall(
          toolCall.function.name as ToolName,
          toolArgs,
          tenantId,
          sessionId,
          tenant,
        );

        // Capture structured booking data for client-side rich rendering
        if (toolCall.function.name === 'confirm_booking' && toolResult.success && toolResult.data) {
          bookingData = {
            appointment_id: toolResult.data.appointment_id,
            reference_code: toolResult.data.reference_code,
            client_name: toolResult.data.client_name,
            service: toolResult.data.service ?? null,
            start_time: String(toolResult.data.start_time),
            end_time: String(toolResult.data.end_time),
            display_time: toolResult.data.display_time,
            timezone: toolResult.data.timezone,
            add_to_calendar_url: toolResult.data.add_to_calendar_url,
          };
          // Increment trial booking counter after successful booking
          try {
            await sessionRepo.incrementBookingCount(sessionId);
          } catch { /* best-effort — don't break the booking flow */ }
        }

        // Capture client contact info in session metadata for workflow A (hold follow-up)
        if (
          (toolCall.function.name === 'confirm_booking' || toolCall.function.name === 'create_inquiry' || toolCall.function.name === 'schedule_contact_followup') &&
          toolArgs.client_email
        ) {
          try {
            const existingMeta = (session.metadata ?? {}) as Record<string, unknown>;
            await sessionRepo.updateMetadata(sessionId, {
              ...existingMeta,
              client_email: toolArgs.client_email,
              client_name: toolArgs.client_name ?? existingMeta.client_name,
            });

            // Learn customer identity from booking (async, best-effort)
            if (toolCall.function.name === 'confirm_booking' && toolArgs.client_email) {
              try {
                const { customerService } = await import('../services/customer.service.js');
                const customer = await customerService.resolveFromBooking(tenantId, {
                  email: toolArgs.client_email,
                  name: toolArgs.client_name ?? '',
                  phone: toolArgs.client_phone ?? existingMeta.client_phone ?? null,
                  service: toolArgs.service_name ?? null,
                });
                await sessionRepo.linkCustomer(sessionId, customer.id);
              } catch { /* best-effort customer resolution */ }
            }
          } catch { /* best-effort */ }
        }

        conversation.push({
          role: 'tool',
          content: JSON.stringify(toolResult),
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          timestamp: new Date().toISOString(),
        });
      }

      // Continue the loop to let the model respond to tool results
      continue;
    }

    // No tool calls — this is the final response
    finalResponse = contentAccum;
    conversation.push({
      role: 'assistant',
      content: finalResponse,
      timestamp: new Date().toISOString(),
    });
    break;
  }

  // If we exhausted all tool rounds without a final text response,
  // make one last call without tools to force a text reply.
  if (!finalResponse) {
    const messages: ChatCompletionMessageParam[] = conversation.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.tool_call_id!,
        };
      }
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: tc.function,
          })),
        };
      }
      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      };
    });

    const fallbackStream = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages,
      temperature: 0.3,
      stream: true,
      // No tools — forces a text response
    });

    let fallbackContent = '';
    for await (const chunk of fallbackStream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        fallbackContent += delta.content;
        options.onToken?.(delta.content);
      }
    }

    finalResponse =
      fallbackContent ||
      'I apologize, but I was unable to complete that request. Could you please try again?';

    conversation.push({
      role: 'assistant',
      content: finalResponse,
      timestamp: new Date().toISOString(),
    });
  }

  // 5. Save conversation
  await sessionRepo.updateConversation(sessionId, conversation);

  // 6. Post-process: code-enforced guardrails on the final response text
  finalResponse = postProcessResponse(finalResponse, {
    toolsUsed,
    channel: options.channel,
  });

  const meta: ChatResponseMeta = {
    tools_used: toolsUsed,
    has_async_job: toolsUsed.some((t) => ASYNC_JOB_TOOLS.has(t)),
    ...(bookingData ? { booking_data: bookingData } : {}),
  };

  return { response: finalResponse, meta };
}
