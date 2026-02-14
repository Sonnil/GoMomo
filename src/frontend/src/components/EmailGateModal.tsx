import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useRecaptcha } from '../hooks/useRecaptcha';

const API_URL = import.meta.env.VITE_API_URL || window.location.origin;

interface EmailGateModalProps {
  sessionId: string;
  tenantId: string;
  onVerified: (email: string) => void;
  onClose?: () => void;
}

export function EmailGateModal({ sessionId, tenantId, onVerified, onClose }: EmailGateModalProps) {
  const { executeRecaptcha } = useRecaptcha();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newsletterOptIn, setNewsletterOptIn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Persist returnTo URL so /verify-email (or app relaunch) can redirect back
  useEffect(() => {
    try {
      const returnTo = window.location.pathname + window.location.hash;
      localStorage.setItem('gomomo_returnTo', returnTo || '/#try-it');
    } catch { /* localStorage may be unavailable (iframe sandbox, etc.) */ }
  }, []);

  // Auto-focus the appropriate input when step changes
  useEffect(() => {
    if (step === 'email') emailInputRef.current?.focus();
    else codeInputRef.current?.focus();
  }, [step]);

  const handleRequestCode = useCallback(async () => {
    if (!email.trim()) {
      setError('Please enter your email.');
      return;
    }
    setError(null);
    setLoading(true);

    try {
      // Acquire captcha token (returns null when disabled)
      const captchaToken = await executeRecaptcha('request_email_code');

      const res = await fetch(`${API_URL}/api/auth/request-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          session_id: sessionId,
          tenant_id: tenantId,
          ...(captchaToken ? { recaptcha_token: captchaToken } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to send verification code.');
        return;
      }

      setStep('code');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [email, sessionId, tenantId, executeRecaptcha]);

  const handleVerifyCode = useCallback(async () => {
    if (!code.trim()) {
      setError('Please enter the verification code.');
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/auth/verify-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim(),
          session_id: sessionId,
          tenant_id: tenantId,
          newsletter_opt_in: newsletterOptIn,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Verification failed. Please try again.');
        return;
      }

      onVerified(email.trim());
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [email, code, sessionId, tenantId, newsletterOptIn, onVerified]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (step === 'email') handleRequestCode();
      else handleVerifyCode();
    }
  };

  return (
    <div style={modalStyles.overlay}>
      <div style={modalStyles.modal}>
        {/* Close button (optional — only if onClose provided) */}
        {onClose && (
          <button style={modalStyles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}

        <div style={modalStyles.icon}>📧</div>
        <h3 style={modalStyles.title}>
          {step === 'email' ? 'Continue with your email' : 'Enter verification code'}
        </h3>
        <p style={modalStyles.subtitle}>
          {step === 'email'
            ? "We'll send booking confirmations and updates here."
            : `We sent a 6-digit code to ${email}. Check your inbox!`}
        </p>

        {error && <div style={modalStyles.error}>{error}</div>}

        {step === 'email' ? (
          <>
            <input
              ref={emailInputRef}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={handleKeyDown}
              style={modalStyles.input}
              autoFocus
              disabled={loading}
            />
            <label style={modalStyles.checkboxRow}>
              <input
                type="checkbox"
                checked={newsletterOptIn}
                onChange={(e) => setNewsletterOptIn(e.target.checked)}
                style={modalStyles.checkbox}
              />
              <span style={modalStyles.checkboxLabel}>
                Subscribe to gomomo updates
              </span>
            </label>
            <button
              style={modalStyles.button}
              onClick={handleRequestCode}
              disabled={loading}
            >
              {loading ? 'Sending…' : 'Send verification code'}
            </button>
            {onClose && (
              <button
                style={modalStyles.linkBtn}
                onClick={onClose}
                disabled={loading}
              >
                Cancel
              </button>
            )}
          </>
        ) : (
          <>
            <input
              ref={codeInputRef}
              type="text"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={handleKeyDown}
              style={{ ...modalStyles.input, textAlign: 'center' as const, letterSpacing: 6, fontSize: 20 }}
              autoFocus
              maxLength={6}
              disabled={loading}
            />
            <button
              style={modalStyles.button}
              onClick={handleVerifyCode}
              disabled={loading || code.length < 6}
            >
              {loading ? 'Verifying…' : 'Verify'}
            </button>
            <button
              style={modalStyles.linkBtn}
              onClick={() => { setStep('email'); setCode(''); setError(null); }}
              disabled={loading}
            >
              ← Use a different email
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Inline Styles ───────────────────────────────────────

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    backdropFilter: 'blur(2px)',
  },
  modal: {
    background: '#1e1e2e',
    borderRadius: 16,
    padding: '28px 24px',
    maxWidth: 340,
    width: '90%',
    position: 'relative',
    boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
    textAlign: 'center' as const,
  },
  closeBtn: {
    position: 'absolute',
    top: 8,
    right: 10,
    background: 'none',
    border: 'none',
    color: '#888',
    fontSize: 18,
    cursor: 'pointer',
  },
  icon: {
    fontSize: 36,
    marginBottom: 8,
  },
  title: {
    margin: '0 0 6px',
    fontSize: 16,
    fontWeight: 700,
    color: '#f0f0f0',
  },
  subtitle: {
    margin: '0 0 16px',
    fontSize: 13,
    color: '#999',
    lineHeight: 1.4,
  },
  error: {
    marginBottom: 12,
    padding: '8px 12px',
    borderRadius: 8,
    background: 'rgba(239, 68, 68, 0.15)',
    color: '#ef4444',
    fontSize: 12,
    fontWeight: 600,
  },
  input: {
    width: '100%',
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid #444',
    background: '#2a2a3c',
    color: '#f0f0f0',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box' as const,
    marginBottom: 12,
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
    cursor: 'pointer',
  },
  checkbox: {
    accentColor: '#6366f1',
    width: 16,
    height: 16,
  },
  checkboxLabel: {
    fontSize: 12,
    color: '#aaa',
  },
  button: {
    width: '100%',
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: '#6366f1',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    marginBottom: 8,
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: '#6366f1',
    fontSize: 12,
    cursor: 'pointer',
    padding: '4px 0',
  },
};
