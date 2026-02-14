# Mobile Readiness — gomomo.ai on iOS & Android

> Checklist-driven plan for shipping gomomo as a native-feeling mobile app.
> No time estimates — each phase ships when its exit criteria are met.

---

## Phase 1: Responsive Web + PWA

**Goal:** Installable from the browser with no app-store friction.

### Checklist

- [ ] Viewport meta + responsive breakpoints pass on 320px–428px (widget + marketing site)
- [ ] `manifest.json` with icons, `start_url`, `display: standalone` in `src/web/public/` and `src/frontend/public/`
- [ ] Service worker: offline shell + cache-first static assets (`next-pwa` / Vite PWA plugin)
- [x] HTTPS everywhere — HSTS + TLS enforced
- [ ] Lighthouse PWA audit ≥ 90 on both `/` and `/chat`
- [ ] Add-to-homescreen: `beforeinstallprompt` (Android) + manual iOS banner
- [ ] Splash screens + status-bar theming (`apple-mobile-web-app-*`, gomomo brand)
- [ ] Email verification deep-link opens correctly in standalone PWA mode (no double-browser)

### Exit Criteria

1. Both sites score ≥ 90 on Lighthouse PWA audit
2. Homescreen install confirmed on iOS 16+ Safari and Android 12+ Chrome
3. Email OTP flow completes end-to-end from standalone PWA (link opens in-app, session resumes)

### Readiness Gate → Phase 2

Phase 2 may not begin until **all** Phase 1 exit criteria are met and the PWA has been used in at least one pilot session on a real device.

---

## Phase 2: React Native Shell

**Goal:** App-store presence; WebView does the heavy lifting, native layer adds push + deep links + account management.

### Checklist

- [ ] Scaffold RN project under `src/mobile/` (mono-repo)
- [ ] `react-native-webview` loading `https://gomomo.ai/chat` with `postMessage` token bridge
- [ ] Deep links: `gomomo://chat`, `gomomo://booking/:id` — Universal Links (iOS) + App Links (Android)
- [ ] Email verification links: intercept `gomomo://verify?code=…` in native layer, inject code into WebView session so the user never leaves the app
- [ ] Push notifications (FCM / APNs): backend event bus → new push adapter
- [ ] Native settings screen (notification prefs, account deletion, privacy policy link)
- [ ] Native account management screen (view email, request data export, delete account)
- [ ] Biometric auth gate (FaceID / fingerprint) wrapping session-token flow
- [ ] Native splash screen + app icon (match PWA assets)
- [ ] OTA updates (`expo-updates` or CodePush) for JS-only changes

### Architecture

```
┌─────────────────────────┐
│   React Native Shell    │
│  ┌───────────────────┐  │
│  │  WebView (gomomo)  │  │  ← web chat + booking UI
│  └───────────────────┘  │
│  Push · Deep Links · Bio│  ← thin native layer
│  Settings · Account Mgmt│
└─────────────────────────┘
        ↕ postMessage
┌─────────────────────────┐
│  gomomo.ai backend      │  ← same Fastify API, no changes
└─────────────────────────┘
```

### Exit Criteria

1. App installs and launches on iOS 16+ and Android 12+ physical devices
2. Push notification delivered within 30 s of a booking confirmation
3. Deep link `gomomo://booking/:id` opens the correct booking from cold start
4. Email verification OTP completes without leaving the app
5. Account deletion flow triggers `DELETE /api/customers/:id` and confirms removal
6. Apple "minimum functionality" review checklist satisfied (see §App Store below)

### Readiness Gate → Store Submission

Store submission may not begin until **all** Phase 2 exit criteria are met, plus the compliance checklist below is complete.

---

## gomomo-Specific Considerations

### Email Verification Flow

The existing OTP email-gate (`POST /api/auth/request-code` → `POST /api/auth/verify-code`) needs mobile-aware handling:

- [x] **`/verify-email` route (Next.js):** dedicated verification landing page at `src/web/src/app/verify-email/page.tsx`. Accepts query params `?code=…&email=…&session_id=…&tenant_id=…`. When all four are present, auto-calls `POST /api/auth/verify-code` and shows Verifying → Success → redirect. When params are missing, shows an explanation with a "Return to chat" button.
- [x] **`returnTo` persistence:** when the EmailGateModal opens in the chat widget, the current URL (pathname + hash) is stored in `localStorage` under `gomomo_returnTo`. After verification, `/verify-email` reads this and redirects the user back. Survives app kill / tab close.
- [x] **`.well-known` placeholders:** `public/.well-known/apple-app-site-association` (iOS Universal Links) and `public/.well-known/assetlinks.json` (Android App Links) are in place with TODO markers for real credentials.
- [ ] **PWA standalone mode:** verification link must open inside the standalone window, not spawn a new Safari/Chrome tab. Use `scope` in `manifest.json` + `<a target="_self">`.
- [ ] **In-app browser (WebView):** intercept verification deep-link (`gomomo://verify?code=…`) at the native layer; inject the code into the WebView via `postMessage` so the user never leaves the app.
- [ ] **Session resume:** if the app is killed between requesting and entering the code, the session token must survive (persist to `AsyncStorage` / `SecureStore` and rehydrate on next launch).

