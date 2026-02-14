/**
 * SMS Sender — Send SMS via Twilio REST API
 *
 * Uses Twilio's Messages API directly via fetch() — no twilio SDK needed.
 * Includes DB-backed per-phone rate limiting and opt-out compliance.
 *
 * DESIGN DECISIONS:
 * - Direct REST API call (no SDK) — consistent with our TwiML approach
 * - Rate limit: DB-backed (survives restarts), max N SMS per phone per window
 * - Opt-out check: blocks sends to phones that texted STOP
 * - Basic E.164 validation before sending
 * - Returns structured result for caller error handling
 */

import * as https from 'node:https';
import { env } from '../config/env.js';
import { smsOptOutRepo } from '../repos/sms-opt-out.repo.js';
import { smsRateLimitRepo } from '../repos/sms-rate-limit.repo.js';

// ── Validation ──────────────────────────────────────────────────

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}

// ── Twilio Credential Verification ──────────────────────────

export interface TwilioVerifyResult {
  /** Whether the API call succeeded and credentials are valid */
  verified: boolean;
  /** Account status reported by Twilio (e.g. 'active', 'suspended') */
  accountStatus?: string;
  /** Whether the account is a live (not test) account */
  isLive?: boolean;
  /** Human-readable credential mode: 'live' | 'test' | 'simulator' | 'invalid' */
  credentialMode: 'live' | 'test' | 'simulator' | 'invalid';
  /** Send mode: how outbound SMS will be sent */
  sendMode?: 'messaging_service_sid' | 'from_number';
  /** Friendly name of the Twilio account (truncated, no secrets) */
  friendlyName?: string;
  /** Sender type classification: local_10dlc | toll_free | short_code | unknown */
  senderType: 'local_10dlc' | 'toll_free' | 'short_code' | 'unknown';
  /** A2P 10DLC registration status (from env config) */
  a2pStatus: 'pending' | 'approved' | 'rejected' | 'unknown';
  /** Error message if verification failed */
  error?: string;
}

// ── Toll-Free Detection ─────────────────────────────────────

/**
 * North American toll-free prefixes (8xx).
 * Toll-free numbers require separate verification since Jan 31 2024
 * and are NOT suitable as 10DLC senders.
 */
const TOLL_FREE_PREFIXES = ['+1800', '+1833', '+1844', '+1855', '+1866', '+1877', '+1888'];

export function isTollFreeNumber(phone: string): boolean {
  return TOLL_FREE_PREFIXES.some(prefix => phone.startsWith(prefix));
}

/**
 * Detect sender type from phone number and env config.
 * Priority: explicit env setting > auto-detection from number pattern.
 */
export function detectSenderType(phone: string, envSenderType: string): 'local_10dlc' | 'toll_free' | 'short_code' | 'unknown' {
  // Trust explicit env setting when it's not 'unknown'
  if (envSenderType && envSenderType !== 'unknown') {
    return envSenderType as 'local_10dlc' | 'toll_free' | 'short_code';
  }
  // Auto-detect from number
  if (phone && isTollFreeNumber(phone)) return 'toll_free';
  if (phone && phone.length <= 7 && phone.startsWith('+')) return 'short_code';
  if (phone && phone.startsWith('+1') && phone.length === 12) return 'local_10dlc';
  return 'unknown';
}

/**
 * Verify Twilio credentials by calling the Account API.
 * Lightweight GET — no SMS sent, no charges incurred.
 * Returns credential mode + account status without logging secrets.
 */
