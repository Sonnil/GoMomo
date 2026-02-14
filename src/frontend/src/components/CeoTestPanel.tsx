import React, { useState, useCallback } from 'react';

/**
 * CEO Pilot Test Panel — dev-only GUI for end-to-end booking + SMS testing.
 *
 * Visible ONLY when VITE_CEO_TEST_MODE=true OR NODE_ENV=development.
 * Provides:
 *   - Name / Email / Phone inputs
 *   - "Start Booking Test" — injects a scripted message into chat
 *   - "Send HELP to SMS" — shows instructions
 *   - "Show Latest Booking Info" — fetches from /debug/ceo-test/last-booking
 */

const API_BASE = import.meta.env.VITE_API_URL || '';
const CEO_TOKEN = import.meta.env.VITE_CEO_TEST_TOKEN || 'ceo-pilot-2026';
const DEFAULT_TENANT = import.meta.env.VITE_TENANT_ID || '00000000-0000-4000-a000-000000000001';

export interface CeoTestPanelProps {
  /** Callback to inject a user message into the chat widget */
  onInjectMessage: (message: string) => void;
}

interface BookingInfo {
  reference_code: string;
  start_time: string;
  end_time: string;
  timezone: string;
  status: string;
  sms_enabled: boolean;
  phone_masked: string;
  email_masked: string;
  reminder_jobs: Array<{ type: string; status: string; scheduled_at: string }>;
  created_at: string;
}

