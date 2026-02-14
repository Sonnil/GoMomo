'use client';

import { useEffect, useState } from 'react';
import { useTheme } from './ThemeProvider';
import type { ThemePreference } from './ThemeProvider';

const CYCLE: ThemePreference[] = ['dark', 'light'];

/**
 * A compact sun/moon icon button that toggles between dark and light.
 *
 * Uses a mounted-gate pattern to avoid hydration mismatch:
 * before the first client effect fires, we render a **stable placeholder**
 * button with no theme-dependent attributes (no aria-label, no title,
 * no data-theme). The CSS rule `.theme-toggle:not([data-theme])` shows
 * the moon icon as a neutral default, matching the server HTML exactly.
 *
 * Once mounted === true (after hydration), we swap in the real toggle
 * with the correct preference-based label, icon, and handler.
 */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const next = () => {
    const idx = CYCLE.indexOf(preference);
    setPreference(CYCLE[(idx + 1) % CYCLE.length]);
  };

  const label =
    preference === 'dark'
      ? 'Switch to light theme'
      : 'Switch to dark theme';

  /* ── Pre-hydration placeholder — layout-stable, theme-neutral ── */
  if (!mounted) {
    return (
      <button
        type="button"
        className="theme-toggle"
        aria-hidden
        tabIndex={-1}
      >
        {/* Moon shown via CSS :not([data-theme]) fallback */}
        <svg
          className="theme-toggle__moon"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>
    );
  }

  /* ── Post-hydration real toggle ── */

  return (
    <button
      type="button"
      onClick={next}
      aria-label={label}
      title={label}
      className="theme-toggle"
      data-theme={preference}
    >
      {/* Sun (light) */}
      <svg
        className="theme-toggle__sun"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>

      {/* Moon (dark) */}
      <svg
        className="theme-toggle__moon"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  );
}
