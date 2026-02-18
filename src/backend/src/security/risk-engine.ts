/**
 * Deterministic Behavioral Risk Engine
 *
 * Replaces the hard 1-per-hour booking rate limit with a scored
 * risk assessment.  No ML — pure threshold logic.
 *
 * Usage:
 *   const score   = calculateRiskScore(context);
 *   const decision = getRiskDecision(score);
 *   // decision.action  → "allow" | "reverify" | "cooldown"
 */

// ─── Types ───────────────────────────────────────────────

export interface RiskContext {
  /** Client email for the current action */
  email: string;
  /** Client IP address (from request) */
  ip?: string;
  /** Number of OTP verification attempts in the last 10 minutes */
  otpAttemptsLast10Min: number;
  /** Number of bookings created by this email in the last 5 minutes */
  bookingsLast5Min: number;
  /** Distinct emails that booked from the same IP in the last hour */
  sameIpDifferentEmailsLastHour: number;
  /** Whether the email already has an active (future, non-cancelled) booking */
  existingActiveBooking: boolean;
  /** Total number of active (future, non-cancelled) bookings for this email */
  activeBookingCount: number;
  /** Messages sent in the current session within a short burst window */
  rapidMessageCount: number;
}

export type RiskAction = 'allow' | 'reverify' | 'cooldown';

export interface RiskDecision {
  action: RiskAction;
  score: number;
  /** Human-readable reason (for audit logging) */
  reason: string;
  /** Cooldown seconds — only set when action === 'cooldown' */
  cooldownSeconds?: number;
}

// ─── Scoring weights ────────────────────────────────────

const WEIGHTS = {
  /** Each OTP attempt in the last 10 min */
  OTP_ATTEMPT: 10,
  /** Each booking in the last 5 min (stacking rapidly is suspicious) */
  RECENT_BOOKING: 25,
  /** Each *different* email from the same IP in the last hour */
  IP_EMAIL_DIVERSITY: 15,
  /** Existing active booking boolean — no longer penalised (see activeBookingCount tiers) */
  EXISTING_BOOKING: 0,
  /** Rapid-fire messages in the session (>10 in burst) */
  RAPID_MESSAGES: 5,
} as const;

/**
 * Tiered scoring for activeBookingCount:
 *   0   →  0 (no impact)
 *   1   → -10 (trusted returning customer)
 *   2-3 → +10 (moderate, possibly rescheduling)
 *   ≥4  → +30 (suspicious accumulation)
 */
function activeBookingTierScore(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return -10;
  if (count <= 3) return 10;
  return 30;
}

// ─── Thresholds ─────────────────────────────────────────

const THRESHOLDS = {
  /** ≤ this → allow */
  ALLOW_MAX: 30,
  /** ≤ this → reverify  (above ALLOW_MAX) */
  REVERIFY_MAX: 80,
  /** > REVERIFY_MAX → cooldown */
} as const;

/** Default cooldown when score exceeds REVERIFY_MAX */
const DEFAULT_COOLDOWN_SECONDS = 300; // 5 minutes

// ─── Public API ─────────────────────────────────────────

/**
 * Calculate a deterministic risk score from the given context.
 * Returns 0–100+ (uncapped, but decisions clamp at thresholds).
 */
export function calculateRiskScore(ctx: RiskContext): number {
  let score = 0;

  score += ctx.otpAttemptsLast10Min * WEIGHTS.OTP_ATTEMPT;
  score += ctx.bookingsLast5Min * WEIGHTS.RECENT_BOOKING;
  score += Math.max(0, ctx.sameIpDifferentEmailsLastHour - 1) * WEIGHTS.IP_EMAIL_DIVERSITY;
  if (ctx.existingActiveBooking) score += WEIGHTS.EXISTING_BOOKING;
  score += activeBookingTierScore(ctx.activeBookingCount);
  score += Math.max(0, ctx.rapidMessageCount - 10) * WEIGHTS.RAPID_MESSAGES;

  return score;
}

/**
 * Map a numeric score to an actionable decision.
 */
