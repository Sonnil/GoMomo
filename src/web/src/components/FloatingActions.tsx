'use client';

import { useState, useEffect, useCallback } from 'react';
import { useChatPopup } from './ChatPopupContext';

// ── Scroll threshold before showing the scroll-to-top button ──
const SCROLL_THRESHOLD = 400;

/** Kill switch — set NEXT_PUBLIC_SHOW_CHATBOT=false to hide the chat bubble. */
const CHATBOT_VISIBLE = process.env.NEXT_PUBLIC_SHOW_CHATBOT !== 'false';

export function FloatingActions() {
  const { isOpen, toggle } = useChatPopup();
  const [showScrollTop, setShowScrollTop] = useState(false);

  // ── Track scroll position ──────────────────────────────────
  useEffect(() => {
    function handleScroll() {
      setShowScrollTop(window.scrollY > SCROLL_THRESHOLD);
    }
    // Check on mount in case page loads mid-scroll
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // ── Smooth scroll to top ───────────────────────────────────
  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <div className="floating-actions">
      {/* Agent chat bubble — always visible */}
      {CHATBOT_VISIBLE && (
        <button
          onClick={toggle}
          aria-label={isOpen ? 'Close Gomomo agent' : 'Open Gomomo agent'}
          className={`floating-bubble agent-bubble ${isOpen ? 'active' : ''}`}
        >
          {isOpen ? (
            /* Close icon (X) */
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          ) : (
            /* Chat bubble icon */
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z" />
              <circle cx="9" cy="11" r="1" fill="currentColor" stroke="none" />
              <circle cx="12" cy="11" r="1" fill="currentColor" stroke="none" />
              <circle cx="15" cy="11" r="1" fill="currentColor" stroke="none" />
            </svg>
          )}
        </button>
      )}

      {/* Scroll-to-top — appears below the agent bubble when scrolled */}
      <button
        onClick={scrollToTop}
        aria-label="Scroll to top"
        className={`floating-bubble scroll-top-bubble ${showScrollTop ? 'visible' : ''}`}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 19V5" />
          <path d="M5 12l7-7 7 7" />
        </svg>
      </button>
    </div>
  );
}