export function CeoTestPanel({ onInjectMessage }: CeoTestPanelProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [bookingInfo, setBookingInfo] = useState<BookingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [helpVisible, setHelpVisible] = useState(false);
  const [postBookingTip, setPostBookingTip] = useState(false);

  // ── Phone format hint ─────────────────────────────
  const formatPhoneHint = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return raw;
  };

  // ── Start Booking Test ────────────────────────────
  const handleStartBooking = useCallback(() => {
    if (!name.trim() || !email.trim() || !phone.trim()) {
      setError('Please fill in all three fields (name, email, phone).');
      return;
    }
    setError(null);
    setPostBookingTip(false);

    const e164 = formatPhoneHint(phone);
    const message = `I want to book an appointment on the next available slot. My name is ${name.trim()}, email is ${email.trim()}, phone is ${e164}. Please confirm and enable SMS reminders.`;
    onInjectMessage(message);

    // Show post-booking tip after a delay
    setTimeout(() => setPostBookingTip(true), 3000);
  }, [name, email, phone, onInjectMessage]);

  // ── Send HELP to SMS ──────────────────────────────
  const handleSendHelp = useCallback(() => {
    setHelpVisible(true);
  }, []);

  // ── Show Latest Booking ───────────────────────────
  const handleShowBooking = useCallback(async () => {
    setError(null);
    setBookingInfo(null);
    try {
      const res = await fetch(
        `${API_BASE}/debug/ceo-test/last-booking?tenant_id=${DEFAULT_TENANT}`,
        {
          headers: { 'X-CEO-TEST-TOKEN': CEO_TOKEN },
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      const data: BookingInfo = await res.json();
      setBookingInfo(data);
    } catch (err) {
      setError('Network error — is the backend running?');
    }
  }, []);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.badge}>🧪 CEO PILOT TEST</span>
        <span style={styles.devTag}>dev only</span>
      </div>

      {/* Input fields */}
      <div style={styles.fields}>
        <input
          style={styles.input}
          placeholder="Full Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          style={styles.input}
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          style={styles.input}
          placeholder="Phone (e.g. 555-123-4567)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        {phone && (
          <div style={styles.hint}>E.164: {formatPhoneHint(phone)}</div>
        )}
      </div>

      {/* Action buttons */}
      <div style={styles.buttons}>
        <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={handleStartBooking}>
          🚀 Start Booking Test
        </button>
        <button style={{ ...styles.btn, ...styles.btnSecondary }} onClick={handleSendHelp}>
          📱 Send HELP to SMS
        </button>
        <button style={{ ...styles.btn, ...styles.btnSecondary }} onClick={handleShowBooking}>
          📋 Show Latest Booking Info
        </button>
      </div>

      {/* Error display */}
      {error && <div style={styles.error}>⚠️ {error}</div>}

      {/* Post-booking tip */}
      {postBookingTip && (
        <div style={styles.tip}>
          ✅ Message sent to chat! After the booking is confirmed, check your phone for the
          confirmation SMS. Reply <strong>HELP</strong> / <strong>CANCEL</strong> /{' '}
          <strong>CHANGE</strong> to test SMS workflows.
        </div>
      )}

      {/* HELP instructions */}
      {helpVisible && (
        <div style={styles.infoCard}>
          <strong>SMS HELP Test</strong>
          <p style={styles.infoText}>
            Send a text with the word <code>HELP</code> from your phone to the Twilio number
            configured in <code>TWILIO_PHONE_NUMBER</code>.
          </p>
          <p style={styles.infoText}>
            If testing locally without real Twilio, use:{' '}
            <code style={styles.code}>
              curl -X POST http://localhost:3000/twilio/sms/incoming -d
              "From=+1YOURPHONE&To=+18005551234&Body=HELP&MessageSid=SM_TEST"
            </code>
          </p>
          <button
            style={{ ...styles.btn, ...styles.btnDismiss }}
            onClick={() => setHelpVisible(false)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Booking info display */}
      {bookingInfo && (
        <div style={styles.infoCard}>
          <strong>Latest Booking</strong>
          <table style={styles.table}>
            <tbody>
              <tr><td style={styles.label}>Ref Code</td><td style={styles.value}>{bookingInfo.reference_code}</td></tr>
              <tr><td style={styles.label}>Start</td><td style={styles.value}>{new Date(bookingInfo.start_time).toLocaleString()}</td></tr>
              <tr><td style={styles.label}>Timezone</td><td style={styles.value}>{bookingInfo.timezone}</td></tr>
              <tr><td style={styles.label}>Status</td><td style={styles.value}>{bookingInfo.status}</td></tr>
              <tr><td style={styles.label}>SMS Enabled</td><td style={styles.value}>{bookingInfo.sms_enabled ? '✅ Yes' : '❌ No'}</td></tr>
              <tr><td style={styles.label}>Phone</td><td style={styles.value}>{bookingInfo.phone_masked}</td></tr>
              <tr><td style={styles.label}>Email</td><td style={styles.value}>{bookingInfo.email_masked}</td></tr>
              {bookingInfo.reminder_jobs.map((r, i) => (
                <tr key={i}>
                  <td style={styles.label}>Reminder {i + 1}</td>
                  <td style={styles.value}>{r.type} — {r.status} @ {new Date(r.scheduled_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Styles ──────────────────────────────────────────────── */

const styles: Record<string, React.CSSProperties> = {
  panel: {
    border: '2px dashed #f59e0b',
    borderRadius: 12,
    padding: 16,
    marginTop: 20,
    background: 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  badge: {
    fontWeight: 700,
    fontSize: 14,
    color: '#92400e',
  },
  devTag: {
    background: '#fbbf24',
    color: '#78350f',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
  },
  fields: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    marginBottom: 12,
  },
  input: {
    padding: '8px 10px',
    border: '1px solid #d97706',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
    background: '#fff',
  },
  hint: {
    fontSize: 11,
    color: '#92400e',
    fontFamily: 'monospace',
  },
  buttons: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    marginBottom: 8,
  },
  btn: {
    padding: '8px 12px',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left' as const,
  },
  btnPrimary: {
    background: '#d97706',
    color: '#fff',
  },
  btnSecondary: {
    background: '#fde68a',
    color: '#78350f',
  },
  btnDismiss: {
    background: 'transparent',
    color: '#92400e',
    textDecoration: 'underline' as const,
    padding: '4px 0',
    marginTop: 6,
    fontSize: 12,
  },
  error: {
    color: '#dc2626',
    fontWeight: 600,
    marginTop: 4,
    padding: '6px 10px',
    background: '#fef2f2',
    borderRadius: 6,
  },
  tip: {
    marginTop: 8,
    padding: '8px 12px',
    background: '#ecfdf5',
    border: '1px solid #6ee7b7',
    borderRadius: 8,
    color: '#065f46',
    lineHeight: 1.5,
  },
  infoCard: {
    marginTop: 10,
    padding: '10px 12px',
    background: '#fff',
    border: '1px solid #fbbf24',
    borderRadius: 8,
    lineHeight: 1.6,
  },
  infoText: {
    margin: '4px 0',
    fontSize: 12,
    color: '#44403c',
  },
  code: {
    display: 'inline-block',
    background: '#f5f5f4',
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 11,
    wordBreak: 'break-all' as const,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    marginTop: 6,
  },
  label: {
    fontWeight: 600,
    padding: '3px 8px 3px 0',
    color: '#78350f',
    whiteSpace: 'nowrap' as const,
    verticalAlign: 'top' as const,
  },
  value: {
    padding: '3px 0',
    color: '#1c1917',
    wordBreak: 'break-all' as const,
  },
};
