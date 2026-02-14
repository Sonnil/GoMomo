// ============================================================
// Domain Events — Autonomous Agent Runtime
//
// Every significant state change emits a typed domain event.
// The Orchestrator subscribes to these and reacts via policies.
// ============================================================

import type { Appointment, AvailabilityHold } from './types.js';

// ── Event Name Union ────────────────────────────────────────

export type DomainEventName =
  | 'BookingCreated'
  | 'BookingCancelled'
  | 'BookingRescheduled'
  | 'HoldCreated'
  | 'HoldExpired'
  | 'CalendarWriteFailed'
  | 'SlotOpened'
  | 'CalendarRetryExhausted'
  | 'FollowupLimitReached'
  | 'FollowupCooldownBlocked';

// ── Event Payloads ──────────────────────────────────────────

export interface BookingCreatedEvent {
  name: 'BookingCreated';
  tenant_id: string;
  appointment: Appointment;
  session_id: string;
  timestamp: string;
}

export interface BookingCancelledEvent {
  name: 'BookingCancelled';
  tenant_id: string;
  appointment: Appointment;
  timestamp: string;
}

export interface BookingRescheduledEvent {
  name: 'BookingRescheduled';
  tenant_id: string;
  old_appointment: Appointment;
  new_appointment: Appointment;
  session_id: string;
  timestamp: string;
}

export interface HoldCreatedEvent {
  name: 'HoldCreated';
  tenant_id: string;
  hold: AvailabilityHold;
  session_id: string;
  timestamp: string;
}

export interface HoldExpiredEvent {
  name: 'HoldExpired';
  tenant_id: string;
  hold_id: string;
  session_id: string;            // enriched — session that placed the hold
  slot_start: string;
  slot_end: string;
  timestamp: string;
}

export interface CalendarWriteFailedEvent {
  name: 'CalendarWriteFailed';
  tenant_id: string;
  appointment_id: string;
  reference_code: string;
  session_id: string | null;     // chat session that triggered the booking (for push delivery)
  error: string;
  timestamp: string;
}

/** Emitted when a slot becomes available (cancellation/reschedule). */
export interface SlotOpenedEvent {
  name: 'SlotOpened';
  tenant_id: string;
  slot_start: string;
  slot_end: string;
  service: string | null;
  reason: 'cancellation' | 'reschedule';
  timestamp: string;
}

/** Emitted when calendar retry exhausts all attempts. */
export interface CalendarRetryExhaustedEvent {
  name: 'CalendarRetryExhausted';
  tenant_id: string;
  appointment_id: string;
  reference_code: string;
  attempts: number;
  last_error: string;
  timestamp: string;
}

/** Emitted when follow-up message limit is reached for a session. */
export interface FollowupLimitReachedEvent {
  name: 'FollowupLimitReached';
  tenant_id: string;
  session_id: string;
  current_count: number;
  max_allowed: number;
  channel: 'email' | 'sms';
  client_email: string;
  timestamp: string;
}

/** Emitted when a follow-up is blocked by cooldown. */
export interface FollowupCooldownBlockedEvent {
  name: 'FollowupCooldownBlocked';
  tenant_id: string;
  session_id: string;
  channel: 'email' | 'sms';
  client_email: string;
  cooldown_minutes: number;
  last_followup_at: string;
  timestamp: string;
}

// ── Discriminated Union ─────────────────────────────────────

export type DomainEvent =
  | BookingCreatedEvent
  | BookingCancelledEvent
  | BookingRescheduledEvent
  | HoldCreatedEvent
  | HoldExpiredEvent
  | CalendarWriteFailedEvent
  | SlotOpenedEvent
  | CalendarRetryExhaustedEvent
  | FollowupLimitReachedEvent
  | FollowupCooldownBlockedEvent;

// ── Helper: map event names to their payload types ──────────

export interface DomainEventMap {
  BookingCreated: BookingCreatedEvent;
  BookingCancelled: BookingCancelledEvent;
  BookingRescheduled: BookingRescheduledEvent;
  HoldCreated: HoldCreatedEvent;
  HoldExpired: HoldExpiredEvent;
  CalendarWriteFailed: CalendarWriteFailedEvent;
  SlotOpened: SlotOpenedEvent;
  CalendarRetryExhausted: CalendarRetryExhaustedEvent;
  FollowupLimitReached: FollowupLimitReachedEvent;
  FollowupCooldownBlocked: FollowupCooldownBlockedEvent;
}
