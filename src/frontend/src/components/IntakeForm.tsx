import React, { useState, useCallback } from 'react';
import { useRecaptcha } from '../hooks/useRecaptcha';

/* ── Validation ──────────────────────────────────────────── */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  service?: string;
  duration?: string;
  name?: string;
  email?: string;
  phone?: string;
}

function validate(fields: {
  service: string;
  duration: number;
  name: string;
  email: string;
  phone: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  if (!fields.service.trim()) errors.service = 'Please describe the service you need';
  if (!Number.isFinite(fields.duration) || fields.duration < 5) errors.duration = 'Minimum 5 minutes';
  else if (fields.duration > 240) errors.duration = 'Maximum 240 minutes';
  if (!fields.name.trim()) errors.name = 'Name is required';
  if (!fields.email.trim()) errors.email = 'Email is required';
  else if (!EMAIL_RE.test(fields.email.trim())) errors.email = 'Enter a valid email address';
  if (!fields.phone.trim()) errors.phone = 'Phone number is required';
  return errors;
}

/* ── Props ───────────────────────────────────────────────── */
export interface IntakeFormProps {
  /** Called with the structured BOOKING_REQUEST string (and optional captcha token) to inject into chat. */
  onSubmit: (message: string, recaptchaToken?: string | null) => void;
  /** Called when the user dismisses the form without submitting. */
  onCancel: () => void;
}

/* ── Component ───────────────────────────────────────────── */
export function IntakeForm({ onSubmit, onCancel }: IntakeFormProps) {
  const { executeRecaptcha } = useRecaptcha();
  const [service, setService] = useState('');
  const [duration, setDuration] = useState(30);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const fieldErrors = validate({ service, duration, name, email, phone });
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    setSubmitting(true);
    try {
      // Acquire captcha token (returns null when disabled)
      const captchaToken = await executeRecaptcha('submit_booking');

      // Build the structured message the AI agent can parse
      const parts = [
        `service=${service.trim()}`,
        `duration=${duration}`,
        `name=${name.trim()}`,
        `email=${email.trim()}`,
        `phone=${phone.trim()}`,
      ];
      if (comment.trim()) parts.push(`comment=${comment.trim()}`);
      const message = `BOOKING_REQUEST: ${parts.join('; ')}`;

      setSubmitted(true);
      onSubmit(message, captchaToken);
    } finally {
      setSubmitting(false);
    }
  }, [service, duration, name, email, phone, comment, executeRecaptcha, onSubmit]);

  // Once submitted, show a collapsed confirmation
  if (submitted) {
    return (
      <div style={styles.card}>
        <div style={styles.confirmedRow}>
          <span>✅</span>
          <span style={styles.confirmedText}>Booking details sent — the assistant will continue from here.</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerIcon}>📋</span>
        <span style={styles.headerTitle}>Book an Appointment</span>
        <button style={styles.closeBtn} onClick={onCancel} title="Close form" aria-label="Close form">✕</button>
      </div>

      {/* Service (free text) */}
      <label style={styles.label}>Service *</label>
      <input
        style={{ ...styles.input, ...(errors.service ? styles.inputError : {}) }}
        placeholder="e.g., haircut, tax consult, follow-up appointment"
        value={service}
        onChange={(e) => { setService(e.target.value); setErrors((p) => ({ ...p, service: undefined })); }}
      />
      {errors.service && <div style={styles.errorText}>{errors.service}</div>}

      {/* Duration (minutes) */}
      <label style={styles.label}>Duration (minutes) *</label>
      <input
        style={{ ...styles.input, ...(errors.duration ? styles.inputError : {}) }}
        type="number"
        min={5}
        max={240}
        value={duration}
        onChange={(e) => { setDuration(Number(e.target.value)); setErrors((p) => ({ ...p, duration: undefined })); }}
      />
      {errors.duration && <div style={styles.errorText}>{errors.duration}</div>}

      {/* Full Name */}
      <label style={styles.label}>Full Name *</label>
      <input
        style={{ ...styles.input, ...(errors.name ? styles.inputError : {}) }}
        placeholder="Jane Smith"
        value={name}
        onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: undefined })); }}
      />
      {errors.name && <div style={styles.errorText}>{errors.name}</div>}

      {/* Email */}
      <label style={styles.label}>Email *</label>
      <input
        style={{ ...styles.input, ...(errors.email ? styles.inputError : {}) }}
        type="email"
        placeholder="jane@example.com"
        value={email}
        onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: undefined })); }}
      />
      {errors.email && <div style={styles.errorText}>{errors.email}</div>}

      {/* Phone */}
      <label style={styles.label}>Phone Number *</label>
      <input
        style={{ ...styles.input, ...(errors.phone ? styles.inputError : {}) }}
        type="tel"
        placeholder="(555) 123-4567"
        value={phone}
        onChange={(e) => { setPhone(e.target.value); setErrors((p) => ({ ...p, phone: undefined })); }}
      />
      {errors.phone && <div style={styles.errorText}>{errors.phone}</div>}

      {/* Comment (optional) */}
      <label style={styles.label}>Comment</label>
      <textarea
        style={{ ...styles.input, ...styles.textarea }}
        placeholder="Any additional notes or requests (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />

      {/* Actions */}
      <div style={styles.actions}>
        <button style={styles.submitBtn} onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit & Book'}
        </button>
        <button style={styles.cancelBtn} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Styles ──────────────────────────────────────────────── */
const styles: Record<string, React.CSSProperties> = {
  card: {
    alignSelf: 'flex-start',
    maxWidth: '88%',
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 12,
    padding: 16,
    marginBottom: 4,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  headerIcon: { fontSize: 18 },
  headerTitle: { fontWeight: 700, fontSize: 14, flex: 1, color: '#1e293b' },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 16,
    cursor: 'pointer',
    color: '#94a3b8',
    padding: '2px 6px',
    borderRadius: 4,
    lineHeight: 1,
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: '#475569',
    marginTop: 8,
    marginBottom: 4,
  },
  input: {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
    background: '#fff',
    boxSizing: 'border-box' as const,
  },
  inputError: {
    borderColor: '#ef4444',
    background: '#fef2f2',
  },
  textarea: {
    minHeight: 60,
    resize: 'vertical' as const,
  },
  errorText: {
    fontSize: 11,
    color: '#ef4444',
    marginTop: 2,
  },
  actions: {
    display: 'flex',
    gap: 8,
    marginTop: 14,
  },
  submitBtn: {
    flex: 1,
    padding: '9px 14px',
    background: 'var(--primary, #6366f1)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  cancelBtn: {
    padding: '9px 14px',
    background: 'transparent',
    color: '#64748b',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  confirmedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  confirmedText: {
    fontSize: 13,
    color: '#16a34a',
    fontWeight: 500,
  },
};
