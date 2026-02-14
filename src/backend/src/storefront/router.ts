// ============================================================
// Storefront Router — facts-first, then approved FAQs, then RAG
// ============================================================
// Routing priority:
//   1. Canonical facts (deterministic, no LLM)
//   2. Approved FAQs (human-approved, deterministic)
//   3. Retrieval (RAG) over approved corpus → compose via LLM
//   4. Fallback: log as unanswered FAQ, let normal agent handle
//
// This router is ONLY activated for tenant.slug === "gomomo".
// Booking intents bypass the storefront and go to the normal agent.
// ============================================================

import { answerFromFacts, GOMOMO_FACTS } from './gomomo-facts.js';
import { retrieveStorefrontContext, isRetrievalConfident } from './retrieval.js';
import { findApprovedAnswer, logUnansweredFaq, type ApprovedFaq } from './faq-repo.js';

// ── Types ───────────────────────────────────────────────────

export type StorefrontRouteResult =
  | { type: 'facts'; answer: string; section: string }
  | { type: 'approved_faq'; answer: string; faqId: string }
  | { type: 'rag'; passages: string[]; sources: string[]; query: string }
  | { type: 'bypass'; reason: string }
  | { type: 'unknown'; logged: boolean };

// ── Intent Detection ────────────────────────────────────────

const BOOKING_INTENTS = [
  'book', 'appointment', 'schedule', 'reschedule', 'cancel',
  'booking', 'reservation', 'available', 'availability',
  'slot', 'time slot', 'open time',
];

const STOREFRONT_INTENTS = [
  'what is gomomo', 'pricing', 'cost', 'price', 'how much',
  'contact', 'email', 'features', 'channels', 'industries',
  'privacy', 'terms', 'data deletion', 'gdpr',
  'how to buy', 'purchase', 'get started', 'sign up',
  'who built', 'who made', 'what problem', 'how does it work',
  'free plan', 'free trial', 'enterprise',
  'support', 'help',
  'what do you do', 'tell me about',
  // Sales & partnerships (Phase 10)
  'mission', 'vision', 'purpose', 'why gomomo',
  'partner', 'partnership', 'advertise', 'advertising', 'sponsorship',
  'integration', 'integrate', 'reseller', 'affiliate', 'agency', 'white label',
  'investor', 'invest', 'funding', 'pitch', 'venture',
  'demo', 'talk to sales', 'book a call', 'speak to someone', 'sales call',
  'schedule a demo', 'get a demo',
  'outcomes', 'benefits', 'results', 'roi', 'value',
  'positioning', 'who is it for', 'target market', 'smb',
  'buy',
  // ── Multilingual pricing/storefront triggers ──────────────
  // Vietnamese
  'giá', 'giá cả', 'bao nhiêu', 'bao nhiêu tiền', 'chi phí', 'phí',
  'gói dịch vụ', 'đăng ký', 'mua',
  // French
  'prix', 'tarif', 'combien', 'abonnement', 'forfait', 'coût',
  // Spanish
  'precio', 'cuánto', 'costo', 'tarifa', 'planes', 'suscripción',
  // German
  'preis', 'kosten', 'wie viel', 'abonnement', 'tarif',
  // Chinese
  '价格', '多少钱', '费用', '套餐', '订阅',
  // Japanese
  '料金', '値段', 'いくら', 'プラン', 'サブスク',
  // Korean
  '가격', '얼마', '요금', '구독', '플랜',
];

/**
 * Detect whether the user message is a storefront question or a booking intent.
 */
export function detectIntent(message: string): 'storefront' | 'booking' | 'ambiguous' {
  const lower = message.toLowerCase().trim();

  // Check booking intents first — they take priority
  const hasBookingIntent = BOOKING_INTENTS.some((b) => lower.includes(b));

  // If it's clearly a booking request, bypass storefront
  if (hasBookingIntent && !hasStorefrontSignal(lower)) {
    return 'booking';
  }

  // Check for storefront questions
  const hasStorefrontIntent = STOREFRONT_INTENTS.some((s) => lower.includes(s));
  if (hasStorefrontIntent) {
    return 'storefront';
  }

  // If we find booking words alongside storefront words, it's ambiguous
  if (hasBookingIntent && hasStorefrontSignal(lower)) {
    return 'ambiguous';
  }

  return 'ambiguous';
}

