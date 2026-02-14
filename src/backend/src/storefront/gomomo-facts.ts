// ============================================================
// Gomomo Storefront Facts — Canonical Source of Truth
// ============================================================
// This file is the SINGLE authoritative source for all hard facts
// about Gomomo (brand, pricing, contact, features, links).
//
// The AI agent references this file to answer storefront questions
// WITHOUT hallucinating. When pricing, contacts, or features change,
// edit THIS FILE — the agent picks up changes on next import.
//
// ⚠ NEVER put speculative or aspirational content here.
//    Only include facts that are live and verifiable TODAY.
// ============================================================

export interface PricingPlan {
  name: string;
  price: string;
  billing_cycle: string;
  limits: string;
  channels: string[];
  notes: string;
}

export interface ContactInfo {
  general: string;
  partners: string;
  legal: string;
  privacy: string;
  support: string;
  sales: string;
}

export interface ChannelSupport {
  web_chat: { enabled: boolean; description: string };
  sms: { enabled: boolean; description: string };
  voice: { enabled: boolean; description: string };
}

export interface KeyLink {
  label: string;
  url: string;
}

export interface PartnershipChannel {
  type: string;
  description: string;
  contact_email: string;
  suggested_subject: string;
  pitch: string;
}

export interface SalesCta {
  booking_link: string;
  sales_email: string;
  calendar_demo_service_name: string;
  default_duration_minutes: number;
}

export interface GomomoFacts {
  brand_name: string;
  tagline: string;
  short_description: string;
  long_description: string;
  short_identity: string;
  agent_identity_statement: string;
  mission: string;
  vision: string;
  positioning: string;
  primary_outcomes: string[];
  contact: ContactInfo;
  pricing_plans: PricingPlan[];
  supported_channels: ChannelSupport;
  key_features: string[];
  supported_industries: string[];
  key_links: KeyLink[];
  partnership_channels: PartnershipChannel[];
  sales_cta: SalesCta;
  last_updated: string; // ISO 8601
}

// ── THE FACTS ───────────────────────────────────────────────

