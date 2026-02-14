// ============================================================
// SMS Metrics — In-Memory Operational Counters (No PII)
//
// Tracks counts of SMS-related events for pilot monitoring.
// All counters are monotonically increasing since process start.
// Reset on restart — no persistence needed for pilot phase.
//
// Thread-safe: single-threaded Node.js — no locks needed.
// ============================================================

export type SmsMetricKey =
  | 'sent'
  | 'failed'
  | 'queued'
  | 'retry_scheduled'
  | 'retry_succeeded'
  | 'retry_aborted'
  | 'blocked_outbound_disabled'
  | 'blocked_retry_disabled'
  | 'blocked_quiet_hours_disabled'
  | 'help'
  | 'stop'
  | 'start'
  | 'booking_web'
  | 'booking_sms'
  | 'confirmation_sent'
  | 'confirmation_failed';

const counters: Record<SmsMetricKey, number> = {
  sent: 0,
  failed: 0,
  queued: 0,
  retry_scheduled: 0,
  retry_succeeded: 0,
  retry_aborted: 0,
  blocked_outbound_disabled: 0,
  blocked_retry_disabled: 0,
  blocked_quiet_hours_disabled: 0,
  help: 0,
  stop: 0,
  start: 0,
  booking_web: 0,
  booking_sms: 0,
  confirmation_sent: 0,
  confirmation_failed: 0,
};

/**
 * Increment a metric counter by 1 (or more).
 */
export function smsMetricInc(key: SmsMetricKey, delta = 1): void {
  counters[key] += delta;
}

/**
 * Get the current value of a single metric.
 */
export function smsMetricGet(key: SmsMetricKey): number {
  return counters[key];
}

/**
 * Get a snapshot of all metrics (safe for JSON serialization).
 */
export function smsMetricsSnapshot(): Readonly<Record<SmsMetricKey, number>> {
  return { ...counters };
}

/**
 * Reset all counters to zero. Used in tests only.
 */
export function smsMetricsReset(): void {
  for (const key of Object.keys(counters) as SmsMetricKey[]) {
    counters[key] = 0;
  }
}
