'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/* ── Types ─────────────────────────────────────────────────── */
export type ThemePreference = 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  /** What the user chose: light | dark */
  preference: ThemePreference;
  /** What is actually applied: light | dark */
  resolved: ResolvedTheme;
  /** Update preference (persists to localStorage) */
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'gomomo_theme';

/* ── Helpers ───────────────────────────────────────────────── */
function applyToDOM(resolved: ResolvedTheme) {
  const el = document.documentElement;
  el.classList.remove('light', 'dark');
  el.classList.add(resolved);
  el.style.colorScheme = resolved;
}

/** Add temporary transition class for smooth theme switch (not first load) */
function transitionTheme(resolved: ResolvedTheme) {
  const el = document.documentElement;
  el.classList.add('theme-transition');
  applyToDOM(resolved);
  // Remove after transitions complete
  setTimeout(() => el.classList.remove('theme-transition'), 350);
}

/** Normalise stored value — migrates legacy "system" preference to "dark" */
function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'dark';
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'light') return 'light';
  return 'dark'; // default + migrates "system" and any unknown value
}

/* ── Provider ──────────────────────────────────────────────── */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    readStoredPreference,
  );

  const isFirstRender = useRef(true);

  /* ── Apply theme to DOM whenever preference changes ────── */
  useEffect(() => {
    if (isFirstRender.current) {
      applyToDOM(preference);          // no transition on first load
      isFirstRender.current = false;
    } else {
      transitionTheme(preference);     // smooth transition on user toggle
    }
  }, [preference]);

  /* ── Setter ────────────────────────────────────────────── */
  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* quota exceeded or SSR — ignore */
    }
  }, []);

  const value = useMemo(
    () => ({ preference, resolved: preference, setPreference }),
    [preference, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/* ── Hook ──────────────────────────────────────────────────── */
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