export const GOMOMO_FACTS: GomomoFacts = {
  brand_name: 'Gomomo',
  tagline: 'AI receptionists for every business',
  short_description:
    'Gomomo is an AI receptionist platform that automates appointment booking, customer messaging, and follow-ups — across web chat, SMS, and voice.',
  long_description:
    'Gomomo provides AI-powered receptionists for businesses of any size. ' +
    'It automates appointment booking, rescheduling, cancellation, customer messaging, and follow-ups. ' +
    'It supports multiple channels (web chat widget, SMS text messaging, and voice), ' +
    'can be embedded on any website, and works across industries — salons, law firms, ' +
    'consultancies, auto shops, and more. Built by the Gomomo team at gomomo.ai.',

  short_identity:
    'Gomomo is an AI-powered booking and customer engagement platform.',

  agent_identity_statement:
    'I am Gomomo — your AI-powered booking and business engagement platform. Built by the Gomomo team at gomomo.ai.',

  mission:
    'Gomomo\'s mission is to give every business an AI receptionist that never misses a call, never forgets a booking, and works 24/7 — so business owners can focus on what they do best.',

  vision:
    'We envision a future where every storefront — physical or digital — has an intelligent AI receptionist. ' +
    'Today that means chat, SMS, and voice agents. Tomorrow it means physical AI robots greeting customers at the door. ' +
    'Gomomo is building the foundation for the future robot receptionist.',

  positioning:
    'Gomomo is built for SMBs first — solo practitioners, small teams, and growing businesses that can\'t afford a full-time receptionist. ' +
    'Next we\'re expanding to serve solo professionals (freelancers, consultants, coaches). ' +
    'Long-term, consumers will interact with Gomomo-powered receptionists everywhere they go.',

  primary_outcomes: [
    'Save 10+ hours per week on phone and scheduling tasks',
    'Fewer missed calls — AI answers every inquiry, 24/7',
    'Higher conversion — instant responses mean fewer lost leads',
    'Round-the-clock coverage — evenings, weekends, holidays included',
    'Reduced no-shows with automated confirmations and reminders',
  ],

  contact: {
    general: 'hello@gomomo.ai',
    partners: 'partners@gomomo.ai',
    legal: 'legal@gomomo.ai',
    privacy: 'privacy@gomomo.ai',
    support: 'support@gomomo.ai',
    sales: 'hello@gomomo.ai',
  },

  pricing_plans: [
    {
      name: 'Free',
      price: '$0/month',
      billing_cycle: 'monthly',
      limits: 'Up to 25 bookings/month, 1 channel (web chat)',
      channels: ['web_chat'],
      notes: 'Ideal for solo practitioners getting started. No credit card required.',
    },
    {
      name: 'Pro',
      price: '$49/month',
      billing_cycle: 'monthly',
      limits: 'Up to 200 bookings/month, 2 channels (web chat + SMS)',
      channels: ['web_chat', 'sms'],
      notes: 'Best for small businesses with moderate booking volume.',
    },
    {
      name: 'Business',
      price: '$149/month',
      billing_cycle: 'monthly',
      limits: 'Up to 1,000 bookings/month, all channels (web chat + SMS + voice)',
      channels: ['web_chat', 'sms', 'voice'],
      notes: 'For growing businesses with high booking volume and multi-channel needs.',
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      billing_cycle: 'annual',
      limits: 'Unlimited bookings, all channels, dedicated account manager',
      channels: ['web_chat', 'sms', 'voice'],
      notes: 'Custom pricing for large organizations. Contact partners@gomomo.ai.',
    },
  ],

  supported_channels: {
    web_chat: {
      enabled: true,
      description: 'Embeddable chat widget for any website. Supports rich UI, intake forms, and real-time push notifications.',
    },
    sms: {
      enabled: true,
      description: 'Two-way SMS messaging for bookings, reminders, and follow-ups. Supports opt-in/out compliance.',
    },
    voice: {
      enabled: true,
      description: 'AI-powered voice calls via Twilio integration. Handles inbound calls and hands off to humans when needed.',
    },
  },

  key_features: [
    'Appointment booking, rescheduling, and cancellation',
    'Automated SMS and email confirmations and reminders',
    'Waitlist management with proactive notifications',
    'Google Calendar integration (two-way sync)',
    'Embeddable web chat widget',
    'Multi-tenant architecture — manage multiple locations',
    'Intake forms for structured booking requests',
    'Returning customer recognition',
    'Trial/demo mode for prospects',
    'Admin onboarding dashboard',
  ],

  supported_industries: [
    'Salons & spas',
    'Medical & dental clinics',
    'Law firms',
    'Consultancies',
    'Fitness studios & gyms',
    'Auto repair shops',
    'Tutoring & education',
    'Real estate offices',
    'Veterinary clinics',
    'Any appointment-based business',
  ],

  key_links: [
    { label: 'Website', url: 'https://gomomo.ai' },
    { label: 'Privacy Policy', url: 'https://gomomo.ai/privacy' },
    { label: 'Terms of Service', url: 'https://gomomo.ai/terms' },
    { label: 'Data Deletion', url: 'https://gomomo.ai/data-deletion' },
    { label: 'Documentation', url: 'https://docs.gomomo.ai' },
    { label: 'Status Page', url: 'https://status.gomomo.ai' },
  ],

  partnership_channels: [
    {
      type: 'advertising',
      description: 'Brands can advertise products and services to customers during AI receptionist conversations.',
      contact_email: 'partners@gomomo.ai',
      suggested_subject: 'Advertising Partnership with Gomomo',
      pitch: 'Reach engaged customers at the moment they\'re booking services — contextual, non-intrusive ad placements inside AI receptionist conversations.',
    },
    {
      type: 'b2b_partnerships',
      description: 'Agencies, marketplaces, and vertical SaaS platforms can integrate Gomomo as a white-label or embedded AI receptionist.',
      contact_email: 'partners@gomomo.ai',
      suggested_subject: 'B2B Partnership Inquiry — Gomomo',
      pitch: 'Embed Gomomo\'s AI receptionist into your platform — white-label, API-first, with full booking + messaging automation for your customers.',
    },
    {
      type: 'integrations',
      description: 'Calendar, CRM, and phone system providers can build native integrations with Gomomo.',
      contact_email: 'partners@gomomo.ai',
      suggested_subject: 'Integration Partnership — Gomomo',
      pitch: 'Connect your calendar, CRM, or phone system with Gomomo\'s AI receptionist — open API, webhooks, and pre-built connectors.',
    },
    {
      type: 'resellers',
      description: 'Resellers and affiliates can earn revenue by referring businesses to Gomomo.',
      contact_email: 'partners@gomomo.ai',
      suggested_subject: 'Reseller / Affiliate Inquiry — Gomomo',
      pitch: 'Join our reseller program and earn commissions for every business you bring to Gomomo. Ideal for consultants, agencies, and tech-savvy professionals.',
    },
    {
      type: 'investors',
      description: 'Gomomo welcomes conversations with investors aligned with AI, SaaS, and SMB tooling.',
      contact_email: 'hello@gomomo.ai',
      suggested_subject: 'Investment Inquiry — Gomomo',
      pitch: 'Gomomo is building the future of AI receptionists for SMBs — chat, SMS, voice today; physical AI robots tomorrow. Let\'s talk.',
    },
  ],

  sales_cta: {
    booking_link: 'https://gomomo.ai',
    sales_email: 'hello@gomomo.ai',
    calendar_demo_service_name: 'Gomomo Partnership Call',
    default_duration_minutes: 30,
  },

  last_updated: '2026-02-11T00:00:00Z',
};

