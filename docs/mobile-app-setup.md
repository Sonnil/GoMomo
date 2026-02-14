# Mobile App Setup — gomomo

Minimal React Native (Expo) app scaffold for the gomomo mobile experience.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 18 | `brew install node` or [nvm](https://github.com/nvm-sh/nvm) |
| Expo CLI | latest | comes via `npx expo` (no global install needed) |
| Xcode | ≥ 15 | Mac App Store (iOS simulator) |
| Android Studio | latest | [developer.android.com](https://developer.android.com/studio) (optional) |
| Expo Go | latest | App Store / Play Store (fastest way to preview) |

---

## Quick Start

```bash
# From repo root:
cd src/mobile
npm install

# Start Expo dev server:
npm start
# or from repo root:
npm run mobile:start
```

Scan the QR code with **Expo Go** (iOS/Android) to preview on a real device.

### Simulators

```bash
# iOS Simulator (requires Xcode):
npm run ios
# or from repo root:
npm run mobile:ios

# Android Emulator (requires Android Studio):
npm run android
# or from repo root:
npm run mobile:android
```

---

## Project Structure

```
src/mobile/
├── app/
│   ├── _layout.tsx          # Root Stack navigator
│   ├── verify-email.tsx     # Deep-link handler for email verification
│   └── (tabs)/
│       ├── _layout.tsx      # Bottom tab navigator (Agent + Settings)
│       ├── index.tsx        # Agent screen (placeholder + "Open gomomo.ai")
│       └── settings.tsx     # Settings (Privacy, Terms, Data Deletion links)
├── assets/
│   ├── icon.png             # App icon (1024×1024 recommended)
│   ├── splash.png           # Splash screen image
│   └── adaptive-icon.png    # Android adaptive icon foreground
├── app.json                 # Expo config (bundle IDs, scheme, deep links)
├── package.json
├── tsconfig.json
└── .gitignore
```

---

## How It Works

### External Links (NOT WebView)

All links open in the device's **external browser**, not a WebView:

| Tap | Opens |
|-----|-------|
| "Open gomomo.ai" button | `https://gomomo.ai` |
| Privacy Policy | `https://gomomo.ai/privacy` |
| Terms of Service | `https://gomomo.ai/terms` |
| Request Data Deletion | `https://gomomo.ai/data-deletion` |

This is intentional — the marketing site is responsive and works well in-browser.
The native app's value will come from the **embedded agent chat** in a future phase.

### Deep Links

The app registers two deep link mechanisms:

1. **Custom scheme:** `gomomo://verify-email?code=...&email=...`
2. **Universal Links (iOS):** `https://gomomo.ai/verify-email?...`
3. **App Links (Android):** `https://gomomo.ai/verify-email?...`

Configuration is in `app.json` → `scheme`, `ios.associatedDomains`, and
`android.intentFilters`.

For Universal/App Links to work in production, the web server must serve:
- `/.well-known/apple-app-site-association` (iOS) — already in `src/web/public/`
- `/.well-known/assetlinks.json` (Android) — already in `src/web/public/`

Both need real Team ID / SHA256 fingerprint values before they'll work.

---

## App Identifiers

| Platform | Identifier |
|----------|-----------|
| iOS Bundle ID | `ai.gomomo.app` |
| Android Package | `ai.gomomo.app` |
| URL Scheme | `gomomo://` |

---

## Store Submission Checklist

Before submitting to App Store / Play Store:

- [ ] Replace placeholder icons with real brand assets (1024×1024 icon, 1284×2778 splash)
- [ ] Set `TEAM_ID` in `.well-known/apple-app-site-association`
- [ ] Set SHA256 fingerprint in `.well-known/assetlinks.json`
- [ ] Set up push notifications (Expo Push + backend integration)
- [ ] Add embedded agent chat to Agent screen
- [ ] Set up EAS Build: `npx eas-cli build:configure`
- [ ] Create App Store Connect / Google Play Console listings
- [ ] Write App Store privacy nutrition labels (matches `/privacy` page)
- [ ] Test on real devices (not just simulator)

---

## Future Phases

| Phase | What |
|-------|------|
| **2A** | Embed agent chat natively in Agent screen (WebSocket to backend) |
| **2B** | Push notifications for appointment confirmations + reminders |
| **2C** | Biometric lock (Face ID / fingerprint) for business accounts |
| **2D** | Offline-first: cache recent conversations |

---

## Troubleshooting

### "Cannot find module" errors in VS Code
Run `npm install` in `src/mobile/` — TypeScript needs `node_modules` for types.

### Expo Go can't connect
Ensure your phone and laptop are on the same Wi-Fi network. Try `npm start -- --tunnel`.

### iOS build fails
Run `npx expo prebuild --platform ios` to generate the native project, then open
`ios/gomomo.xcworkspace` in Xcode.
