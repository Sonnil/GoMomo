import 'dotenv/config';
import { z } from 'zod';

// ── Known weak / placeholder values that MUST be rejected in non-dev ──
const KNOWN_WEAK_SECRETS = new Set([
  'dev-only-placeholder-key-0000000000',
  'dev-handoff-signing-key',
  'change-me',
  'secret',
  'password',
  'test',
]);

// ── Obvious placeholder patterns — rejected in ALL environments ──
const PLACEHOLDER_PATTERNS = [
  /^your[-_]?key[-_]?here$/i,
  /^sk-[.]{3,}/,            // sk-...
  /^<.*>$/,                  // <your-key-here>
  /^TODO/i,
  /^REPLACE/i,
  /^CHANGEME$/i,
  /^xxx+$/i,
  /^placeholder/i,
];

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),

  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().optional().default('http://localhost:3000/api/oauth/google/callback'),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o'),

  ENCRYPTION_KEY: z.string().optional().default('dev-only-placeholder-key-0000000000'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // ── CORS Lockdown (pilot / production) ────────────────────
  // When NODE_ENV=production OR PILOT_MODE=true, CORS switches to
  // default-deny.  Only origins listed here are allowed.
  // Comma-separated.  Ignored in development (localhost is always ok).
  //   Example: https://pilot.gomomo.com,https://admin.gomomo.com
  CORS_ALLOWED_ORIGINS: z.string().optional().default(''),

  // Whether to include Access-Control-Allow-Credentials header.
  // Required for cookie/session-based auth flows.
  CORS_ALLOW_CREDENTIALS: z.enum(['true', 'false']).default('true'),

  // Friendly pilot mode — enables prod-like security without
  // requiring NODE_ENV=production (which may change other behaviors).
  PILOT_MODE: z.enum(['true', 'false']).default('false'),

  // ── HTTPS Enforcement ─────────────────────────────────────
  // When 'true': all browser-facing requests must arrive over HTTPS.
  // Behind a reverse proxy (nginx/caddy), the server trusts the
  // X-Forwarded-Proto header to determine the effective scheme.
  // Requests arriving over plain HTTP receive 403 Forbidden.
  // Default 'false' — safe for local dev / DEMO-FULL mode.
  REQUIRE_HTTPS: z.enum(['true', 'false']).default('false'),

  // ── Calendar Mode ─────────────────────────────────────────────
  // 'mock' = no external calendar API calls (DB-only, ideal for local dev)
  // 'real' = live Google Calendar integration (requires OAuth credentials)
  CALENDAR_MODE: z.enum(['real', 'mock']).default('mock'),

  // ── Calendar Failure Simulation ───────────────────────────────
  // Only applies when CALENDAR_MODE=mock. Simulates external failures.
  // 'none'          = normal mock behavior (default)
  // 'auth_error'    = createEvent throws 401 Invalid Credentials
  // 'network_error' = createEvent throws ECONNREFUSED
  // 'timeout'       = createEvent waits 5s then throws ETIMEDOUT
  // 'all_ops_fail'  = both createEvent AND deleteEvent throw
  CALENDAR_FAIL_MODE: z.enum(['none', 'auth_error', 'network_error', 'timeout', 'all_ops_fail']).default('none'),

  // ── Calendar Sync Required ────────────────────────────────────
  // When 'true': if calendar sync fails during booking, the booking
  // is rolled back and the agent tells the user to try again.
  // When 'false' (default): calendar sync is best-effort — booking
  // succeeds even if the calendar call fails.
  CALENDAR_SYNC_REQUIRED: z.enum(['true', 'false']).default('false'),

  // ── Calendar Read (Busy-Range) Policy ─────────────────────────
  // Controls behavior when the availability engine reads Google Calendar
  // busy times. Only applies when CALENDAR_MODE=real and OAuth is connected.
  //
  // 'true' (default — strict): if the Google Calendar freebusy call fails,
  //   the availability check returns an error (no unverified slots offered).
  // 'false' (lenient): on failure, fall back to DB-only availability
  //   and label the result as unverified.
  CALENDAR_READ_REQUIRED: z.enum(['true', 'false']).default('true'),

  // ── Calendar Busy-Range Cache TTL ─────────────────────────────
  // How many seconds to cache Google Calendar busy ranges per tenant
  // per time window. Short TTL avoids stale data while reducing API calls.
  CALENDAR_BUSY_CACHE_TTL_SECONDS: z.coerce.number().default(30),

  // ── Calendar Debug ────────────────────────────────────────────
  // When 'true': log detailed busy-range / slot-exclusion info and
  // expose GET /api/dev/calendar-debug/:tenantId (admin-only).
  // PII-safe: no event titles, no attendee emails — only time ranges.
  CALENDAR_DEBUG: z.enum(['true', 'false']).default('false'),

  HOLD_TTL_MINUTES: z.coerce.number().default(5),
  HOLD_CLEANUP_INTERVAL_MS: z.coerce.number().default(60000),

  // ── Twilio Voice Channel ──────────────────────────────────────
  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  TWILIO_PHONE_NUMBER: z.string().optional().default(''),       // E.164 — From number (used if no messaging service SID)
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional().default(''), // Preferred: Twilio Messaging Service SID
  TWILIO_WEBHOOK_BASE_URL: z.string().optional().default('http://localhost:3000'),
  // Sender type classification — used by /health/sms and startup diagnostics
  TWILIO_SENDER_TYPE: z.enum(['local_10dlc', 'toll_free', 'short_code', 'unknown']).default('unknown'),
  // A2P 10DLC registration status — advisory, not enforced at runtime
  TWILIO_A2P_STATUS: z.enum(['pending', 'approved', 'rejected', 'unknown']).default('unknown'),

  // ── Feature Flags (master kill switches) ────────────────────
  // FEATURE_CALENDAR_BOOKING: calendar availability + booking flow.
  //   When 'false': availability + appointment endpoints still exist
  //   but calendar writes are skipped.  Typically always 'true'.
  FEATURE_CALENDAR_BOOKING: z.enum(['true', 'false']).default('true'),
  // FEATURE_SMS: all outbound + inbound SMS (Twilio).
  //   When 'false': SMS routes return 404/disabled, outbound sends
  //   are no-ops, SMS reminders are not scheduled, Twilio startup
  //   credential check is skipped.  Existing per-feature flags
  //   (SMS_INBOUND_ENABLED, SMS_HANDOFF_ENABLED) are still respected
  //   when FEATURE_SMS='true'.
  FEATURE_SMS: z.enum(['true', 'false']).default('true'),
  // FEATURE_VOICE: inbound voice calls (Twilio).
  //   When 'false': voice + handoff routes return 404, VOICE_ENABLED
  //   is effectively overridden.
  FEATURE_VOICE: z.enum(['true', 'false']).default('true'),
  // FEATURE_VOICE_WEB: browser push-to-talk STT (OpenAI Whisper) + neural TTS.
  //   When 'true': POST /api/stt and POST /api/tts are registered —
  //   the widget can record audio, get transcripts, and play neural TTS.
  //   Requires OPENAI_API_KEY.
  //   When 'false' (default): routes not registered, mic button hidden.
  FEATURE_VOICE_WEB: z.enum(['true', 'false']).default('false'),

  // ── Web Voice Mode TTS Settings ───────────────────────────────
  // TTS_VOICE: default OpenAI TTS voice for the /api/tts endpoint.
  //   Options: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer
  TTS_VOICE: z.string().default('nova'),
  // TTS_MODEL: OpenAI TTS model. 'tts-1' (fast) or 'tts-1-hd' (higher quality).
  TTS_MODEL: z.string().default('tts-1'),

  // ── Voice Channel Settings ────────────────────────────────────
  VOICE_ENABLED: z.enum(['true', 'false']).default('true'),
  VOICE_DEFAULT_TENANT_ID: z.string().optional().default('00000000-0000-4000-a000-000000000001'),
  VOICE_MAX_CALL_DURATION_MS: z.coerce.number().default(600000),     // 10 min
  VOICE_MAX_TURNS: z.coerce.number().default(20),
  VOICE_MAX_RETRIES: z.coerce.number().default(3),                   // before giving up on a step
  VOICE_TTS_VOICE: z.string().default('Polly.Joanna'),               // Twilio <Say> voice
  VOICE_TTS_LANGUAGE: z.string().default('en-US'),
  VOICE_SPEECH_TIMEOUT: z.string().default('auto'),                  // Twilio speechTimeout
  VOICE_SPEECH_MODEL: z.string().default('phone_call'),              // Twilio speechModel

  // ── SMS Handoff Settings ──────────────────────────────────────
  SMS_HANDOFF_ENABLED: z.enum(['true', 'false']).default('true'),
  SMS_HANDOFF_WEB_URL: z.string().optional().default(''),            // Frontend URL for handoff links (falls back to CORS_ORIGIN)
  SMS_HANDOFF_TOKEN_TTL_MINUTES: z.coerce.number().default(15),      // Token expiration
  SMS_RATE_LIMIT_MAX: z.coerce.number().default(3),                  // Max SMS per phone per window
  SMS_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().default(60),      // Rate limit window

  // ── SMS Delivery Status Tracking ──────────────────────────────
  // When set, Twilio will POST delivery status updates (sent/delivered/
  // undelivered/failed) to this URL.  Typically:
  //   https://your-domain.com/webhooks/twilio/status
  // Leave empty to disable StatusCallback (Twilio still delivers,
  // but we won't track delivery status in sms_outbox).
  SMS_STATUS_CALLBACK_URL: z.string().optional().default(''),

  // ── Auth Session Rate Limiting ────────────────────────────────
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(20),                // Max POST /api/auth/session per IP per window
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),      // Window in ms (default 1 minute)

  // ── Inbound SMS Channel ───────────────────────────────────────
  // When 'true': POST /twilio/sms/incoming is registered, enabling
  // full two-way SMS conversations (book, reschedule, cancel) just
  // like web chat.  Requires Twilio credentials + a Twilio number.
  SMS_INBOUND_ENABLED: z.enum(['true', 'false']).default('true'),
  SMS_INBOUND_RATE_LIMIT_MAX: z.coerce.number().default(20),        // Max inbound SMS per phone per window (higher than outbound — booking needs ~8 turns)
  SMS_INBOUND_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().default(60), // Inbound rate limit window
  SMS_DEBUG: z.enum(['true', 'false']).default('false'),             // PII-safe debug logging for SMS turns

  // ── Demo Availability Mode ────────────────────────────────────
  // When 'true' (default in dev): the availability engine always
  // generates Mon–Fri 9 AM – 5 PM ET slots for the next 5 business
  // days, regardless of what the tenant's DB-stored hours say.
  // This guarantees GUI testing works even on weekends or with
  // misconfigured tenants.  Set to 'false' once a real calendar is
  // connected or when the tenant's business_hours are verified.
  DEMO_AVAILABILITY: z.enum(['true', 'false']).default('true'),

  // ── Default Tenant Drift Guard ─────────────────────────────
  // When 'true' (default) AND NODE_ENV !== 'production': on backend
  // boot the drift guard checks that the default tenant row
  // (00000000-0000-4000-a000-000000000001) matches expected repo
  // defaults (name, slug, service_catalog_mode).  If a mismatch is
  // detected the row is auto-corrected and a log line is emitted.
  // Set to 'false' to disable the guard entirely.
  DEMO_TENANT_DRIFT_GUARD: z.enum(['true', 'false']).default('true'),

  // ── Excel Integration Settings ────────────────────────────────
  EXCEL_ENABLED: z.enum(['true', 'false']).default('false'),         // Global kill switch
  EXCEL_DEFAULT_FILE_PATH: z.string().optional().default(''),        // Local file path for dev (overrides tenant config)
  EXCEL_SYNC_INTERVAL_SECONDS: z.coerce.number().default(30),        // Outbound sync debounce
  EXCEL_RECONCILIATION_INTERVAL_MS: z.coerce.number().default(300000), // 5 min reconciliation cycle

  // ── Agent Runtime / Autonomy ──────────────────────────────────
  // Master switch. When 'false' (default), events are still logged
  // and audit trail works, but the job runner does NOT poll/execute.
  AUTONOMY_ENABLED: z.enum(['true', 'false']).default('false'),
  AGENT_MAX_CONCURRENT_JOBS: z.coerce.number().default(3),
  AGENT_JOB_POLL_INTERVAL_MS: z.coerce.number().default(5000),
  AGENT_JOB_STALE_TIMEOUT_MS: z.coerce.number().default(300000),     // 5 min

  // ── Follow-Up Messaging Guardrails ─────────────────────────
  // Max follow-up contacts (SMS/email) per chat session/booking.
  // Once this limit is reached, the agent must inform the user
  // and refuse additional follow-ups without human override.
  FOLLOWUP_MAX_PER_BOOKING: z.coerce.number().default(2),
  // Minimum minutes between follow-up messages to the same
  // recipient.  Prevents rapid-fire SMS/email if the agent or
  // user triggers multiple follow-ups in quick succession.
  FOLLOWUP_COOLDOWN_MINUTES: z.coerce.number().default(60),

  // ── Date-Distance Confirmation Guardrail ──────────────────
  // If a user requests a booking more than this many days in the
  // future, the agent asks for explicit confirmation before placing
  // a hold.  Set to 0 to disable the guardrail entirely.
  BOOKING_FAR_DATE_CONFIRM_DAYS: z.coerce.number().default(30),

  // ── SDK / Client Auth ─────────────────────────────────────
  // Secret used to sign session tokens. Falls back to ENCRYPTION_KEY.
  SESSION_TOKEN_SECRET: z.string().optional().default(''),
  // When 'true': REST + WebSocket require a valid session token.
  // When 'false' (default): tokens are optional (backwards-compatible).
  SDK_AUTH_REQUIRED: z.enum(['true', 'false']).default('false'),

  // ── Admin API Key ─────────────────────────────────────────
  // Shared secret for admin/operator routes (tenant CRUD, customer
  // management, autonomy policy changes, OAuth setup).
  // Must be set when SDK_AUTH_REQUIRED=true. Passed as:
  //   Authorization: Bearer admin.<key>
  // or X-Admin-Key: <key>
  ADMIN_API_KEY: z.string().optional().default(''),

  // ── Email Gate / Lead Capture ───────────────────────────
  // When 'true' (default in production): anonymous users get 1 free message,
  // then must verify their email to continue chatting.
  // When 'false': no email gate — anyone can chat freely.
  // Email gate disabled in development for faster iteration.
  // In dev/test, defaults to 'false'; in production, defaults to 'true'.
  REQUIRE_EMAIL_AFTER_FIRST_MESSAGE: z.enum(['true', 'false']).default(
    process.env.NODE_ENV === 'production' ? 'true' : 'false',
  ),
  // Verification code TTL in minutes (default 10)
  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().default(10),
  // Max failed verification attempts before lockout
  EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce.number().default(5),
  // Rate limit: max verification requests per email per hour
  EMAIL_VERIFICATION_RATE_LIMIT: z.coerce.number().default(5),

  // ── Email Delivery ────────────────────────────────────────
  // Provider for sending transactional email (OTP codes).
  //   'resend'   = Resend (https://resend.com) — recommended
  //   'postmark' = Postmark (https://postmarkapp.com)
  //   'console'  = Log to stdout only (no real delivery)
  EMAIL_PROVIDER: z.enum(['resend', 'postmark', 'console']).default('console'),
  // Sender address (must be verified with your provider)
  EMAIL_FROM: z.string().default('Gomomo.ai <aireceptionistt@gmail.com>'),
  // Reply-to address (optional — falls back to EMAIL_FROM)
  EMAIL_REPLY_TO: z.string().optional().default(''),
  // Resend API key (required when EMAIL_PROVIDER=resend)
  RESEND_API_KEY: z.string().optional().default(''),
  // Postmark server API token (required when EMAIL_PROVIDER=postmark)
  POSTMARK_API_TOKEN: z.string().optional().default(''),
  // When 'true': forces console provider regardless of EMAIL_PROVIDER.
  // Useful for local dev / CI — never sends real email.
  EMAIL_DEV_MODE: z.enum(['true', 'false']).default('true'),

  // ── CEO Pilot Test Mode ───────────────────────────────
  // When 'true': registers /debug/ceo-test/* endpoints for
  // end-to-end GUI testing.  Token-protected by CEO_TEST_TOKEN.
  // Automatically enabled in development (NODE_ENV=development).
  CEO_TEST_MODE: z.enum(['true', 'false']).default('false'),
  CEO_TEST_TOKEN: z.string().optional().default('ceo-pilot-2026'),

  // ── reCAPTCHA Spam Protection ─────────────────────────
  // When 'true': public actions (intake form, email verification)
  // require a valid reCAPTCHA token from the frontend.
  // When 'false' (default): captcha is skipped — safe for local dev.
  RECAPTCHA_ENABLED: z.enum(['true', 'false']).default('false'),
  // v3 site key (public — embedded in frontend)
  RECAPTCHA_SITE_KEY: z.string().optional().default(''),
  // v3 secret key (server-side verification)
  RECAPTCHA_SECRET_KEY: z.string().optional().default(''),
  // Minimum score threshold (0.0–1.0). Requests below this are rejected.
  RECAPTCHA_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),

  // ── Usage Tracking ─────────────────────────────────────
  // Max user messages per session (legacy, disabled).
  // 0 = unlimited (no cap). Default: 0 — chat is unlimited.
  TRIAL_MAX_USER_MESSAGES: z.coerce.number().default(0),
  // Session-level booking counter (analytics only).
  // Rate limit is enforced via behavioral risk engine in confirm_booking.
  TRIAL_MAX_BOOKINGS: z.coerce.number().default(1),
}).superRefine((data, ctx) => {
  const isDev = data.NODE_ENV === 'development' || data.NODE_ENV === 'test';

  // ── ALL ENVIRONMENTS: reject obvious placeholder API keys ───
  // Fail fast so nobody accidentally runs a demo with a dummy key.
  const isPlaceholder = (val: string) =>
    PLACEHOLDER_PATTERNS.some(re => re.test(val));

  if (isPlaceholder(data.OPENAI_API_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENAI_API_KEY'],
      message: 'OPENAI_API_KEY looks like a placeholder. Set a real API key.',
    });
  }

  if (data.DATABASE_URL && isPlaceholder(data.DATABASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message: 'DATABASE_URL looks like a placeholder. Set a real connection string.',
    });
  }

  // ── In non-dev environments, enforce real secrets ────────────
  if (!isDev) {
    // ENCRYPTION_KEY: min 32 chars, no known placeholders
    if (!data.ENCRYPTION_KEY || data.ENCRYPTION_KEY.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_KEY'],
        message: 'ENCRYPTION_KEY must be at least 32 characters in non-development mode. Generate with: openssl rand -base64 32',
      });
    } else if (KNOWN_WEAK_SECRETS.has(data.ENCRYPTION_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_KEY'],
        message: 'ENCRYPTION_KEY is a known placeholder — set a real secret. Generate with: openssl rand -base64 32',
      });
    }

    // SESSION_TOKEN_SECRET: required, min 32 chars
    if (!data.SESSION_TOKEN_SECRET || data.SESSION_TOKEN_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_TOKEN_SECRET'],
        message: 'SESSION_TOKEN_SECRET must be at least 32 characters in non-development mode. Generate with: openssl rand -base64 32',
      });
    } else if (KNOWN_WEAK_SECRETS.has(data.SESSION_TOKEN_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_TOKEN_SECRET'],
        message: 'SESSION_TOKEN_SECRET is a known placeholder — set a real secret.',
      });
    }
  }

  // ── ADMIN_API_KEY: required when SDK_AUTH_REQUIRED is on ────
  if (data.SDK_AUTH_REQUIRED === 'true') {
    if (!data.ADMIN_API_KEY || data.ADMIN_API_KEY.length < 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_API_KEY'],
        message: 'ADMIN_API_KEY must be at least 16 characters when SDK_AUTH_REQUIRED=true. Generate with: openssl rand -base64 24',
      });
    }
  }

  // ── EMAIL_PROVIDER: require API keys when using real providers ──
  if (data.EMAIL_DEV_MODE !== 'true') {
    if (data.EMAIL_PROVIDER === 'resend' && !data.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend and EMAIL_DEV_MODE is not true.',
      });
    }
    if (data.EMAIL_PROVIDER === 'postmark' && !data.POSTMARK_API_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['POSTMARK_API_TOKEN'],
        message: 'POSTMARK_API_TOKEN is required when EMAIL_PROVIDER=postmark and EMAIL_DEV_MODE is not true.',
      });
    }
  }

  // ── RECAPTCHA: require keys when enabled ──────────────────
  if (data.RECAPTCHA_ENABLED === 'true') {
    if (!data.RECAPTCHA_SITE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RECAPTCHA_SITE_KEY'],
        message: 'RECAPTCHA_SITE_KEY is required when RECAPTCHA_ENABLED=true.',
      });
    }
    if (!data.RECAPTCHA_SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RECAPTCHA_SECRET_KEY'],
        message: 'RECAPTCHA_SECRET_KEY is required when RECAPTCHA_ENABLED=true.',
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
