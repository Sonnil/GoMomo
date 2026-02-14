// ============================================================
// gomomo.ai — Centralized Brand Constants
// ============================================================
// Single source of truth for all user-facing brand strings.
// Import from here instead of hardcoding brand text.
// ============================================================

/** Primary brand name — used in titles, headers, and hero text. */
export const BRAND_NAME = 'gomomo.ai';

/** Short product tagline for hero sections and meta descriptions. */
export const PRODUCT_TAGLINE = 'Intelligent scheduling, powered by AI.';

/** Slightly longer description for landing pages and README. */
export const PRODUCT_DESCRIPTION =
  'An AI-powered service agent that books, reschedules, and cancels appointments via web chat — integrated with Google Calendar, no overbooking.';

/** The role-based label for the AI agent in user-facing copy. */
export const AGENT_LABEL = 'AI agent';

/** Shorter agent label for inline status messages (e.g. typing indicators). */
export const AGENT_SHORT = 'Agent';

/** Status text shown while the agent is processing a request. */
export const AGENT_WORKING_STATUS = 'Agent is working on it…';

/** Greeting shown in the empty chat state. */
export const CHAT_GREETING = `👋 Hi! I'm your ${AGENT_LABEL}. How can I help you today?`;

/** Attribution stamp placed in Google Calendar event descriptions. */
export const CALENDAR_ATTRIBUTION = `Booked via ${BRAND_NAME}`;

/** Footer attribution for the demo presentation page. */
export const DEMO_FOOTER = `Powered by <strong>${BRAND_NAME}</strong>`;

/** Console banner brand line for scripts and server startup. */
export const CONSOLE_BRAND = `🚀 ${BRAND_NAME}`;

/** The "built by" credit — now refers to gomomo.ai itself. */
export const BUILT_BY = `Built by ${BRAND_NAME}`;
