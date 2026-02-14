'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';

// ── Types ─────────────────────────────────────────────────

type VerifyState = 'idle' | 'verifying' | 'success' | 'error';

// ── Constants ─────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const RETURN_TO_KEY = 'gomomo_returnTo';
const REDIRECT_DELAY_MS = 1500;
const DEFAULT_RETURN = '/#try-it';

// ── Inner component (reads useSearchParams) ───────────────

function VerifyEmailInner() {
  const params = useSearchParams();

  // Query params: ?code=123456&email=a@b.com&session_id=xxx&tenant_id=yyy
  const code = params.get('code');
  const email = params.get('email');
  const sessionId = params.get('session_id');
  const tenantId = params.get('tenant_id');

  const [state, setState] = useState<VerifyState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const attempted = useRef(false);

  // ── Determine where to redirect after success ──
  const getReturnUrl = useCallback((): string => {
    try {
      const stored = localStorage.getItem(RETURN_TO_KEY);
      if (stored) {
        localStorage.removeItem(RETURN_TO_KEY);
        return stored;
      }
    } catch { /* localStorage unavailable */ }
    return DEFAULT_RETURN;
  }, []);

  // ── Redirect helper ──
  const redirectToApp = useCallback(() => {
    const url = getReturnUrl();
    // Use replace so back-button doesn't land back on /verify-email
    window.location.replace(url);
  }, [getReturnUrl]);

  // ── Auto-verify when all query params are present ──
  useEffect(() => {
    if (attempted.current) return;
    if (!code || !email || !sessionId || !tenantId) return;

    attempted.current = true;
    setState('verifying');

    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/verify-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            code,
            session_id: sessionId,
            tenant_id: tenantId,
          }),
        });

        const data = await res.json();

        if (res.ok && data.success) {
          setState('success');

          // Persist verified state so the widget recognizes it
          try {
            sessionStorage.setItem(`gomomo_verified_${sessionId}`, 'true');
          } catch { /* sessionStorage unavailable */ }

          // Redirect after a brief success flash
          setTimeout(redirectToApp, REDIRECT_DELAY_MS);
        } else {
          setState('error');
          setErrorMsg(data.error || 'Verification failed. The code may have expired.');
        }
      } catch {
        setState('error');
        setErrorMsg('Unable to reach the server. Please check your connection and try again.');
      }
    })();
  }, [code, email, sessionId, tenantId, redirectToApp]);

  // ── Handle manual "Return to chat" click ──
  const handleReturn = useCallback(() => {
    redirectToApp();
  }, [redirectToApp]);

  // ── Render states ──
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="w-full max-w-md text-center">

        {/* ── IDLE: missing params → show explanation ── */}
        {state === 'idle' && (
          <>
            <div className="mb-6 text-5xl">📧</div>
            <h1 className="mb-3 text-2xl font-bold">Email Verification</h1>
            {(!code || !email || !sessionId || !tenantId) ? (
              <>
                <p className="mb-6 text-[var(--text-muted)]">
                  It looks like some verification details are missing. Please use the
                  link from your email or return to the chat and enter your code directly.
                </p>
                <button onClick={handleReturn} className={btnClass}>
                  Return to chat →
                </button>
              </>
            ) : (
              <p className="text-[var(--text-muted)]">
                Preparing verification…
              </p>
            )}
          </>
        )}

        {/* ── VERIFYING ── */}
        {state === 'verifying' && (
          <>
            <div className="mb-6 text-5xl animate-pulse">⏳</div>
            <h1 className="mb-3 text-2xl font-bold">Verifying your email…</h1>
            <p className="text-[var(--text-muted)]">
              Hang tight — this only takes a moment.
            </p>
          </>
        )}

        {/* ── SUCCESS ── */}
        {state === 'success' && (
          <>
            <div className="mb-6 text-5xl">✅</div>
            <h1 className="mb-3 text-2xl font-bold text-[var(--green)]">
              Email verified!
            </h1>
            <p className="mb-6 text-[var(--text-muted)]">
              Redirecting you back to the conversation…
            </p>
            <button onClick={handleReturn} className={btnClass}>
              Go now →
            </button>
          </>
        )}

        {/* ── ERROR ── */}
        {state === 'error' && (
          <>
            <div className="mb-6 text-5xl">❌</div>
            <h1 className="mb-3 text-2xl font-bold">Verification failed</h1>
            <p className="mb-6 text-[var(--text-muted)]">
              {errorMsg}
            </p>
            <button onClick={handleReturn} className={btnClass}>
              Return to chat →
            </button>
          </>
        )}
      </div>
    </main>
  );
}

// ── Shared button class ──

const btnClass = [
  'inline-flex items-center gap-2 rounded-lg',
  'bg-[var(--accent)] px-5 py-2.5',
  'text-sm font-semibold text-white',
  'transition-colors hover:bg-[var(--accent-hover)]',
].join(' ');

// ── Page (Suspense boundary required for useSearchParams) ──

export default function VerifyEmailPage() {
  return (
    <>
      <Header />
      <Suspense
        fallback={
          <main className="flex min-h-[60vh] items-center justify-center px-6">
            <div className="text-center">
              <div className="mb-6 text-5xl animate-pulse">⏳</div>
              <h1 className="mb-3 text-2xl font-bold">Loading…</h1>
            </div>
          </main>
        }
      >
        <VerifyEmailInner />
      </Suspense>
      <Footer />
    </>
  );
}
