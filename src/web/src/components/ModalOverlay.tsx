'use client';

import { useCallback, useEffect, useRef } from 'react';

interface ModalOverlayProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Max width class — defaults to max-w-3xl */
  maxWidth?: string;
}

/**
 * Full-screen modal overlay for legal docs.
 * - Backdrop click → close
 * - ESC key → close
 * - Focus-trapped title bar with X button
 * - Scrollable body
 */
export function ModalOverlay({
  title,
  onClose,
  children,
  maxWidth = 'max-w-3xl',
}: ModalOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // ESC to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Focus the close button on mount
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Click outside the panel → close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4 pt-16 sm:pt-20"
    >
      <div
        className={`relative rounded-2xl border border-[var(--border)] bg-[var(--bg)] shadow-2xl w-full ${maxWidth}`}
      >
        {/* Title bar */}
        <div className="flex-none sticky top-0 z-10 flex items-center justify-between rounded-t-2xl border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-sm px-6 py-4">
          <h2 className="text-lg font-semibold text-[var(--text)]">{title}</h2>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text)]"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l10 10M14 4L4 14" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-6">
          {children}
        </div>
      </div>
    </div>
  );
}
