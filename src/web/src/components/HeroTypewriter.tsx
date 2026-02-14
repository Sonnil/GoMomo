'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/* ── Config ──────────────────────────────────────────────── */
const HEADLINE_ACCENT = 'AI agents';
const HEADLINE_REST = ' running your front desk — 24/7';
const HEADLINE = HEADLINE_ACCENT + HEADLINE_REST;
const SUBHEAD =
  'Deploy intelligent agents that book appointments, answer questions, and convert customers automatically.';

const INITIAL_DELAY = 200;   // ms before typing starts
const HEADLINE_SPEED = 55;   // ms per char (headline)
const LINE_PAUSE = 350;      // ms gap between lines
const SUBHEAD_SPEED = 32;    // ms per char (subheadline)
const CARET_LINGER = 1200;   // ms caret stays after last char

/**
 * Types the headline then the subheadline sequentially — once, on mount.
 *
 * ▸ SSR:  renders full visible text (fail-open — text always visible).
 * ▸ Client:  swaps to typing effect as progressive enhancement.
 * ▸ Reduced-motion:  renders both lines immediately, no caret.
 * ▸ CLS prevention:  invisible sizer reserves layout; visible layer overlays.
 * ▸ JS failure:  user still sees static text.
 */
export function HeroTypewriter() {
  // 'static' = SSR / pre-hydration: full text visible, no effects
  const [phase, setPhase] = useState<
    'static' | 'idle' | 'headline' | 'pause' | 'subhead' | 'linger' | 'done'
  >('static');
  const [headlineChars, setHeadlineChars] = useState(HEADLINE.length);
  const [subheadChars, setSubheadChars] = useState(SUBHEAD.length);
  const [typingActive, setTypingActive] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hIdx = useRef(0);
  const sIdx = useRef(0);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /* ── Boot: activate typing on client only ──────────────── */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');

    if (mq.matches) {
      setPhase('done');
      return;
    }

    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) {
        clear();
        setHeadlineChars(HEADLINE.length);
        setSubheadChars(SUBHEAD.length);
        setPhase('done');
        setTypingActive(false);
      }
    };
    mq.addEventListener('change', handler);

    // Reset chars to 0 so typing starts from empty
    setHeadlineChars(0);
    setSubheadChars(0);
    setTypingActive(true);
    hIdx.current = 0;
    sIdx.current = 0;
    timer.current = setTimeout(() => setPhase('headline'), INITIAL_DELAY);

    return () => {
      mq.removeEventListener('change', handler);
      clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Typing state machine ──────────────────────────────── */
  useEffect(() => {
    if (phase === 'static' || phase === 'done') return;
    clear();

    if (phase === 'headline') {
      const typeH = () => {
        if (hIdx.current < HEADLINE.length) {
          hIdx.current += 1;
          setHeadlineChars(hIdx.current);
          timer.current = setTimeout(typeH, HEADLINE_SPEED);
        } else {
          setPhase('pause');
        }
      };
      timer.current = setTimeout(typeH, HEADLINE_SPEED);
    }

    if (phase === 'pause') {
      timer.current = setTimeout(() => setPhase('subhead'), LINE_PAUSE);
    }

    if (phase === 'subhead') {
      const typeS = () => {
        if (sIdx.current < SUBHEAD.length) {
          sIdx.current += 1;
          setSubheadChars(sIdx.current);
          timer.current = setTimeout(typeS, SUBHEAD_SPEED);
        } else {
          setPhase('linger');
        }
      };
      timer.current = setTimeout(typeS, SUBHEAD_SPEED);
    }

    if (phase === 'linger') {
      timer.current = setTimeout(() => {
        setPhase('done');
        setTypingActive(false);
      }, CARET_LINGER);
    }

    return clear;
  }, [phase, clear]);

  /* ── Derived state ─────────────────────────────────────── */
  const headlineText = HEADLINE.slice(0, headlineChars);
  const subheadText = SUBHEAD.slice(0, subheadChars);
  const showCaret = typingActive && phase !== 'done' && phase !== 'static';
  const caretFading = phase === 'linger';

  // Split visible headline chars into accent vs rest portions
  const accentVisible = headlineText.slice(0, HEADLINE_ACCENT.length);
  const restVisible = headlineText.slice(HEADLINE_ACCENT.length);

  /* ── Render ────────────────────────────────────────────── */

  // Static mode (SSR + pre-hydration): plain text, no sizer/typed dance
  if (!typingActive && phase !== 'done') {
    return (
      <>
        <h1 className="hero-enter-headline text-4xl font-bold leading-tight tracking-tight md:text-6xl">
          <span className="hero-accent">{HEADLINE_ACCENT}</span>
          <span className="hero-rest">{HEADLINE_REST}</span>
        </h1>
        <p className="hero-enter-subhead mx-auto mt-6 max-w-xl text-lg text-[var(--text-muted)] md:text-xl">
          {SUBHEAD}
        </p>
      </>
    );
  }

  // Typing active OR done: sizer/typed layout with effects
  return (
    <>
      {/* ── Headline ─────────────────────────────────────── */}
      <h1 className="hero-enter-headline text-4xl font-bold leading-tight tracking-tight md:text-6xl">
        {/* Invisible sizing text — prevents CLS */}
        <span className="hero-sizer" aria-hidden="true">
          {HEADLINE}
        </span>
        {/* Visible typed text */}
        <span className="hero-typed" aria-hidden="true">
          <span className="hero-accent">{accentVisible}</span><span className="hero-rest">{restVisible}</span>
        </span>
        {/* Caret */}
        {showCaret &&
          (phase === 'headline' || phase === 'pause' || phase === 'idle') && (
            <span
              className={`headline-caret${caretFading ? ' headline-caret--fade' : ''}`}
              aria-hidden="true"
            />
          )}
      </h1>

      {/* ── Subheadline ──────────────────────────────────── */}
      <p className="hero-enter-subhead mx-auto mt-6 max-w-xl text-lg text-[var(--text-muted)] md:text-xl">
        {/* Invisible sizing text — prevents CLS */}
        <span className="hero-sizer" aria-hidden="true">
          {SUBHEAD}
        </span>
        {/* Visible typed text */}
        <span className="hero-typed" aria-hidden="true">
          {subheadText}
        </span>
        {/* Caret (subhead phase only) */}
        {showCaret && (phase === 'subhead' || phase === 'linger') && (
          <span
            className={`headline-caret${caretFading ? ' headline-caret--fade' : ''}`}
            aria-hidden="true"
          />
        )}
      </p>
    </>
  );
}