function hasStorefrontSignal(lower: string): boolean {
  return STOREFRONT_INTENTS.some((s) => lower.includes(s));
}

// ── Main Router ─────────────────────────────────────────────

/**
 * Route a storefront question through the priority chain:
 *   1. Facts → 2. Approved FAQs → 3. RAG → 4. Log as unanswered
 *
 * @param message - The user's message
 * @returns Routing result with the answer source
 */
export async function routeStorefrontQuestion(message: string): Promise<StorefrontRouteResult> {
  const intent = detectIntent(message);

  // Booking intents bypass the storefront entirely
  if (intent === 'booking') {
    return { type: 'bypass', reason: 'booking_intent' };
  }

  // ── 1. Try canonical facts ────────────────────────────────
  const factsAnswer = answerFromFacts(message);
  if (factsAnswer) {
    return {
      type: 'facts',
      answer: factsAnswer.answer,
      section: factsAnswer.section,
    };
  }

  // ── 2. Try approved FAQs ──────────────────────────────────
  let approvedFaq: ApprovedFaq | null = null;
  try {
    approvedFaq = await findApprovedAnswer(message);
  } catch {
    // DB might not be available (e.g., in tests) — continue gracefully
  }

  if (approvedFaq) {
    return {
      type: 'approved_faq',
      answer: approvedFaq.answer,
      faqId: approvedFaq.id,
    };
  }

  // ── 3. Try retrieval (RAG) ────────────────────────────────
  const retrieval = retrieveStorefrontContext(message, 3);
  if (isRetrievalConfident(retrieval)) {
    return {
      type: 'rag',
      passages: retrieval.results.map((r) => r.passage),
      sources: retrieval.results.map((r) => r.source),
      query: message,
    };
  }

  // ── 4. Unmatched — log as unanswered FAQ ──────────────────
  let logged = false;
  try {
    await logUnansweredFaq(message);
    logged = true;
  } catch {
    // DB might not be available — continue gracefully
  }

  return { type: 'unknown', logged };
}

/**
 * Build a system prompt supplement with storefront context.
 * This is injected into the conversation when the router determines
 * the question is storefront-related and RAG found relevant passages.
 */
export function buildStorefrontContextPrompt(result: StorefrontRouteResult): string | null {
  if (result.type === 'facts') {
    const isSalesCta = /^(partnership_|sales_cta|mission|vision|positioning|outcomes)/.test(result.section);
    const ctaSuffix = isSalesCta
      ? `\n\nIMPORTANT: This is a sales/partnership question. After answering, proactively offer to book a call. Use the existing booking flow (check_availability → hold_slot → confirm_booking) with service "${GOMOMO_FACTS.sales_cta.calendar_demo_service_name}" and duration ${GOMOMO_FACTS.sales_cta.default_duration_minutes} minutes. If booking is not possible, suggest emailing ${GOMOMO_FACTS.sales_cta.sales_email}.`
      : '';
    return `STOREFRONT ANSWER (from verified facts — use this verbatim, do NOT modify numbers or contacts):
${result.answer}

Respond to the user using this information. Keep it friendly and conversational. You may rephrase slightly but NEVER change factual details (prices, emails, URLs).${ctaSuffix}`;
  }

  if (result.type === 'approved_faq') {
    return `APPROVED FAQ ANSWER (human-verified — use this verbatim):
${result.answer}

Respond using this approved answer. You may adjust tone but NEVER change the factual content.`;
  }

  if (result.type === 'rag') {
    const passageBlock = result.passages.map((p, i) => `[${i + 1}] ${p}`).join('\n\n');
    const sourceList = [...new Set(result.sources)].join(', ');
    return `RETRIEVED CONTEXT (from approved docs: ${sourceList}):
${passageBlock}

Compose a helpful answer using ONLY the information above. Do NOT add facts not present in these passages. If the passages don't fully answer the question, say what you know and suggest contacting ${GOMOMO_FACTS.contact.support} for more details.`;
  }

  return null;
}
