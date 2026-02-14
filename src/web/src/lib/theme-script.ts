/**
 * Inline script injected into <head> to prevent flash-of-wrong-theme (FOWT).
 *
 * Runs synchronously before first paint:
 *  1. Reads localStorage("gomomo_theme")
 *  2. Applies "dark" (default) or "light"
 *
 * This script is intentionally a plain string — NOT a React component —
 * so Next.js SSR renders it in the initial HTML payload.
 */

export const THEME_SCRIPT = `
(function(){
  try {
    var s = localStorage.getItem('gomomo_theme');
    var d = s === 'light' ? 'light' : 'dark';
    document.documentElement.classList.remove('light','dark');
    document.documentElement.classList.add(d);
    document.documentElement.style.colorScheme = d;
  } catch(e){}
})();
`.trim();
