// ============================================================
// Domain Types — gomomo.ai
// ============================================================

export type ServiceCatalogMode = 'catalog_only' | 'free_text' | 'hybrid';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  slot_duration: number;
  business_hours: BusinessHours;
  services: Service[];
  service_description: string;
  service_catalog_mode: ServiceCatalogMode; // default 'catalog_only'
  google_calendar_id: string | null;
  google_oauth_tokens: GoogleOAuthTokens | null;
  excel_integration: Record<string, unknown> | null;
  quiet_hours_start: string; // HH:mm — default '21:00'
  quiet_hours_end: string;   // HH:mm — default '08:00'
  sms_outbound_enabled: boolean;       // kill switch — default true
  sms_retry_enabled: boolean;          // kill switch — default true
  sms_quiet_hours_enabled: boolean;    // kill switch — default true
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BusinessHours {
  monday: DayHours | null;
  tuesday: DayHours | null;
  wednesday: DayHours | null;
  thursday: DayHours | null;
  friday: DayHours | null;
  saturday: DayHours | null;
  sunday: DayHours | null;
}

export interface DayHours {
  start: string; // HH:mm
  end: string;   // HH:mm
}

export interface Service {
  name: string;
  duration: number; // minutes
  description?: string;
}

export interface GoogleOAuthTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

