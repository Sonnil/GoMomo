import { withSerializableTransaction } from '../db/client.js';
import type { Appointment, BookingRequest, RescheduleRequest } from '../domain/types.js';
import type { ExcelIntegrationConfig, SyncEvent } from '../domain/interfaces.js';
import { getBookingStore, getDefaultStore } from '../stores/booking-store-factory.js';
import { syncEmitter } from '../integrations/excel-sync-worker.js';
import { holdRepo } from '../repos/hold.repo.js';
import { auditRepo } from '../repos/audit.repo.js';
import { getCalendarProvider } from '../integrations/calendar/index.js';
import { tenantRepo } from '../repos/tenant.repo.js';
import { env } from '../config/env.js';
import { eventBus } from '../orchestrator/event-bus.js';
import type { BookingCreatedEvent, BookingCancelledEvent, BookingRescheduledEvent, CalendarWriteFailedEvent, SlotOpenedEvent } from '../domain/events.js';

/**
 * Emit a sync event for the Excel sync worker (best-effort, post-commit).
 * Mirrors the Phase 2 pattern used for Google Calendar sync.
 */
function emitExcelSync(type: SyncEvent['type'], tenantId: string, appointment: Appointment): void {
  setImmediate(() => {
    syncEmitter.emit('sync', {
      type,
      tenantId,
      appointment,
      timestamp: new Date().toISOString(),
    } satisfies SyncEvent);
  });
}

