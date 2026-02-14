'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useChatPopup } from './ChatPopupContext';

// ── Widget URL (only resolved when popup opens) ─────────────
const WIDGET_BASE = process.env.NEXT_PUBLIC_WIDGET_URL || 'http://localhost:5173';
const WIDGET_URL = `${WIDGET_BASE}${WIDGET_BASE.includes('?') ? '&' : '?'}embed=1`;

/** Kill switch — set NEXT_PUBLIC_SHOW_CHATBOT=false to hide the chat popup entirely. */
const CHATBOT_VISIBLE = process.env.NEXT_PUBLIC_SHOW_CHATBOT !== 'false';

/** Timeout before showing error state in the iframe loader (ms). */
const IFRAME_LOAD_TIMEOUT_MS = 12_000;

// ── Agent iframe with loading spinner + error fallback ──────
function AgentIframe({ widgetUrl }: { widgetUrl: string }) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeError, setIframeError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setIframeLoaded(false);
    setIframeError(false);

    timeoutRef.current = setTimeout(() => {
      setIframeError(true);
    }, IFRAME_LOAD_TIMEOUT_MS);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [retryKey]);

  const handleLoad = useCallback(() => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    setIframeLoaded(true);
    setIframeError(false);
  }, []);

  const handleRetry = useCallback(() => {
    setRetryKey((k) => k + 1);
  }, []);

  if (iframeError && !iframeLoaded) {
    return (
      <div className="chat-popup-error">
        <span className="text-3xl">⚡</span>
        <p className="text-sm font-semibold text-[var(--text)]">Agent unavailable</p>
        <p className="text-xs text-[var(--text-muted)] text-center max-w-[240px] leading-relaxed">
          We couldn&apos;t load the chat agent. Please check your connection and try again.
        </p>
        <button
          onClick={handleRetry}
          className="mt-1 px-4 py-1.5 rounded-lg bg-[var(--primary)] text-white text-xs font-semibold hover:opacity-90 transition-opacity"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      {!iframeLoaded && (
        <div className="chat-popup-loading">
          <div className="agent-spinner" />
          <p className="text-xs text-[var(--text-muted)]">Loading agent…</p>
        </div>
      )}
      <iframe
        key={retryKey}
        src={widgetUrl}
        title="gomomo.ai live agent"
        className={`chat-popup-iframe ${iframeLoaded ? 'loaded' : ''}`}
        allow="clipboard-write; microphone"
        onLoad={handleLoad}
      />
    </>
  );
}

// ── Floating chat popup (widget-only, no outer chrome) ──────
export function ChatPopup() {
  const { isOpen, close } = useChatPopup();

  // Kill switch — hide entire chatbot (popup + bubble won't open)
  if (!CHATBOT_VISIBLE) return null;

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, close]);

  // Don't render anything when closed — unmounts iframe from DOM
  if (!isOpen) return null;

  return createPortal(
    <div className="chat-popup" role="dialog" aria-label="Gomomo AI Agent">
      {/* Close button — overlays the top-right corner of the widget */}
      <button
        onClick={close}
        aria-label="Close"
        className="chat-popup-close"
      >
        <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M4 4l10 10M14 4L4 14" />
        </svg>
      </button>

      {/* Agent iframe — the widget provides its own full UI chrome */}
      <AgentIframe widgetUrl={WIDGET_URL} />
    </div>,
    document.body,
  );
}