export interface Appointment {
  id: string;
  tenant_id: string;
  reference_code: string;
  client_name: string;
  client_email: string;
  client_phone: string | null;
  client_notes: string | null;
  service: string | null;
  start_time: Date;
  end_time: Date;
  timezone: string;
  status: AppointmentStatus;
  google_event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export type AppointmentStatus = 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export interface AvailabilityHold {
  id: string;
  tenant_id: string;
  session_id: string;
  start_time: Date;
  end_time: Date;
  expires_at: Date;
  created_at: Date;
}

export interface ChatSession {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  channel: 'web' | 'sms' | 'voice';
  conversation: ConversationMessage[];
  metadata: Record<string, unknown>;
  email_verified: boolean;
  message_count: number;
  /** Messages that passed the email gate and were actually processed. */
  user_message_count: number;
  /** Successful bookings confirmed in this session. */
  booking_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  timestamp: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AuditEntry {
  id?: number;
  tenant_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  actor: string;
  payload: Record<string, unknown> | null;
  created_at?: Date;
}

export interface TimeSlot {
  start: string; // ISO-8601
  end: string;   // ISO-8601
  available: boolean;
}

/**
 * Result from the availability engine.
 * `verified` is true when external calendar busy times were successfully
 * cross-referenced. When false, slots are derived from DB only and may
 * not reflect personal calendar events.
 */
export interface AvailabilityResult {
  slots: TimeSlot[];
  verified: boolean;
  calendarSource?: 'google' | 'db_only';
  calendarError?: string;
}

export interface BookingRequest {
  tenant_id: string;
  session_id: string;
  hold_id: string;
  client_name: string;
  client_email: string;
  client_notes?: string;
  client_phone?: string;
  service?: string;
  timezone: string;
}

export interface RescheduleRequest {
  appointment_id: string;
  tenant_id: string;
  session_id: string;
  new_hold_id: string;
  timezone: string;
}

// ============================================================
// Autonomous Agent Runtime Types
// ============================================================

export type PolicyEffect = 'allow' | 'deny';

export interface PolicyRule {
  id: string;
  tenant_id: string | null;
  action: string;
  effect: PolicyEffect;
  conditions: Record<string, unknown>;
  priority: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  rule_id: string | null;       // null when default-deny (no matching rule)
  action: string;
  reason: string;
  evaluated_at: string;         // ISO-8601
}

export type JobStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  tenant_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  run_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  source_event: string | null;
  created_at: Date;
}

export type NotificationChannel = 'email' | 'sms' | 'webhook';
export type NotificationStatus = 'pending' | 'sent' | 'failed';

export interface NotificationOutbox {
  id: string;
  tenant_id: string;
  job_id: string | null;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  body: string;
  status: NotificationStatus;
  sent_at: Date | null;
  error: string | null;
  created_at: Date;
}

// ============================================================
// Waitlist Types (Phase 27)
// ============================================================

export type WaitlistStatus = 'waiting' | 'notified' | 'booked' | 'expired' | 'cancelled';

export interface WaitlistEntry {
  id: string;
  tenant_id: string;
  session_id: string | null;
  client_name: string;
  client_email: string;
  preferred_service: string | null;
  preferred_days: string[];             // e.g. ["monday","wednesday"]
  preferred_time_range: { start?: string; end?: string } | null;
  status: WaitlistStatus;
  notified_at: Date | null;
  matched_slot: { start: string; end: string } | null;
  created_at: Date;
  updated_at: Date;
}

// ============================================================
// Voice Channel Types
// ============================================================

export type VoiceCallState =
  | 'greeting'
  | 'collecting_intent'
  | 'collecting_service'
  | 'collecting_date'
  | 'offering_slots'
  | 'collecting_slot_choice'
  | 'collecting_name'
  | 'collecting_email'
  | 'confirming_booking'
  | 'collecting_reference'
  | 'collecting_reschedule_date'
  | 'offering_reschedule_slots'
  | 'confirming_reschedule'
  | 'confirming_cancel'
  | 'completed'
  | 'error';

export type VoiceIntent = 'book' | 'reschedule' | 'cancel' | 'unknown';

export interface VoiceSession {
  callSid: string;
  tenantId: string;
  sessionId: string;         // Maps to chat_sessions.id
  state: VoiceCallState;
  intent: VoiceIntent;
  retries: number;           // Consecutive misunderstandings
  turnCount: number;
  startedAt: number;         // Date.now()
  lastPrompt: string;
  callerPhone: string | null; // Caller's phone number (E.164) for SMS handoff
  // Collected booking fields
  service: string | null;
  date: string | null;       // ISO date e.g. "2026-02-10"
  selectedSlot: { start: string; end: string } | null;
  holdId: string | null;
  clientName: string | null;
  clientEmail: string | null;
  clientNotes: string | null;
  bookingId: string | null;
  referenceCode: string | null;
  // For reschedule/cancel
  appointmentId: string | null;
  lookupResults: Array<{
    appointment_id: string;
    reference_code: string;
    service: string | null;
    start_time: string;
    status: string;
  }>;
  // Available slots cache
  availableSlots: Array<{ start: string; end: string; display_time: string }>;
}

// ============================================================
// Customer Identity Types
// ============================================================

/**
 * Known identity fields for the current session's linked customer.
 * Returned by sessionRepo.getCustomerIdentity() and passed into the system
 * prompt so the agent knows what information is already on file.
 */
export interface CustomerIdentity {
  verifiedEmail: string | null;
  displayName: string | null;
  phone: string | null;         // E.164 format when present
}

export interface CustomerPreferences {
  timezone?: string;
  preferred_service?: string;
  practitioner_preference?: string;
  contact_preference?: 'email' | 'sms' | 'either';
}

export interface Customer {
  id: string;
  tenant_id: string;
  phone: string | null;         // E.164 format
  email: string | null;         // lowercase
  display_name: string | null;
  preferences: CustomerPreferences;
  booking_count: number;
  newsletter_opt_in: boolean;   // default true; user can opt out
  email_verified_at: Date | null;
  last_seen_at: Date;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Context injected into the system prompt for returning customers. */
export interface ReturningCustomerContext {
  customer_id: string;
  display_name: string | null;
  booking_count: number;
  preferences: CustomerPreferences;
  previous_sessions: number;
}

// ============================================================
// Push Events — Proactive UI Notifications (Feature 3)
// ============================================================

/** Types of proactive push notifications delivered to the chat UI. */
export type PushEventType = 'waitlist_match' | 'calendar_retry_success';

/** A slot offered in a waitlist-match push. */
export interface PushSlot {
  start: string;       // ISO datetime
  end: string;         // ISO datetime
  display_time: string; // human-readable e.g. "Tue Feb 10, 2:00 PM – 3:00 PM"
  service: string | null;
}

/** Payload for a waitlist_match push event. */
export interface WaitlistMatchPushPayload {
  type: 'waitlist_match';
  slots: PushSlot[];
  service: string | null;
  message: string;       // pre-formatted message text
}

/** Payload for a calendar_retry_success push event. */
export interface CalendarRetrySuccessPushPayload {
  type: 'calendar_retry_success';
  reference_code: string;
  service: string | null;
  start_time: string;    // ISO datetime
  end_time: string;      // ISO datetime
  display_time: string;  // human-readable
  message: string;       // pre-formatted message text
}

export type PushEventPayload = WaitlistMatchPushPayload | CalendarRetrySuccessPushPayload;

/** A stored push event (DB row). */
export interface PushEvent {
  id: string;
  tenant_id: string;
  session_id: string;
  type: PushEventType;
  payload: PushEventPayload;
  delivered: boolean;
  created_at: Date;
}
