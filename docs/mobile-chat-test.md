# Mobile Chat — Manual Test Checklist

Phase Mobile-1: Native Agent tab with chat + email gate.

---

## Prerequisites

1. Backend running on port 3000:
   ```bash
   cd src/backend && npm run dev
   ```
2. Mobile app running:
   ```bash
   cd src/mobile && npm start
   # Scan QR with Expo Go, or press 'i' for iOS Simulator
   ```

---

## Networking: Simulator vs Physical Device

| Environment | `backendBaseUrl` in `app.json` | Notes |
|---|---|---|
| **iOS Simulator** | `http://localhost:3000` | Shares host network — works as-is |
| **Android Emulator** | `http://10.0.2.2:3000` | Android's alias for host `localhost` |
| **Physical device (LAN)** | `http://YOUR_LAN_IP:3000` | Find via `ifconfig \| grep 192` |
| **Expo Go tunnel** | Your tunnel URL | Run `npx expo start --tunnel` |

To change the backend URL, edit `src/mobile/app.json`:
```json
"extra": {
  "backendBaseUrl": "http://192.168.1.42:3000",
  "tenantId": "00000000-0000-4000-a000-000000000001"
}
```

---

## Test Script

### 1. Connection & First Message

| # | Action | Expected |
|---|--------|----------|
| 1 | Launch app / navigate to Agent tab | "Connecting to agent…" spinner, then empty chat with "Send a message to get started" |
| 2 | Type "Hello" and tap Send (↑) | Message appears as indigo bubble (right side) |
| 3 | Wait for response | "Agent is typing…" indicator, then assistant reply appears (left, dark bubble) |
| 4 | Verify status chip | "Agent is working on it…" shows briefly during processing |

### 2. Email Gate (2nd Message)

| # | Action | Expected |
|---|--------|----------|
| 5 | Type "I'd like to book an appointment" and send | **Email gate modal** slides up from bottom |
| 6 | Verify modal content | Shows "Continue with your email", email input, newsletter toggle (on by default) |
| 7 | Enter email: `test@example.com` | Email populates in input |
| 8 | Tap "Send verification code" | Loading spinner, then modal switches to code entry step |
| 9 | **Dev mode**: check yellow banner | Should show "🧪 Dev code: XXXXXX" (only in dev, not production) |
| 10 | Enter the 6-digit code | Code input accepts only digits, max 6 |
| 11 | Tap "Verify" | Loading spinner, then: |
| | | ✅ Modal closes |
| | | ✅ System message "Email verified — you're all set!" |
| | | ✅ Your gated message re-sends automatically |
| | | ✅ Agent responds to the booking request |

### 3. Post-Verification Chat

| # | Action | Expected |
|---|--------|----------|
| 12 | Send another message ("What times are available?") | No gate — message goes through directly |
| 13 | Continue chatting | Full AI agent conversation works |

### 4. Error Handling

| # | Action | Expected |
|---|--------|----------|
| 14 | Stop the backend, then send a message | Error banner appears: "Connection lost. Tap to reconnect." |
| 15 | Start backend again, tap the error banner | Reconnects automatically |
| 16 | Enter invalid email in gate modal | Error: "Invalid email address" or similar |
| 17 | Enter wrong verification code | Error: "Invalid or expired verification code" |
| 18 | Tap "← Use a different email" in code step | Returns to email entry step |

### 5. Settings Tab (Regression)

| # | Action | Expected |
|---|--------|----------|
| 19 | Tap Settings tab | Settings screen with Privacy, Terms, Data Deletion rows |
| 20 | Tap "Privacy Policy" | Opens `https://gomomo.ai/privacy` in **device browser** (not WebView) |
| 21 | Tap "Terms of Service" | Opens `https://gomomo.ai/terms` in **device browser** |
| 22 | Tap "Request Data Deletion" | Opens `https://gomomo.ai/data-deletion` in **device browser** |

### 6. Session Persistence

| # | Action | Expected |
|---|--------|----------|
| 23 | Close and reopen the app | Session resumes (SecureStore persists token) — no re-auth needed within 4 hours |
| 24 | Wait 4+ hours (or clear SecureStore) | New session created automatically |

---

## Run Commands Summary

```bash
# Start backend
cd src/backend && npm run dev

# Start mobile (from repo root)
npm run mobile:start

# Or directly
cd src/mobile && npm start

# iOS Simulator
npm run mobile:ios

# Android Emulator
npm run mobile:android

# Type check
cd src/mobile && npm run typecheck
```
