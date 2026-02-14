// ============================================================
// Appointment Reminder Repository
//
// Tracks scheduled SMS/email reminder jobs linked to
// appointments. Allows cancelling reminder jobs when an
// appointment is cancelled or rescheduled.
// ============================================================

import { query } from '../db/client.js';

export interface AppointmentReminder {
  id: string;
  appointment_id: string;
  tenant_id: string;
  job_id: string;
  reminder_type: string;
  phone: string | null;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  scheduled_at: Date;
  created_at: Date;
}

export const appointmentReminderRepo = {
  /**
   * Create a new reminder tracking record.
   */
  async create(data: {
    appointment_id: string;
    tenant_id: string;
    job_id: string;
    reminder_type: string;
    phone?: string | null;
    scheduled_at: Date;
  }): Promise<AppointmentReminder> {
    const { rows } = await query<AppointmentReminder>(
      `INSERT INTO appointment_reminders
         (appointment_id, tenant_id, job_id, reminder_type, phone, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.appointment_id,
        data.tenant_id,
        data.job_id,
        data.reminder_type,
        data.phone ?? null,
        data.scheduled_at.toISOString(),
      ],
    );
    return rows[0];
  },

  /**
   * Find all pending reminders for an appointment.
   */
  async findPendingByAppointment(appointmentId: string): Promise<AppointmentReminder[]> {
    const { rows } = await query<AppointmentReminder>(
      `SELECT * FROM appointment_reminders
       WHERE appointment_id = $1 AND status = 'pending'`,
      [appointmentId],
    );
    return rows;
  },

  /**
   * Cancel all pending reminders for an appointment.
   * Also cancels the linked jobs in the job queue.
   * Returns the number of reminders cancelled.
   */
  async cancelByAppointment(appointmentId: string): Promise<number> {
    // 1. Find pending reminders
    const pending = await this.findPendingByAppointment(appointmentId);
    if (pending.length === 0) return 0;

    // 2. Cancel the linked jobs
    const { jobRepo } = await import('./job.repo.js');
    for (const reminder of pending) {
      await jobRepo.cancel(reminder.job_id);
    }

    // 3. Mark reminders as cancelled
    const { rowCount } = await query(
      `UPDATE appointment_reminders
       SET status = 'cancelled'
       WHERE appointment_id = $1 AND status = 'pending'`,
      [appointmentId],
    );
    return rowCount ?? 0;
  },

  /**
   * Mark a reminder as sent (called by the job executor after successful delivery).
   */
  async markSent(jobId: string): Promise<void> {
    await query(
      `UPDATE appointment_reminders SET status = 'sent' WHERE job_id = $1`,
      [jobId],
    );
  },

  /**
   * Mark a reminder as cancelled (e.g. appointment no longer confirmed, or opted out).
   */
  async markCancelled(jobId: string): Promise<void> {
    await query(
      `UPDATE appointment_reminders SET status = 'cancelled' WHERE job_id = $1`,
      [jobId],
    );
  },

  /**
   * Mark a reminder as failed.
   */
  async markFailed(jobId: string): Promise<void> {
    await query(
      `UPDATE appointment_reminders SET status = 'failed' WHERE job_id = $1`,
      [jobId],
    );
  },
};
