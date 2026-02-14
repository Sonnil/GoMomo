import React, { useState, useCallback, useRef, useEffect } from 'react';

/* ── Toast Types ─────────────────────────────────────────── */
export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message: string;
  timestamp: Date;
}

let toastIdCounter = 0;

/* ── Hook ────────────────────────────────────────────────── */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const addToast = useCallback((type: ToastType, title: string, message: string, durationMs = 8000) => {
    const id = `toast-${++toastIdCounter}`;
    const toast: Toast = { id, type, title, message, timestamp: new Date() };
    setToasts(prev => [...prev, toast]);

    const timer = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      timersRef.current.delete(id);
    }, durationMs);
    timersRef.current.set(id, timer);

    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach(t => clearTimeout(t));
    };
  }, []);

  return { toasts, addToast, removeToast };
}

/* ── Styles ──────────────────────────────────────────────── */
const TOAST_CONFIGS: Record<ToastType, { icon: string; bg: string; border: string; glow: string }> = {
  success: { icon: '✅', bg: 'rgba(34,197,94,0.15)', border: 'rgba(34,197,94,0.4)', glow: 'rgba(34,197,94,0.2)' },
  error:   { icon: '❌', bg: 'rgba(239,68,68,0.15)',  border: 'rgba(239,68,68,0.4)',  glow: 'rgba(239,68,68,0.2)' },
  warning: { icon: '⚠️', bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)', glow: 'rgba(245,158,11,0.2)' },
  info:    { icon: 'ℹ️', bg: 'rgba(59,130,246,0.15)',  border: 'rgba(59,130,246,0.4)',  glow: 'rgba(59,130,246,0.2)' },
};

/* ── Renderer ────────────────────────────────────────────── */
export function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 16,
      right: 16,
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      maxWidth: 380,
      pointerEvents: 'none',
    }}>
      {toasts.map(toast => {
        const config = TOAST_CONFIGS[toast.type];
        return (
          <div
            key={toast.id}
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '12px 16px',
              borderRadius: 14,
              background: config.bg,
              border: `1px solid ${config.border}`,
              backdropFilter: 'blur(16px)',
              boxShadow: `0 4px 24px ${config.glow}`,
              animation: 'toast-in 0.35s cubic-bezier(0.16,1,0.3,1)',
              cursor: 'pointer',
              color: '#fff',
            }}
            onClick={() => onDismiss(toast.id)}
            role="alert"
          >
            <span style={{ fontSize: 20, flexShrink: 0, lineHeight: 1 }}>{config.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>{toast.title}</div>
              <div style={{ fontSize: 12, lineHeight: 1.4, opacity: 0.85 }}>{toast.message}</div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(toast.id); }}
              style={{
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)',
                cursor: 'pointer', fontSize: 16, padding: '0 2px', lineHeight: 1,
              }}
              aria-label="Dismiss"
            >×</button>
          </div>
        );
      })}
    </div>
  );
}

/* ── Event Detection ─────────────────────────────────────── */

/** Scans an assistant message and fires appropriate toasts. */
export function detectEvents(
  text: string,
  addToast: (type: ToastType, title: string, message: string, duration?: number) => void,
) {
  const lower = text.toLowerCase();

  // ── Booking Confirmed ──────────────────────────────────
  const refMatch = text.match(/\bAPT-[A-Z0-9]{4,}\b/i);
  if (
    refMatch &&
    (lower.includes('confirmed') || lower.includes('booked') || lower.includes('scheduled'))
  ) {
    addToast('success', 'Booking Confirmed', `Reference: ${refMatch[0].toUpperCase()}`, 12000);
    return; // Don't fire multiple toasts for the same message
  }

  // ── Booking Cancelled ──────────────────────────────────
  if (
    (lower.includes('cancelled') || lower.includes('canceled')) &&
    (lower.includes('appointment') || lower.includes('booking'))
  ) {
    addToast('info', 'Booking Cancelled', 'Your appointment has been cancelled.', 10000);
    return;
  }

  // ── Booking Rescheduled ────────────────────────────────
  if (
    lower.includes('rescheduled') &&
    (lower.includes('appointment') || lower.includes('booking'))
  ) {
    addToast('success', 'Booking Rescheduled', 'Your appointment has been moved to the new time.', 10000);
    return;
  }

  // ── Slot Not Available / Conflict ──────────────────────
  if (
    lower.includes('no longer available') ||
    lower.includes('not available') ||
    lower.includes('already booked') ||
    lower.includes('slot has been taken') ||
    lower.includes('conflict')
  ) {
    addToast('error', 'Slot Unavailable', 'That time slot is no longer available. Please choose another.', 10000);
    return;
  }

  // ── Hold Expired ───────────────────────────────────────
  if (lower.includes('hold') && (lower.includes('expired') || lower.includes('timed out'))) {
    addToast('warning', 'Hold Expired', 'Your slot hold has expired. Please select a new time.', 10000);
    return;
  }

  // ── Calendar / System Error ────────────────────────────
  if (
    lower.includes('unable to sync') ||
    lower.includes('calendar system') ||
    lower.includes('system error') ||
    lower.includes('something went wrong') ||
    lower.includes('internal error')
  ) {
    addToast('error', 'System Issue', 'A system error occurred. The agent will suggest next steps.', 10000);
    return;
  }

  // ── Follow-up Scheduled (Feature 2) ────────────────────
  if (
    (lower.includes('follow-up') || lower.includes('follow up') || lower.includes('followup')) &&
    (lower.includes('scheduled') || lower.includes('i\'ll text') || lower.includes('i\'ll email') || lower.includes('we\'ll text') || lower.includes('we\'ll email') || lower.includes('contact you'))
  ) {
    addToast('success', 'Follow-up Scheduled', 'You\'ll be contacted with available options shortly.', 10000);
    return;
  }

  // ── Connection Error ───────────────────────────────────
  if (lower.includes('connection error') || lower.includes('could not connect')) {
    addToast('error', 'Connection Lost', 'Unable to reach the server. Please check if the backend is running.', 10000);
    return;
  }
}