#### How `/verify-email` works today

```text
┌─────────────────────────────────────────────────────────────┐
│  User clicks verification link (email / SMS / future deep link)  │
│                                                             │
│  https://gomomo.ai/verify-email                             │
│    ?code=123456                                             │
│    &email=user@example.com                                  │
│    &session_id=abc-123                                      │
│    &tenant_id=tenant-1                                      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │  All 4 params present? │
        └──────┬────────┬────────┘
           yes │        │ no
               ▼        ▼
       POST /api/auth   Show "missing params"
       /verify-code     + "Return to chat" button
               │
          ┌────┴────┐
          │ success? │
          └──┬───┬──┘
         yes │   │ no
             ▼   ▼
      ✅ "Email   ❌ "Verification
      verified!"   failed" + return
          │        button
          │
          ▼
     Redirect to
     localStorage(gomomo_returnTo)
     or /#try-it (default)
```

#### Future: deep-link mapping to `gomomo://`

When the React Native shell ships (Phase 2), email verification links will use:

```text
gomomo://verify?code=123456&email=…&session_id=…&tenant_id=…
```

The native layer will intercept this, parse the params, and inject them into the WebView's `/verify-email` page via `postMessage` — same flow, zero additional backend changes.

### Data Deletion Endpoint

- [ ] `DELETE /api/customers/:id` — must exist and actually purge PII (name, email, phone, chat history) from PostgreSQL. Required by both Apple and Google.
- [ ] Link to deletion flow from: native settings screen, app-store listing, and privacy policy.
- [ ] Respond with `202 Accepted` + confirmation email so the user has a receipt.

### PII Logging Policy

- [ ] Verify `console.log` / structured logs **never** emit raw email, phone, or full name. Use masked formats (`j***@example.com`, `+1***4567`).
- [ ] Audit `src/backend/src/` for PII in log lines before each store submission.
- [ ] Document the policy in `docs/pii-logging.md` (or add a section to the ops runbook).

### AI Disclosure

- [ ] Chat widget already shows "Responses generated by AI" footer — confirm it renders correctly in WebView at all breakpoints.
- [ ] App-store description must include: _"This app uses AI to answer questions and assist with bookings. Responses are generated by a language model and may not always be accurate."_
- [ ] If Apple's updated App Store guidelines require an AI/ML disclosure flag, set it in App Store Connect.

### Age Rating

- [ ] Target **4+ (iOS) / Everyone (Android)** — no user-generated content visible to other users, no in-app purchases, no violent/mature content.
- [ ] If a future vertical (e.g. wellness, alcohol service) changes this, update the rating before that release ships.

---

## App Store Compliance Checklist

### Apple — "Minimum Functionality" Risk

Apple rejects apps that are "just a WebView." To pass review, the native shell **must** include at least 3 of:

- [ ] Push notifications (booking confirmations, reminders)
- [ ] Native settings screen (notification prefs, account, privacy)
- [ ] Biometric authentication (FaceID / Touch ID)
- [ ] Deep-link routing (`gomomo://` scheme)
- [ ] Native account management (data export, deletion)
- [ ] Offline state handling (queued messages, graceful degradation)

> **Rule of thumb:** if the user can do everything the app does in Safari, Apple will reject it. The features above create a meaningful native experience.

### Apple — Additional

- [ ] Privacy Policy URL hosted at `https://gomomo.ai/privacy`
- [ ] App Privacy nutrition labels: name, email, phone (booking); chat messages (session-linked)
- [ ] `NSUserTrackingUsageDescription` — not needed unless IDFA analytics are added

### Google Play — Additional

- [ ] Data Safety section mirrors Apple privacy labels; declare encryption in transit
- [ ] Target latest Android SDK within one year of release
- [ ] Permission justification strings: microphone (voice calls), camera (future QR check-in)

### Shared

- [ ] Privacy policy at `/privacy` — linked from app settings + store listings
- [ ] Terms of service at `/terms`
- [ ] Data deletion flow wired end-to-end (see §Data Deletion above)
- [ ] AI disclosure in chat footer + store description
- [ ] Age rating set correctly
- [ ] Screenshots + store assets match current gomomo branding