export function getRiskDecision(score: number): RiskDecision {
  if (score <= THRESHOLDS.ALLOW_MAX) {
    return {
      action: 'allow',
      score,
      reason: `Score ${score} ≤ ${THRESHOLDS.ALLOW_MAX}: no risk detected.`,
    };
  }

  if (score <= THRESHOLDS.REVERIFY_MAX) {
    return {
      action: 'reverify',
      score,
      reason: `Score ${score} (${THRESHOLDS.ALLOW_MAX + 1}–${THRESHOLDS.REVERIFY_MAX}): elevated risk — re-verification required.`,
    };
  }

  return {
    action: 'cooldown',
    score,
    reason: `Score ${score} > ${THRESHOLDS.REVERIFY_MAX}: high risk — temporary cooldown enforced.`,
    cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
  };
}

// ─── Exports for testing ────────────────────────────────

/** Exported for unit-test access to tier function. */
export { activeBookingTierScore };

// ─── Helpers for gathering context from DB ──────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Build a RiskContext by querying the database.
 * Callers can override individual fields (e.g. when some data is already known).
 */
export async function buildRiskContext(
  deps: { query: QueryFn },
  params: {
    email: string;
    tenantId: string;
    ip?: string;
    sessionId?: string;
  },
  overrides?: Partial<RiskContext>,
): Promise<RiskContext> {
  const { query } = deps;
  const { email, tenantId, ip } = params;

  // ── OTP attempts in last 10 minutes ──
  const otpResult = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM email_verifications
     WHERE email = $1
       AND tenant_id = $2
       AND created_at > NOW() - INTERVAL '10 minutes'`,
    [email, tenantId],
  );
  const otpAttemptsLast10Min = otpResult.rows[0]?.cnt ?? 0;

  // ── Bookings in last 5 minutes ──
  const bookingsResult = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM appointments
     WHERE client_email = $1
       AND tenant_id = $2
       AND status != 'cancelled'
       AND created_at > NOW() - INTERVAL '5 minutes'`,
    [email, tenantId],
  );
  const bookingsLast5Min = bookingsResult.rows[0]?.cnt ?? 0;

  // ── Same IP, different emails in last hour ──
  let sameIpDifferentEmailsLastHour = 0;
  if (ip) {
    const ipResult = await query(
      `SELECT COUNT(DISTINCT client_email)::int AS cnt
       FROM appointments
       WHERE tenant_id = $1
         AND status != 'cancelled'
         AND created_at > NOW() - INTERVAL '1 hour'
         AND session_id IN (
           SELECT session_id FROM chat_sessions WHERE ip_address = $2
         )`,
      [tenantId, ip],
    );
    sameIpDifferentEmailsLastHour = ipResult.rows[0]?.cnt ?? 0;
  }

  // ── Existing active (future) booking ──
  const activeResult = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM appointments
     WHERE client_email = $1
       AND tenant_id = $2
       AND status NOT IN ('cancelled', 'no_show')
       AND start_time > NOW()`,
    [email, tenantId],
  );
  const activeBookingCount: number = activeResult.rows[0]?.cnt ?? 0;
  const existingActiveBooking = activeBookingCount > 0;

  // ── Rapid message count (session burst) — defaults to 0 if no session ──
  let rapidMessageCount = 0;
  if (params.sessionId) {
    const msgResult = await query(
      `SELECT COUNT(*)::int AS cnt
       FROM chat_messages
       WHERE session_id = $1
         AND role = 'user'
         AND created_at > NOW() - INTERVAL '2 minutes'`,
      [params.sessionId],
    );
    rapidMessageCount = msgResult.rows[0]?.cnt ?? 0;
  }

  return {
    email,
    ip,
    otpAttemptsLast10Min,
    bookingsLast5Min,
    sameIpDifferentEmailsLastHour,
    existingActiveBooking,
    activeBookingCount,
    rapidMessageCount,
    ...overrides,
  };
}

/**
 * Query whether the email has any active future bookings.
 * Returns the list so callers can present a summary.
 */
export async function getExistingActiveBookings(
  deps: { query: QueryFn },
  email: string,
  tenantId: string,
): Promise<{ id: string; reference_code: string; start_time: string; service: string | null }[]> {
  const result = await deps.query(
    `SELECT id, reference_code, start_time, service
     FROM appointments
     WHERE client_email = $1
       AND tenant_id = $2
       AND status NOT IN ('cancelled', 'no_show')
       AND start_time > NOW()
     ORDER BY start_time ASC`,
    [email, tenantId],
  );
  return result.rows;
}