export async function verifyTwilioCredentials(): Promise<TwilioVerifyResult> {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const fromNumber = env.TWILIO_PHONE_NUMBER;
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;

  // No credentials at all → simulator mode
  if (!accountSid && !authToken && !fromNumber && !messagingServiceSid) {
    return { verified: false, credentialMode: 'simulator', senderType: 'unknown', a2pStatus: 'unknown' };
  }

  // Partial credentials → invalid
  if (!accountSid || !authToken) {
    return {
      verified: false,
      credentialMode: 'invalid',
      senderType: detectSenderType(fromNumber, env.TWILIO_SENDER_TYPE),
      a2pStatus: env.TWILIO_A2P_STATUS as TwilioVerifyResult['a2pStatus'],
      error: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are both required',
    };
  }

  if (!fromNumber && !messagingServiceSid) {
    return {
      verified: false,
      credentialMode: 'invalid',
      senderType: 'unknown',
      a2pStatus: env.TWILIO_A2P_STATUS as TwilioVerifyResult['a2pStatus'],
      error: 'Either TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID is required',
    };
  }

  const sendMode: 'messaging_service_sid' | 'from_number' = messagingServiceSid
    ? 'messaging_service_sid'
    : 'from_number';

  // Call Twilio Account API to verify credentials.
  // Uses Node https module (not fetch) to handle corporate proxy TLS interception.
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`;
  try {
    const data = await twilioHttpsGet(url, accountSid, authToken);

    const status = (data.status as string) ?? 'unknown';
    const friendlyName = typeof data.friendly_name === 'string'
      ? data.friendly_name.slice(0, 50)
      : undefined;

    // Twilio test accounts have SIDs starting with 'AC' + status 'active' but
    // their type is 'Trial'. Check the 'type' field.
    const accountType = (data.type as string) ?? '';
    const isLive = accountType.toLowerCase() !== 'trial';
    const credentialMode: 'live' | 'test' = isLive ? 'live' : 'test';

    const senderType = detectSenderType(fromNumber, env.TWILIO_SENDER_TYPE);
    const a2pStatus = env.TWILIO_A2P_STATUS as TwilioVerifyResult['a2pStatus'];

    // ── Advisory warnings (non-blocking) ──────────────────────
    if (senderType === 'toll_free') {
      console.warn(`⚠️  Sender number ${fromNumber.slice(0, 6)}… is TOLL-FREE — requires separate verification since 2024-01-31. Consider switching to a local 10DLC number.`);
    }
    if (a2pStatus === 'pending') {
      console.warn(`⚠️  A2P 10DLC registration is PENDING — carrier filtering may block or delay messages until approved.`);
    }

    return {
      verified: true,
      accountStatus: status,
      isLive,
      credentialMode,
      sendMode,
      friendlyName,
      senderType,
      a2pStatus,
    };
  } catch (err: any) {
    // Distinguish auth failure from network/TLS issues
    const errMsg = err.message ?? String(err);
    const isTls = errMsg.includes('self-signed') || errMsg.includes('certificate') || errMsg.includes('CERT');
    return {
      verified: false,
      credentialMode: 'invalid',
      sendMode,
      senderType: detectSenderType(fromNumber, env.TWILIO_SENDER_TYPE),
      a2pStatus: env.TWILIO_A2P_STATUS as TwilioVerifyResult['a2pStatus'],
      error: isTls
        ? `TLS certificate error (corporate proxy?): ${errMsg}. SMS sending may also fail — consider setting NODE_EXTRA_CA_CERTS.`
        : `Twilio verification failed: ${errMsg}`,
    };
  }
}

/**
 * Lightweight HTTPS GET using Node's https module.
 * Tolerates self-signed certs (e.g. corporate proxy) since this is a
 * non-sensitive read-only account check — NOT used for sending SMS.
 *
 * Exported so debug/diagnostic routes can poll Twilio Messages API
 * when StatusCallback webhooks are unreachable (e.g. no public tunnel).
 */
export function twilioHttpsGet(url: string, accountSid: string, authToken: string): Promise<Record<string, unknown>> {
  const parsed = new globalThis.URL(url);

  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname,
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        },
        rejectUnauthorized: false, // tolerate corporate proxy TLS interception for this diagnostic-only call
        timeout: 10_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`Twilio auth failed: HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch {
            reject(new Error(`Invalid JSON from Twilio API`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Twilio API timeout (10s)')); });
  });
}

/**
 * HTTPS POST using Node's https module for sending SMS.
 * Tolerates self-signed certs (corporate proxy) — same as twilioHttpsGet.
 * Returns parsed JSON with `_statusCode` added for caller to check.
 */
function twilioHttpsPost(
  url: string,
  body: string,
  accountSid: string,
  authToken: string,
): Promise<Record<string, unknown> & { _statusCode?: number }> {
  const parsed = new globalThis.URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        path: parsed.pathname,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        },
        rejectUnauthorized: false, // tolerate corporate proxy TLS interception
        timeout: 15_000,
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk: string) => { responseBody += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(responseBody) as Record<string, unknown>;
            data._statusCode = res.statusCode;
            resolve(data);
          } catch {
            reject(new Error(`Invalid JSON from Twilio API (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Twilio SMS send timeout (15s)')); });
    req.write(body);
    req.end();
  });
}

// ── Module-level verification state ─────────────────────────
// Set once at startup by index.ts, read by /health/sms and tool-executor

let _twilioVerifyResult: TwilioVerifyResult | null = null;

export function setTwilioVerifyResult(result: TwilioVerifyResult): void {
  _twilioVerifyResult = result;
}

export function getTwilioVerifyResult(): TwilioVerifyResult | null {
  return _twilioVerifyResult;
}

// ── SMS Sending ─────────────────────────────────────────────────

export interface SmsSendResult {
  success: boolean;
  messageSid?: string;
  error?: string;
  /** Twilio numeric error code (e.g. 21211, 30006) — no PII */
  twilioErrorCode?: number;
  rateLimited?: boolean;
  optedOut?: boolean;
  /** Whether this was handled by the simulator (no real Twilio) */
  simulated?: boolean;
}

/**
 * Send an SMS message via Twilio REST API.
 *
 * @param to        - Recipient phone number (E.164 format)
 * @param body      - Message text (max 1600 chars for Twilio)
 * @param tenantId  - Optional tenant ID for opt-out + rate limit context
 * @returns         - Result with success flag and optional SID/error
 */
export async function sendSms(to: string, body: string, tenantId?: string | null): Promise<SmsSendResult> {
  // ── Master kill switch: FEATURE_SMS ───────────────────────
  if (env.FEATURE_SMS === 'false') {
    return { success: false, error: 'SMS feature disabled (FEATURE_SMS=false)' };
  }

  // Validate phone number
  if (!isValidE164(to)) {
    return { success: false, error: `Invalid phone number format: ${to}. Expected E.164 (e.g., +15551234567)` };
  }

  // ── Opt-out check — block sends to phones that texted STOP ──
  try {
    const optedOut = await smsOptOutRepo.isOptedOut(to, tenantId ?? null);
    if (optedOut) {
      console.log(`[sms] Blocked send to opted-out phone ${to}`);
      return { success: false, error: 'Recipient has opted out of SMS messages.', optedOut: true };
    }
  } catch (err) {
    // If opt-out check fails (e.g. DB not ready), log but proceed
    // to avoid blocking handoff SMS during startup
    console.warn('[sms] Opt-out check failed, proceeding:', err);
  }

  // Check Twilio credentials
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const fromNumber = env.TWILIO_PHONE_NUMBER;
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) {
    // ── SMS SIMULATOR MODE ──────────────────────────────────
    // When Twilio is not configured, log the message to console
    // and return success so autonomy jobs and handoff flows can
    // proceed during demos without real SMS delivery.
    console.log(`[sms-simulator] 📱 Would send SMS to ${to}:`);
    console.log(`[sms-simulator]    "${body.substring(0, 120)}${body.length > 120 ? '…' : ''}"`);
    console.log(`[sms-simulator]    (Twilio not configured — message logged only)`);
    return {
      success: true,
      messageSid: `SIM_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      simulated: true,
    };
  }

  // ── DB-backed rate limit check ────────────────────────────
  try {
    const rl = await smsRateLimitRepo.check(to);
    if (!rl.allowed) {
      console.warn(`[sms] Rate limit exceeded for ${to}`);
      return {
        success: false,
        error: 'Too many SMS sent to this number. Please try again later.',
        rateLimited: true,
      };
    }
  } catch (err) {
    // If rate limit check fails (e.g. DB not ready), log but proceed
    console.warn('[sms] Rate limit check failed, proceeding:', err);
  }

  // Truncate message if needed (Twilio max is 1600 chars)
  const truncatedBody = body.length > 1500
    ? body.substring(0, 1497) + '...'
    : body;

  // ── Sender type advisory checks (non-blocking) ───────────
  if (isTollFreeNumber(fromNumber)) {
    console.warn(`[sms] ⚠️  Sending from toll-free number ${fromNumber.slice(0, 6)}… — may be blocked if unverified`);
  }
  if (env.TWILIO_A2P_STATUS === 'pending') {
    console.warn(`[sms] ⚠️  A2P 10DLC registration pending — carrier filtering may block/delay this message`);
  }

  // Send via Twilio REST API
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  // Prefer MessagingServiceSid (better deliverability, A2P compliance),
  // fall back to direct From number.
  const formParams: Record<string, string> = {
    To: to,
    Body: truncatedBody,
  };
  if (messagingServiceSid) {
    formParams.MessagingServiceSid = messagingServiceSid;
  } else {
    formParams.From = fromNumber;
  }

  // Attach StatusCallback URL so Twilio POSTs delivery status updates
  // (sent/delivered/undelivered/failed) — enables diagnostics without
  // manual Twilio console checks.
  const statusCallbackUrl = env.SMS_STATUS_CALLBACK_URL;
  if (statusCallbackUrl) {
    formParams.StatusCallback = statusCallbackUrl;
  }

  const formData = new URLSearchParams(formParams);

  try {
    const data = await twilioHttpsPost(url, formData.toString(), accountSid, authToken);

    if (data._statusCode && data._statusCode >= 400) {
      console.error(`[sms] Twilio error:`, data);
      return {
        success: false,
        error: `Twilio error: ${data.message ?? `HTTP ${data._statusCode}`}`,
        twilioErrorCode: typeof data.code === 'number' ? data.code : undefined,
      };
    }

    console.log(`[sms] Sent to ${to} — SID: ${data.sid}`);

    // Record send event for DB-backed rate limiting
    try {
      await smsRateLimitRepo.record(to, tenantId ?? null);
    } catch { /* best-effort */ }

    return { success: true, messageSid: data.sid as string };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[sms] Network error:`, errMsg);
    return {
      success: false,
      error: `Failed to send SMS: ${errMsg}`,
    };
  }
}

/**
 * Send an SMS handoff link to the caller.
 * Builds the message with the web chat URL + token.
 */
export async function sendHandoffSms(
  to: string,
  tenantName: string,
  webChatUrl: string,
): Promise<SmsSendResult> {
  const body =
    `${tenantName}: Continue your appointment booking online! ` +
    `Tap to open: ${webChatUrl}\n\n` +
    `This link expires in 15 minutes and can only be used once.`;

  return sendSms(to, body);
}

/**
 * Get rate limit stats for a phone number (debug — DB-backed).
 */
export async function getRateLimitInfo(phone: string): Promise<{ allowed: boolean; remaining: number; count: number } | null> {
  try {
    return await smsRateLimitRepo.check(phone);
  } catch {
    return null;
  }
}
