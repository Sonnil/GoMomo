// ============================================================
// useRecaptcha — reCAPTCHA v3 token acquisition hook
//
// Loads the reCAPTCHA v3 script on demand (only when enabled)
// and provides an `executeRecaptcha(action)` function that
// returns a token string, or null if disabled/unavailable.
//
// Usage:
//   const { executeRecaptcha } = useRecaptcha();
//   const token = await executeRecaptcha('submit_intake');
// ============================================================

import { useRef, useCallback, useEffect } from 'react';

const SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY || '';
const ENABLED = import.meta.env.VITE_RECAPTCHA_ENABLED === 'true' && !!SITE_KEY;

// Singleton — prevent loading the script twice
let scriptLoaded = false;
let scriptPromise: Promise<void> | null = null;

function loadRecaptchaScript(): Promise<void> {
  if (scriptLoaded) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${SITE_KEY}`;
    script.async = true;
    script.onload = () => { scriptLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load reCAPTCHA script'));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export function useRecaptcha() {
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Pre-load the script when enabled so it's ready before first submit
    if (ENABLED) loadRecaptchaScript().catch(() => {});
    return () => { mounted.current = false; };
  }, []);

  /**
   * Execute reCAPTCHA and return a token.
   * Returns `null` when reCAPTCHA is disabled or unavailable.
   */
  const executeRecaptcha = useCallback(async (action: string): Promise<string | null> => {
    if (!ENABLED) return null;

    try {
      await loadRecaptchaScript();
      const grecaptcha = (window as any).grecaptcha;
      if (!grecaptcha?.execute) return null;

      const token: string = await new Promise((resolve, reject) => {
        grecaptcha.ready(() => {
          grecaptcha.execute(SITE_KEY, { action }).then(resolve).catch(reject);
        });
      });
      return token;
    } catch {
      return null;
    }
  }, []);

  return { executeRecaptcha, isEnabled: ENABLED };
}