// ── Template-based answers (deterministic, no LLM needed) ───

export interface FactsAnswer {
  answer: string;
  source: 'facts';
  section: string;
}

/**
 * Try to answer a storefront question using hard facts alone.
 * Returns null if the question doesn't map to a known fact category.
 */
export function answerFromFacts(query: string): FactsAnswer | null {
  const q = query.toLowerCase().trim();

  // ── Mission ───────────────────────────────────────────────
  if (matchesAny(q, ['mission', 'what problem', 'why gomomo', 'why does gomomo matter', 'what drives gomomo', 'purpose'])) {
    return {
      answer: `${GOMOMO_FACTS.mission}\n\nKey outcomes for businesses:\n${GOMOMO_FACTS.primary_outcomes.map((o) => `• ${o}`).join('\n')}\n\nWant to learn more? I can book a call with our team — just say the word!`,
      source: 'facts',
      section: 'mission',
    };
  }

  // ── Vision ────────────────────────────────────────────────
  if (matchesAny(q, ['vision', 'future', 'roadmap', 'where is gomomo headed', 'robot receptionist', 'physical ai'])) {
    return {
      answer: `${GOMOMO_FACTS.vision}\n\nInterested in being part of the journey? I can book a call to discuss. Just let me know!`,
      source: 'facts',
      section: 'vision',
    };
  }

  // ── Positioning / who is it for ───────────────────────────
  if (matchesAny(q, ['who is it for', 'target market', 'positioning', 'who uses gomomo', 'is it for me', 'small business', 'smb'])) {
    return {
      answer: `${GOMOMO_FACTS.positioning}\n\nWant to see how it works for your business? I can book a quick 30-minute demo call.`,
      source: 'facts',
      section: 'positioning',
    };
  }

  // ── Outcomes / benefits / value ───────────────────────────
  if (matchesAny(q, ['outcomes', 'benefits', 'results', 'value', 'roi', 'what do i get', 'why should i'])) {
    const outcomes = GOMOMO_FACTS.primary_outcomes.map((o) => `• ${o}`).join('\n');
    return {
      answer: `Here's what businesses get with Gomomo:\n${outcomes}\n\nWant to discuss how this applies to your business? I can set up a call!`,
      source: 'facts',
      section: 'outcomes',
    };
  }

  // ── Partnership — advertising ─────────────────────────────
  if (matchesAny(q, ['advertise', 'advertising', 'ad placement', 'sponsor', 'sponsorship'])) {
    const ch = GOMOMO_FACTS.partnership_channels.find((c) => c.type === 'advertising')!;
    return {
      answer: `Great question! ${ch.pitch}\n\nTo discuss an advertising partnership, you can email ${ch.contact_email} with subject "${ch.suggested_subject}", or I can book a ${GOMOMO_FACTS.sales_cta.default_duration_minutes}-minute call with our partnerships team right now. Would you like to book a call?`,
      source: 'facts',
      section: 'partnership_advertising',
    };
  }

  // ── Integration questions ─────────────────────────────────
  if (matchesAny(q, ['integration', 'integrate', 'connect', 'api', 'webhook', 'crm', 'calendar sync'])) {
    const ch = GOMOMO_FACTS.partnership_channels.find((c) => c.type === 'integrations')!;
    return {
      answer: `${ch.pitch}\n\nGomomo currently integrates with Google Calendar (two-way sync) and supports Twilio for voice/SMS. More integrations are on the roadmap.\n\nTo discuss a custom integration, email ${ch.contact_email} or I can book a call. Would you like that?`,
      source: 'facts',
      section: 'partnership_integrations',
    };
  }

  // ── Partnership — B2B / reseller / affiliate ──────────────
  if (matchesAny(q, ['partner', 'partnership', 'reseller', 'affiliate', 'agency', 'white label', 'white-label', 'embed gomomo'])) {
    const b2b = GOMOMO_FACTS.partnership_channels.find((c) => c.type === 'b2b_partnerships')!;
    const integrations = GOMOMO_FACTS.partnership_channels.find((c) => c.type === 'integrations')!;
    const resellers = GOMOMO_FACTS.partnership_channels.find((c) => c.type === 'resellers')!;
    return {
      answer: `We'd love to explore a partnership! Here are the ways we work with partners:\n\n• **B2B / Platform:** ${b2b.pitch}\n• **Integrations:** ${integrations.pitch}\n• **Resellers / Affiliates:** ${resellers.pitch}\n\nEmail ${b2b.contact_email} or I can book a ${GOMOMO_FACTS.sales_cta.default_duration_minutes}-minute "${GOMOMO_FACTS.sales_cta.calendar_demo_service_name}" for you. Shall I check available times?`,
      source: 'facts',
      section: 'partnership_b2b',
    };
  }

  // ── Investor inquiries ────────────────────────────────────
  if (matchesAny(q, ['invest', 'investor', 'investing', 'funding', 'pitch', 'pitch deck', 'raise', 'fundraise', 'venture', 'vc'])) {
    const ch = GOMOMO_FACTS.partnership_channels.find((c) => c.type === 'investors')!;
    return {
      answer: `Thanks for your interest! ${ch.pitch}\n\nPlease reach out to ${ch.contact_email} with subject "${ch.suggested_subject}" and we'll set up a conversation. Or I can book a ${GOMOMO_FACTS.sales_cta.default_duration_minutes}-minute call now — shall I?`,
      source: 'facts',
      section: 'partnership_investors',
    };
  }

  // ── Sales / demo / book a call CTA ────────────────────────
  if (matchesAny(q, ['book a call', 'talk to sales', 'speak to someone', 'schedule a demo', 'demo', 'talk to a human', 'speak to a person', 'sales call', 'get a demo'])) {
    return {
      answer: `Absolutely! I can book a "${GOMOMO_FACTS.sales_cta.calendar_demo_service_name}" for you — it's a free ${GOMOMO_FACTS.sales_cta.default_duration_minutes}-minute call with our team.\n\nWould you like me to check available times? I'll just need your preferred date and time range to get started.\n\nOr if you'd prefer email, reach out to ${GOMOMO_FACTS.sales_cta.sales_email} anytime.`,
      source: 'facts',
      section: 'sales_cta',
    };
  }

  // ── Brand / identity ──────────────────────────────────────
  if (matchesAny(q, ['what is gomomo', 'tell me about gomomo', 'who is gomomo', 'what does gomomo do', 'describe gomomo', 'what do you do'])) {
    return {
      answer: `${GOMOMO_FACTS.short_description}\n\n${GOMOMO_FACTS.mission}\n\nLearn more at gomomo.ai, or I can book a demo call if you'd like to see it in action!`,
      source: 'facts',
      section: 'brand',
    };
  }

  // ── Pricing ───────────────────────────────────────────────
  if (matchesAny(q, [
    // English
    'pricing', 'how much', 'cost', 'price', 'plans', 'subscription', 'free plan', 'free tier', 'buy', 'purchase',
    // Vietnamese
    'giá', 'giá cả', 'bao nhiêu', 'bao nhiêu tiền', 'chi phí', 'phí', 'gói dịch vụ',
    // French
    'prix', 'tarif', 'combien', 'abonnement', 'forfait', 'coût',
    // Spanish
    'precio', 'cuánto', 'costo', 'tarifa', 'planes', 'suscripción',
    // German
    'preis', 'kosten', 'wie viel',
    // Chinese
    '价格', '多少钱', '费用', '套餐', '订阅',
    // Japanese
    '料金', '値段', 'いくら', 'プラン', 'サブスク',
    // Korean
    '가격', '얼마', '요금', '구독', '플랜',
  ])) {
    // Empty pricing_plans → contact fallback (no hallucination)
    if (!GOMOMO_FACTS.pricing_plans || GOMOMO_FACTS.pricing_plans.length === 0) {
      return {
        answer: 'Pricing is currently being finalized. Please contact hello@gomomo.ai.',
        source: 'facts',
        section: 'pricing',
      };
    }
    const plans = GOMOMO_FACTS.pricing_plans.map(
      (p) => `• ${p.name}: ${p.price} — ${p.limits}`,
    ).join('\n');
    return {
      answer: `Here are Gomomo's pricing plans:\n${plans}\n\nFor Enterprise pricing, contact ${GOMOMO_FACTS.contact.partners}. Visit gomomo.ai for full details.\n\nWant to discuss which plan is right for you? I can book a quick call with our team!`,
      source: 'facts',
      section: 'pricing',
    };
  }

  // ── Contact ───────────────────────────────────────────────
  if (matchesAny(q, ['contact', 'email', 'reach', 'get in touch', 'support', 'help desk'])) {
    return {
      answer: `You can reach Gomomo at:\n• General / Sales: ${GOMOMO_FACTS.contact.general}\n• Support: ${GOMOMO_FACTS.contact.support}\n• Partnerships: ${GOMOMO_FACTS.contact.partners}\n\nOr I can book a call for you right now — just say the word!`,
      source: 'facts',
      section: 'contact',
    };
  }

  // ── How to buy / get started ──────────────────────────────
  if (matchesAny(q, ['how to buy', 'how do i buy', 'get started', 'sign up', 'signup', 'how to start', 'start using'])) {
    return {
      answer: `You can get started at gomomo.ai — sign up for a free account, no credit card required. For Enterprise plans, contact ${GOMOMO_FACTS.contact.partners}.\n\nWant a guided walkthrough? I can book a ${GOMOMO_FACTS.sales_cta.default_duration_minutes}-minute demo call for you.`,
      source: 'facts',
      section: 'purchase',
    };
  }

  // ── Features ──────────────────────────────────────────────
  if (matchesAny(q, ['features', 'what can it do', 'capabilities', 'what does it offer', 'functionality'])) {
    const features = GOMOMO_FACTS.key_features.slice(0, 6).map((f) => `• ${f}`).join('\n');
    return {
      answer: `Key features of Gomomo:\n${features}\n\n…and more. Visit gomomo.ai for the full feature list.`,
      source: 'facts',
      section: 'features',
    };
  }

  // ── Channels ──────────────────────────────────────────────
  if (matchesAny(q, ['channels', 'web chat', 'sms', 'voice', 'how can customers reach', 'communication'])) {
    const channels = Object.entries(GOMOMO_FACTS.supported_channels)
      .filter(([, v]) => v.enabled)
      .map(([k, v]) => `• ${k.replace('_', ' ')}: ${v.description}`)
      .join('\n');
    return {
      answer: `Gomomo supports these channels:\n${channels}`,
      source: 'facts',
      section: 'channels',
    };
  }

  // ── Industries ────────────────────────────────────────────
  if (matchesAny(q, ['industries', 'who can use', 'what businesses', 'what kind of business', 'verticals', 'sectors'])) {
    const industries = GOMOMO_FACTS.supported_industries.slice(0, 6).map((i) => `• ${i}`).join('\n');
    return {
      answer: `Gomomo works for any appointment-based business, including:\n${industries}\n\n…and many more.`,
      source: 'facts',
      section: 'industries',
    };
  }

  // ── Privacy / legal ───────────────────────────────────────
  if (matchesAny(q, ['privacy', 'data', 'gdpr', 'data deletion', 'data removal', 'terms', 'legal'])) {
    const privacyLink = GOMOMO_FACTS.key_links.find((l) => l.label === 'Privacy Policy');
    const termsLink = GOMOMO_FACTS.key_links.find((l) => l.label === 'Terms of Service');
    const deletionLink = GOMOMO_FACTS.key_links.find((l) => l.label === 'Data Deletion');
    return {
      answer: `For privacy and legal information:\n• Privacy Policy: ${privacyLink?.url}\n• Terms of Service: ${termsLink?.url}\n• Data Deletion: ${deletionLink?.url}\n\nQuestions? Contact ${GOMOMO_FACTS.contact.privacy}.`,
      source: 'facts',
      section: 'legal',
    };
  }

  // ── Who built it ──────────────────────────────────────────
  if (matchesAny(q, ['who built', 'who made', 'who created', 'built by', 'made by', 'team behind'])) {
    return {
      answer: `Gomomo is built by the Gomomo team. Learn more at gomomo.ai.`,
      source: 'facts',
      section: 'team',
    };
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────

function matchesAny(query: string, patterns: string[]): boolean {
  return patterns.some((p) => query.includes(p));
}