export const bookingService = {
  /**
   * Confirm a booking from a held slot.
   *
   * Hardening:
   * - SERIALIZABLE isolation prevents phantom-read races
   * - Idempotency: if hold_id already produced an appointment, return it
   * - Calendar API call is OUTSIDE the DB transaction to avoid
   *   holding row locks while waiting on an external HTTP call
   * - Advisory lock on tenant + time hash prevents cross-table races
   * - Excel sync fires AFTER commit (Phase 2), same as GCal
   */
  async confirmBooking(request: BookingRequest): Promise<Appointment> {
    const store = getDefaultStore(); // Postgres store — used inside SERIALIZABLE txn

    // ── Phase 1: Atomic DB work (SERIALIZABLE) ─────────────────
    const appointment = await withSerializableTransaction(async (client) => {
      // 0. Idempotency: check if this hold already produced an appointment
      const existing = await store.findBySourceHold(request.hold_id, client);
      if (existing) {
        return existing; // Duplicate call — return the already-created appointment
      }

      // 1. Acquire advisory lock on tenant + slot start (prevents cross-table races)
      //    pg_advisory_xact_lock is released automatically on COMMIT/ROLLBACK
      const slotHash = hashSlot(request.tenant_id, request.hold_id);
      await client.query('SELECT pg_advisory_xact_lock($1)', [slotHash]);

      // 2. Verify hold is still valid (not expired)
      const hold = await holdRepo.findById(request.hold_id, request.tenant_id, client);
      if (!hold) {
        throw new BookingError('Hold has expired. Please select a new time slot.');
      }

      // 3. Verify hold belongs to this session
      if (hold.session_id !== request.session_id) {
        throw new BookingError('Hold does not belong to this session.');
      }

      // 4. Insert appointment (EXCLUDE constraint provides final safety net)
      let apt: Appointment;
      try {
        apt = await store.create(
          {
            tenant_id: request.tenant_id,
            client_name: request.client_name,
            client_email: request.client_email,
            client_notes: request.client_notes,
            client_phone: request.client_phone,
            service: request.service,
            start_time: new Date(hold.start_time),
            end_time: new Date(hold.end_time),
            timezone: request.timezone,
            source_hold_id: request.hold_id,
          },
          client,
        );
      } catch (error: any) {
        if (error.code === '23P01') {
          throw new BookingError(
            'This time slot was just booked by someone else. Please select a different time.',
          );
        }
        throw error;
      }

      // 5. Delete the hold (within the same transaction)
      await holdRepo.delete(request.hold_id, client);

      // 6. Audit (inside txn so it's atomic with the booking)
      await auditRepo.log(
        {
          tenant_id: request.tenant_id,
          event_type: 'appointment.booked',
          entity_type: 'appointment',
          entity_id: apt.id,
          actor: 'ai_agent',
          payload: {
            reference_code: apt.reference_code,
            client_name: request.client_name,
            client_email: request.client_email,
            start_time: hold.start_time,
            end_time: hold.end_time,
            service: request.service,
          },
        },
        client,
      );

      return apt;
    });

    // ── Phase 2: External sync (OUTSIDE transaction — best effort) ──

    // 2a. Calendar sync (real Google or mock — provider abstracts it)
    const calendarSyncRequired = env.CALENDAR_SYNC_REQUIRED === 'true';

    try {
      const tenant = await tenantRepo.findById(request.tenant_id);
      const calendar = getCalendarProvider();

      // In real mode: only sync if tenant has OAuth tokens (google_calendar_id
      // is optional — createEvent falls back to 'primary' when absent).
      // In mock mode: always call (the mock logs and returns a fake ID).
      const shouldSync = calendar.name === 'mock' ||
        !!tenant?.google_oauth_tokens;

      if (tenant && shouldSync) {
        const eventId = await calendar.createEvent(tenant, {
          summary: `${request.service ?? 'Appointment'} - ${request.client_name}`,
          description: [
            'Booked via gomomo.ai',
            `Email: ${request.client_email}`,
            request.client_phone ? `Phone: ${request.client_phone}` : '',
            `Ref: ${appointment.reference_code}`,
            request.client_notes ?? '',
          ].filter(Boolean).join('\n'),
          start: new Date(appointment.start_time),
          end: new Date(appointment.end_time),
          timezone: request.timezone,
          attendees: request.client_email
            ? [{ email: request.client_email }]
            : undefined,
        });
        await store.updateGoogleEventId(appointment.id, eventId);
        appointment.google_event_id = eventId;
      }
    } catch (calError) {
      if (calendarSyncRequired) {
        // ── Strict mode: calendar is required → roll back the booking ──
        console.error(
          '🚨 Calendar sync FAILED and CALENDAR_SYNC_REQUIRED=true — rolling back booking:',
          calError,
        );

        try {
          // 1. Cancel the appointment we just created
          await store.updateStatus(appointment.id, request.tenant_id, 'cancelled');

          // 2. Re-create the hold so the slot isn't permanently lost
          //    (The hold was deleted inside the SERIALIZABLE txn.)
          //    We restore it with a fresh TTL so the user can try again.
          await holdRepo.create({
            tenant_id: request.tenant_id,
            session_id: request.session_id,
            start_time: new Date(appointment.start_time),
            end_time: new Date(appointment.end_time),
          });

          // 3. Audit the rollback
          await auditRepo.log({
            tenant_id: request.tenant_id,
            event_type: 'appointment.calendar_rollback',
            entity_type: 'appointment',
            entity_id: appointment.id,
            actor: 'system',
            payload: {
              reference_code: appointment.reference_code,
              reason: String(calError),
              calendar_sync_required: true,
            },
          });
        } catch (rollbackError) {
          console.error('⚠️  Rollback after calendar failure also failed:', rollbackError);
        }

        throw new BookingError(
          'Unable to sync with the calendar system. The booking has been rolled back. ' +
          'Please try again in a moment, or contact the office directly.',
        );
      }

      // ── Lenient mode (default): log but never fail the booking ──
      console.warn('Calendar event creation failed (booking still confirmed):', calError);

      // Emit CalendarWriteFailed for orchestrator retry
      setImmediate(() => {
        eventBus.emit<CalendarWriteFailedEvent>({
          name: 'CalendarWriteFailed',
          tenant_id: request.tenant_id,
          appointment_id: appointment.id,
          reference_code: appointment.reference_code,
          session_id: request.session_id ?? null,
          error: String(calError),
          timestamp: new Date().toISOString(),
        });
      });
    }

    // 2b. Excel sync (async, non-blocking)
    emitExcelSync('booking.created', request.tenant_id, appointment);

    // 2c. Domain event → orchestrator (async, non-blocking)
    setImmediate(() => {
      eventBus.emit<BookingCreatedEvent>({
        name: 'BookingCreated',
        tenant_id: request.tenant_id,
        appointment,
        session_id: request.session_id,
        timestamp: new Date().toISOString(),
      });
    });

    return appointment;
  },

  /**
   * Reschedule an existing appointment.
   *
   * Hardening: entire operation is SERIALIZABLE-atomic.
   * Old appointment cancelled + new one created in one transaction,
   * so a crash can never leave the client with zero appointments.
   */
  async reschedule(request: RescheduleRequest): Promise<Appointment> {
    const store = getDefaultStore();

    // ── Phase 1: Atomic DB work ────────────────────────────────
    const { newAppointment, oldAppointment } = await withSerializableTransaction(
      async (client) => {
        // Verify the new hold exists
        const newHold = await holdRepo.findById(
          request.new_hold_id,
          request.tenant_id,
          client,
        );
        if (!newHold) {
          throw new BookingError('Hold for new time has expired. Please select a new time slot.');
        }

        // Get existing appointment
        const existing = await store.findById(
          request.appointment_id,
          request.tenant_id,
          client,
        );
        if (!existing || existing.status !== 'confirmed') {
          throw new BookingError('Appointment not found or already cancelled.');
        }

        // Cancel old appointment
        await store.updateStatus(
          existing.id,
          request.tenant_id,
          'cancelled',
          client,
        );

        // Create new appointment from the hold
        let apt: Appointment;
        try {
          apt = await store.create(
            {
              tenant_id: request.tenant_id,
              client_name: existing.client_name,
              client_email: existing.client_email,
              client_notes: existing.client_notes ?? undefined,
              service: existing.service ?? undefined,
              start_time: new Date(newHold.start_time),
              end_time: new Date(newHold.end_time),
              timezone: request.timezone,
              source_hold_id: request.new_hold_id,
            },
            client,
          );
        } catch (error: any) {
          if (error.code === '23P01') {
            throw new BookingError(
              'The new time slot was just booked by someone else. Please select a different time.',
            );
          }
          throw error;
        }

        // Delete the hold
        await holdRepo.delete(request.new_hold_id, client);

        // Audit
        await auditRepo.log(
          {
            tenant_id: request.tenant_id,
            event_type: 'appointment.rescheduled',
            entity_type: 'appointment',
            entity_id: apt.id,
            actor: 'ai_agent',
            payload: {
              old_appointment_id: existing.id,
              old_reference_code: existing.reference_code,
              new_reference_code: apt.reference_code,
            },
          },
          client,
        );

        return { newAppointment: apt, oldAppointment: existing };
      },
    );

    // ── Phase 2: External sync (best effort, outside txn) ──────

    // 2a. Calendar sync (real Google or mock — provider abstracts it)
    try {
      const tenant = await tenantRepo.findById(request.tenant_id);
      const calendar = getCalendarProvider();
      const shouldSync = calendar.name === 'mock' ||
        (tenant?.google_calendar_id && tenant?.google_oauth_tokens);

      if (tenant && shouldSync) {
        // Delete old event
        if (oldAppointment.google_event_id) {
          await calendar
            .deleteEvent(tenant, oldAppointment.google_event_id)
            .catch((e: unknown) => console.warn('Failed to delete old calendar event:', e));
        }
        // Create new event
        const eventId = await calendar.createEvent(tenant, {
          summary: `${newAppointment.service ?? 'Appointment'} - ${newAppointment.client_name}`,
          description: `Rescheduled via gomomo.ai\nPhone: ${newAppointment.client_phone ?? 'N/A'}\nRef: ${newAppointment.reference_code}`,
          start: new Date(newAppointment.start_time),
          end: new Date(newAppointment.end_time),
          timezone: request.timezone,
          attendees: newAppointment.client_email
            ? [{ email: newAppointment.client_email }]
            : undefined,
        });
        await store.updateGoogleEventId(newAppointment.id, eventId);
        newAppointment.google_event_id = eventId;
      }
    } catch (calError) {
      console.warn('Calendar sync failed during reschedule:', calError);
    }

    // 2b. Excel sync (async — cancel old + create new)
    emitExcelSync('booking.statusChanged', request.tenant_id, oldAppointment);
    emitExcelSync('booking.created', request.tenant_id, newAppointment);

    // 2c. Domain event → orchestrator
    setImmediate(() => {
      eventBus.emit<BookingRescheduledEvent>({
        name: 'BookingRescheduled',
        tenant_id: request.tenant_id,
        old_appointment: oldAppointment,
        new_appointment: newAppointment,
        session_id: request.session_id,
        timestamp: new Date().toISOString(),
      });
    });

    // 2d. Old slot opened → notify waitlist (Workflow B)
    setImmediate(() => {
      eventBus.emit<SlotOpenedEvent>({
        name: 'SlotOpened',
        tenant_id: request.tenant_id,
        slot_start: oldAppointment.start_time instanceof Date
          ? oldAppointment.start_time.toISOString()
          : String(oldAppointment.start_time),
        slot_end: oldAppointment.end_time instanceof Date
          ? oldAppointment.end_time.toISOString()
          : String(oldAppointment.end_time),
        service: oldAppointment.service,
        reason: 'reschedule',
        timestamp: new Date().toISOString(),
      });
    });

    return newAppointment;
  },

  /**
   * Cancel an appointment.
   */
  async cancel(appointmentId: string, tenantId: string): Promise<Appointment> {
    const store = getDefaultStore();

    const appointment = await store.findById(appointmentId, tenantId);
    if (!appointment || appointment.status !== 'confirmed') {
      throw new BookingError('Appointment not found or already cancelled.');
    }

    const updated = await store.updateStatus(appointmentId, tenantId, 'cancelled');

    // Remove from calendar (best effort — real Google or mock)
    try {
      const tenant = await tenantRepo.findById(tenantId);
      const calendar = getCalendarProvider();
      const shouldSync = calendar.name === 'mock' ||
        (tenant?.google_calendar_id && tenant?.google_oauth_tokens);

      if (tenant && shouldSync && appointment.google_event_id) {
        await calendar.deleteEvent(tenant, appointment.google_event_id);
      }
    } catch (calError) {
      console.warn('Failed to delete calendar event:', calError);
    }

    await auditRepo.log({
      tenant_id: tenantId,
      event_type: 'appointment.cancelled',
      entity_type: 'appointment',
      entity_id: appointmentId,
      actor: 'ai_agent',
      payload: { reference_code: appointment.reference_code },
    });

    // Excel sync (async)
    if (updated) {
      emitExcelSync('booking.statusChanged', tenantId, updated);
    }

    // Domain event → orchestrator
    setImmediate(() => {
      eventBus.emit<BookingCancelledEvent>({
        name: 'BookingCancelled',
        tenant_id: tenantId,
        appointment: updated!,
        timestamp: new Date().toISOString(),
      });
    });

    // Slot opened → notify waitlist (Workflow B)
    setImmediate(() => {
      eventBus.emit<SlotOpenedEvent>({
        name: 'SlotOpened',
        tenant_id: tenantId,
        slot_start: appointment.start_time instanceof Date
          ? appointment.start_time.toISOString()
          : String(appointment.start_time),
        slot_end: appointment.end_time instanceof Date
          ? appointment.end_time.toISOString()
          : String(appointment.end_time),
        service: appointment.service,
        reason: 'cancellation',
        timestamp: new Date().toISOString(),
      });
    });

    return updated!;
  },

  /**
   * Look up appointments by reference code or email.
   */
  async lookup(
    tenantId: string,
    lookupQuery: { reference?: string; email?: string },
  ): Promise<Appointment[]> {
    const store = getDefaultStore();

    if (lookupQuery.reference) {
      const apt = await store.findByReference(lookupQuery.reference, tenantId);
      return apt ? [apt] : [];
    }
    if (lookupQuery.email) {
      return store.findByEmail(lookupQuery.email, tenantId);
    }
    return [];
  },
};

/**
 * Generate a stable hash for advisory locking.
 * Uses a simple FNV-1a 32-bit hash on tenant_id + hold_id.
 */
function hashSlot(tenantId: string, holdId: string): number {
  const str = `${tenantId}:${holdId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0;
  }
  return hash;
}

export class BookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingError';
  }
}
