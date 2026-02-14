/**
 * IntakeForm logic tests — validates the BOOKING_REQUEST format,
 * field validation rules, and email regex used by the frontend component.
 *
 * These tests run in the backend vitest suite (no DOM required).
 * They test the same logic the IntakeForm component uses.
 */
import { describe, it, expect } from 'vitest';

// ── Validation logic (mirrors IntakeForm.tsx) ─────────────

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

function buildBookingRequest(fields: {
  service: string;
  duration: number;
  name: string;
  email: string;
  phone: string;
  comment?: string;
}): string {
  const parts = [
    `service=${fields.service.trim()}`,
    `duration=${fields.duration}`,
    `name=${fields.name.trim()}`,
    `email=${fields.email.trim()}`,
    `phone=${fields.phone.trim()}`,
  ];
  if (fields.comment?.trim()) parts.push(`comment=${fields.comment.trim()}`);
  return `BOOKING_REQUEST: ${parts.join('; ')}`;
}

// ── Tests ─────────────────────────────────────────────────

describe('IntakeForm validation', () => {
  const good = { service: 'Haircut', duration: 30, name: 'Jane Smith', email: 'jane@example.com', phone: '(555) 123-4567' };

  it('accepts valid fields with no errors', () => {
    expect(Object.keys(validate(good))).toHaveLength(0);
  });

  it('rejects empty service', () => {
    const errors = validate({ ...good, service: '' });
    expect(errors.service).toBeDefined();
  });

  it('rejects whitespace-only service', () => {
    const errors = validate({ ...good, service: '   ' });
    expect(errors.service).toBeDefined();
  });

  it('rejects duration below minimum (5)', () => {
    const errors = validate({ ...good, duration: 3 });
    expect(errors.duration).toContain('Minimum');
  });

  it('rejects duration above maximum (240)', () => {
    const errors = validate({ ...good, duration: 300 });
    expect(errors.duration).toContain('Maximum');
  });

  it('accepts duration at boundaries (5, 240)', () => {
    expect(validate({ ...good, duration: 5 }).duration).toBeUndefined();
    expect(validate({ ...good, duration: 240 }).duration).toBeUndefined();
  });

  it('rejects NaN duration', () => {
    const errors = validate({ ...good, duration: NaN });
    expect(errors.duration).toBeDefined();
  });

  it('rejects empty name', () => {
    const errors = validate({ ...good, name: '  ' });
    expect(errors.name).toBeDefined();
  });

  it('rejects empty email', () => {
    const errors = validate({ ...good, email: '' });
    expect(errors.email).toContain('required');
  });

  it('rejects invalid email format', () => {
    const errors = validate({ ...good, email: 'not-an-email' });
    expect(errors.email).toContain('valid email');
  });

  it('accepts various valid email formats', () => {
    const validEmails = ['a@b.co', 'user+tag@gmail.com', 'name@sub.domain.org'];
    for (const email of validEmails) {
      expect(validate({ ...good, email }).email).toBeUndefined();
    }
  });

  it('rejects empty phone', () => {
    const errors = validate({ ...good, phone: '' });
    expect(errors.phone).toBeDefined();
  });

  it('reports all missing fields at once', () => {
    const errors = validate({ service: '', duration: 0, name: '', email: '', phone: '' });
    expect(Object.keys(errors)).toHaveLength(5);
  });
});

describe('IntakeForm BOOKING_REQUEST message format', () => {
  it('builds correct structured message without comment', () => {
    const msg = buildBookingRequest({
      service: 'Tax Consult',
      duration: 60,
      name: 'Jane Smith',
      email: 'jane@example.com',
      phone: '(555) 123-4567',
    });
    expect(msg).toBe(
      'BOOKING_REQUEST: service=Tax Consult; duration=60; name=Jane Smith; email=jane@example.com; phone=(555) 123-4567',
    );
  });

  it('includes comment field when provided', () => {
    const msg = buildBookingRequest({
      service: 'Haircut',
      duration: 30,
      name: 'Bob Jones',
      email: 'bob@test.com',
      phone: '+15551234567',
      comment: 'Prefer afternoon slots',
    });
    expect(msg).toContain('comment=Prefer afternoon slots');
  });

  it('omits comment field when empty or whitespace', () => {
    const noComment = buildBookingRequest({
      service: 'Visit',
      duration: 15,
      name: 'A',
      email: 'a@b.com',
      phone: '123',
      comment: '   ',
    });
    expect(noComment).not.toContain('comment=');

    const undefinedComment = buildBookingRequest({
      service: 'Visit',
      duration: 15,
      name: 'A',
      email: 'a@b.com',
      phone: '123',
    });
    expect(undefinedComment).not.toContain('comment=');
  });

  it('starts with BOOKING_REQUEST: prefix', () => {
    const msg = buildBookingRequest({
      service: 'Visit',
      duration: 30,
      name: 'A',
      email: 'a@b.com',
      phone: '123',
    });
    expect(msg.startsWith('BOOKING_REQUEST:')).toBe(true);
  });

  it('trims whitespace from fields', () => {
    const msg = buildBookingRequest({
      service: '  Haircut  ',
      duration: 30,
      name: '  Jane  ',
      email: ' jane@e.com ',
      phone: ' 555 ',
      comment: '  notes  ',
    });
    expect(msg).toContain('service=Haircut');
    expect(msg).toContain('name=Jane');
    expect(msg).toContain('email=jane@e.com');
    expect(msg).toContain('phone=555');
    expect(msg).toContain('comment=notes');
  });

  it('fields are semicolon-separated and parseable', () => {
    const msg = buildBookingRequest({
      service: 'Follow-up Appointment',
      duration: 45,
      name: 'Bob Jones',
      email: 'bob@test.com',
      phone: '+15551234567',
      comment: 'First visit',
    });

    const payload = msg.replace('BOOKING_REQUEST:', '').trim();
    const fields: Record<string, string> = {};
    for (const part of payload.split(';')) {
      const [key, ...rest] = part.split('=');
      if (key && rest.length) fields[key.trim()] = rest.join('=').trim();
    }

    expect(fields.service).toBe('Follow-up Appointment');
    expect(fields.duration).toBe('45');
    expect(fields.name).toBe('Bob Jones');
    expect(fields.email).toBe('bob@test.com');
    expect(fields.phone).toBe('+15551234567');
    expect(fields.comment).toBe('First visit');
  });
});
