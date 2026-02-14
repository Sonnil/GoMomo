/**
 * Agent avatar image for the AI receptionist.
 *
 * This is a base64-encoded PNG of a professional receptionist avatar.
 * To replace with a custom image:
 *   1. Place your image (PNG/JPG, ideally square 128×128 or larger) in this folder
 *   2. Import it in your build tool, or convert to base64 and update AGENT_AVATAR_URL below
 *
 * The avatar is used in two places:
 *   - The agent icon button in the input row (32×32)
 *   - Next to each assistant message bubble (24×24)
 */

// Professional receptionist avatar — SVG data URL (default placeholder)
// Replace this with a real image URL or base64 data URL
export const AGENT_AVATAR_URL = 'data:image/svg+xml,' + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <circle cx="64" cy="64" r="64" fill="#e0e7ff"/>
  <circle cx="64" cy="48" r="22" fill="#6366f1"/>
  <ellipse cx="64" cy="100" rx="36" ry="24" fill="#6366f1"/>
  <circle cx="64" cy="48" r="18" fill="#f5f3ff"/>
  <circle cx="57" cy="45" r="2.5" fill="#312e81"/>
  <circle cx="71" cy="45" r="2.5" fill="#312e81"/>
  <path d="M58 54 Q64 60 70 54" stroke="#312e81" stroke-width="2" fill="none" stroke-linecap="round"/>
  <path d="M38 42 Q44 20 84 20 Q90 42 86 46" stroke="#6366f1" stroke-width="3" fill="#6366f1" opacity="0.7"/>
  <rect x="82" y="40" width="14" height="10" rx="5" fill="#a5b4fc"/>
  <line x1="96" y1="45" x2="102" y2="45" stroke="#a5b4fc" stroke-width="2" stroke-linecap="round"/>
</svg>
`.trim());
