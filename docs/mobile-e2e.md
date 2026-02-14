# Mobile E2E Testing Guide — Phase Mobile-1

> Covers the **Agent chat tab** and **email gate** flow on iOS Simulator,
> Android Emulator, and physical devices.

---

## Prerequisites

| Tool           | Version       | Install                                   |
| -------------- | ------------- | ----------------------------------------- |
| Node.js        | ≥ 18          | `brew install node`                       |
| Expo CLI       | latest        | `npx expo --version` (bundled with `expo`) |
| Xcode          | ≥ 15          | Mac App Store (iOS testing only)          |
| Android Studio | ≥ Hedgehog    | https://developer.android.com/studio      |
| Watchman       | latest        | `brew install watchman` (recommended)     |

### Backend environment variables (in `src/backend/.env`)

```env
# Both default to "true" — confirm they are set:
REQUIRE_EMAIL_AFTER_FIRST_MESSAGE=true
EMAIL_DEV_MODE=true
```

- `REQUIRE_EMAIL_AFTER_FIRST_MESSAGE=true` → the email gate fires after
  the visitor's **2nd message** (1st goes through ungated).
- `EMAIL_DEV_MODE=true` → the OTP verification code is:
  1. **Returned in the HTTP response** body of `POST /api/auth/request-code`
     (`{ "code": "123456" }`), which the mobile modal shows in a yellow
     **🧪 Dev code** banner.
  2. **Logged to the backend console** (search for `📧 Verification code`).

---

## 1 — Start the backend

```bash
cd src/backend
npm run dev          # Fastify starts on http://localhost:3000
```

Confirm health:

```bash
curl http://localhost:3000/health | jq .
```

You should see `"status": "healthy"` and `"email_gate_enabled": true`.

---

## 2 — Configure `backendBaseUrl`

The mobile app reads the URL from `src/mobile/app.json → expo.extra.backendBaseUrl`.

| Target                    | Value to set                                    |
| ------------------------- | ----------------------------------------------- |
| **iOS Simulator**         | `http://localhost:3000` *(default — no change)* |
| **Android Emulator**      | `http://10.0.2.2:3000`                          |
| **Physical device (LAN)** | `http://<YOUR_LAN_IP>:3000`                     |

### Finding your LAN IP (macOS)

```bash
ipconfig getifaddr en0
# e.g. 192.168.1.42  →  set backendBaseUrl to "http://192.168.1.42:3000"
```

### Editing `app.json`

```jsonc
// src/mobile/app.json  (partial)
{
  "expo": {
    "extra": {
      "backendBaseUrl": "http://192.168.1.42:3000",  // ← change this
      "tenantId": "00000000-0000-4000-a000-000000000001"
    }
  }
}
```

> **Tip:** After changing `app.json`, restart the Metro bundler
> (`ctrl-C` then `npx expo start` again) so `expo-constants` picks
> up the new value.

---

## 3 — Install mobile dependencies

```bash
cd src/mobile
npm install
```

---

## 4 — Launch on iOS Simulator

```bash
cd src/mobile
npx expo start --ios
```

Expo will:
1. Start Metro on `http://localhost:8081`.
2. Build the development client and launch it in the iOS Simulator.

> If the Simulator prompt asks for a device, choose **iPhone 15 Pro**
> or any iOS 17+ simulator.

---

## 5 — Launch on Android Emulator

Make sure an Android emulator is running (via Android Studio → AVD Manager),
then:

```bash
cd src/mobile
npx expo start --android
```

> **Important:** Set `backendBaseUrl` to `http://10.0.2.2:3000` in
> `app.json` before launching. The Android emulator maps `10.0.2.2`
> to the host machine's `localhost`.

---

## 6 — Launch on a physical device

1. Install **Expo Go** from the App Store (iOS) or Play Store (Android).
2. Set `backendBaseUrl` to your LAN IP (see § 2).
3. Ensure the phone and your Mac are on the **same Wi-Fi network**.
4. Start Metro:
   ```bash
   cd src/mobile
   npx expo start
   ```
5. Scan the QR code shown in the terminal with:
   - **iOS:** Camera app → tap the Expo banner
   - **Android:** Expo Go app → "Scan QR code"

> **Firewall:** Ensure port 3000 (backend) and 8081 (Metro) are open
> on your Mac's firewall.

---

## 7 — E2E Test Script

Run through these steps **on each target** (iOS Sim, Android Emu, device).

### A — Connection

| #  | Step                                          | Expected                                                    |
| -- | --------------------------------------------- | ----------------------------------------------------------- |
| 1  | Launch app                                    | "Connecting to agent…" spinner appears                      |
| 2  | Wait ~2 s                                     | Spinner disappears; empty state shows 💬 "Send a message…"  |
| 3  | Check backend logs                            | `[WS] Client joined session <uuid>`                         |

### B — First message (ungated)

| #  | Step                                          | Expected                                                    |
| -- | --------------------------------------------- | ----------------------------------------------------------- |
| 4  | Type "Hello" and tap ↑                        | User bubble (indigo) appears on the right                   |
| 5  | Wait for reply                                | "Agent is typing…" indicator → assistant bubble (dark) left  |
| 6  | Verify message content                        | Assistant replies with a greeting (depends on system prompt) |

### C — Email gate (2nd message)

| #  | Step                                          | Expected                                                    |
| -- | --------------------------------------------- | ----------------------------------------------------------- |
| 7  | Type "Book a haircut" and tap ↑               | User bubble appears, then the **email gate modal** slides up |
| 8  | Modal shows                                   | "Continue with your email" title, email input, newsletter toggle |
| 9  | Leave email empty, tap "Send verification code" | Red error: "Please enter your email."                      |
| 10 | Enter `test@example.com`, tap "Send verification code" | Modal advances to step 2 ("Enter verification code")  |
| 11 | Check for dev code                            | Yellow **🧪 Dev code: XXXXXX** banner appears in the modal  |

### D — OTP verification

| #  | Step                                          | Expected                                                    |
| -- | --------------------------------------------- | ----------------------------------------------------------- |
| 12 | Enter the 6-digit dev code shown in the banner | Digits appear in centered OTP field                        |
| 13 | Tap "Verify"                                  | Modal dismisses                                             |
| 14 | Check chat                                    | System message: "✅ Email verified — you're all set!"       |
| 15 | Verify gated message auto-resent              | A second user bubble "Book a haircut" appears, followed by the assistant's response |

### E — Post-verification chat

| #  | Step                                          | Expected                                                    |
| -- | --------------------------------------------- | ----------------------------------------------------------- |
| 16 | Send "What times are available?"              | Normal assistant reply — no gate modal                      |
| 17 | Send 3 more messages                          | All flow normally; no further gate interruptions            |

### F — Error & reconnect

| #  | Step                                          | Expected                                                    |
| -- | --------------------------------------------- | ----------------------------------------------------------- |
| 18 | Stop the backend (`ctrl-C` in its terminal)   | Red banner: "Connection lost. Tap to reconnect."            |
| 19 | Restart the backend                           | Tap the red banner                                          |
| 20 | Wait for reconnect                            | "Connecting to agent…" → banner clears → connected          |
| 21 | Send a message after reconnect                | Normal response                                             |

### G — Settings tab (no WebViews)

| #  | Step                                          | Expected                                                    |
| -- | --------------------------------------------- | ----------------------------------------------------------- |
| 22 | Tap the "Settings" tab                        | Settings screen: Legal section + About section              |
| 23 | Tap "Privacy Policy"                          | **External browser** opens `https://gomomo.ai/privacy`      |
| 24 | Tap back to app, tap "Terms of Service"       | External browser opens `https://gomomo.ai/terms`            |
| 25 | Tap "Request Data Deletion"                   | External browser opens `https://gomomo.ai/data-deletion`    |
| 26 | Tap "Visit gomomo.ai"                         | External browser opens `https://gomomo.ai`                  |

### H — Session persistence

| #  | Step                                          | Expected                                                    |
| -- | --------------------------------------------- | ----------------------------------------------------------- |
| 27 | Force-quit the app (swipe up)                 | App closes                                                  |
| 28 | Re-open the app                               | Connects immediately (no "expired" error)                   |
| 29 | Send a message                                | Normal response — session still valid (4-hour TTL)          |

### I — Booking flow (happy path)

> **Prerequisites:**
> - Backend running with a valid Google Calendar integration for the default tenant, **or**
>   calendar stubbed to return availability (see § 9 troubleshooting).
> - Email gate already passed (steps 7-12 above).

| #  | Step                                                                                       | Expected                                                                                                              |
| -- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 30 | Send: **"I'd like to book a haircut tomorrow at 2pm"**                                     | Status chip "Agent is working on it…" appears while tools run                                                         |
| 31 | Wait for assistant reply                                                                   | Assistant asks for remaining details (name, email, phone) or confirms availability                                    |
| 32 | Send: **"My name is Test User, email test@example.com, phone 555-123-4567"**               | Status chip → assistant confirms booking in natural language                                                          |
| 33 | Observe the assistant message                                                              | Text bubble with confirmation wording **plus** a **green BookingConfirmationCard** below it                           |
| 34 | Inspect the BookingConfirmationCard                                                        | ✅ "Booking Confirmed" header; 📅 date/time; 🌐 timezone; 💇 service (if provided); 👤 name; 🔖 reference code badge |
| 35 | Tap **"📆 Add to Calendar"** button on the card                                            | External browser (or Google Calendar app) opens with pre-filled event details                                         |
| 36 | Return to the app                                                                          | Chat screen still visible; no crash or disconnect                                                                     |

### J — Booking flow (calendar failure)

> **Prerequisite:** Disconnect or misconfigure the calendar integration so the
> backend returns a `CalendarReadError`. For example, revoke the Google OAuth
> token or set `GOOGLE_CALENDAR_ID` to a non-existent calendar.

| #  | Step                                                                                       | Expected                                                                                                              |
| -- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 37 | Send: **"Book me an appointment tomorrow at 3pm"**                                         | Status chip while tools run                                                                                           |
| 38 | Wait for assistant reply                                                                   | Reply contains calendar-failure language (e.g., "calendar read failed" or "calendar is not connected")                |
| 39 | Observe the message area                                                                   | **Amber BookingFailureBanner** replaces the normal text bubble                                                        |
| 40 | Inspect the banner                                                                         | 📅 "Calendar not available" title; body: "This business hasn't connected a calendar yet. Please call or visit…"       |

### K — Booking flow (generic booking error)

> **Prerequisite:** Induce a generic booking error (e.g., return a 500 from a
> downstream service, or set an invalid service ID in the tenant config).

| #  | Step                                                                                       | Expected                                                                                                              |
| -- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 41 | Attempt a booking that triggers a generic error                                            | Status chip while tools run                                                                                           |
| 42 | Wait for assistant reply                                                                   | Reply contains error language (e.g., "something went wrong" + "booking")                                              |
| 43 | Observe the message area                                                                   | **Amber BookingFailureBanner** with ⚠️ "Booking couldn't be completed" title                                          |
| 44 | Body text                                                                                  | "Something went wrong with the booking. Please try again or contact the business directly."                           |

### Booking — Common failure modes

| Symptom                                      | Likely cause                                              | Fix / workaround                                                                     |
| -------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| No green card after confirmed booking        | Backend didn't return `booking_data` in meta              | Check `chat-handler.ts` capture logic; confirm `confirm_booking` tool succeeded      |
| "Add to Calendar" does nothing               | `add_to_calendar_url` is `undefined`                      | Check `buildGoogleCalendarUrl()` and that the tool result includes the URL           |
| Amber banner shows for successful bookings   | False-positive pattern match in `isCalendarFailure()`     | Review the assistant's response text for trigger phrases like "calendar"             |
| No banner for actual calendar failures       | LLM phrased the error differently than expected patterns  | Add the new phrase to `isCalendarFailure()` or `isBookingError()` in the banner file |
| Card shows "N/A" for all fields              | `booking_data` object exists but fields are `undefined`   | Inspect the raw tool result in backend logs (`LOG_LEVEL=debug`)                      |

---

## 8 — Finding the OTP code

When `EMAIL_DEV_MODE=true`, you have **two ways** to get the OTP:

### Method 1 — In-app banner (easiest)

After entering your email and tapping "Send verification code", a yellow
banner appears at the top of the code step:

```
🧪 Dev code: 847291
```

Just type that code into the input field.

### Method 2 — Backend console logs

In the terminal running the backend, search for:

```
📧 Verification code for test@example.com: 847291
```

The code is also returned in the JSON response:

```bash
curl -s -X POST http://localhost:3000/api/auth/request-code \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","session_id":"<SID>","tenant_id":"00000000-0000-4000-a000-000000000001"}' \
  | jq .code
```

---

## 9 — Troubleshooting

| Symptom                           | Fix                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| "Connecting…" never completes     | Check `backendBaseUrl` matches your target (§ 2). Verify backend is running.         |
| "Network request failed"          | Physical device? Ensure same Wi-Fi + firewall open on ports 3000 & 8081.             |
| Android can't reach backend       | Use `http://10.0.2.2:3000`, **not** `localhost`.                                      |
| No dev code banner                | Confirm `EMAIL_DEV_MODE=true` in `src/backend/.env`. Restart backend after changing. |
| Gate doesn't trigger              | Confirm `REQUIRE_EMAIL_AFTER_FIRST_MESSAGE=true` in `.env`. Send a **2nd** message.  |
| Metro won't start                 | Run `npx expo start --clear` to reset the bundler cache.                             |
| `tsc` errors after `npm install`  | Run `cd src/mobile && npx tsc --noEmit`. Should be 0 errors.                         |

---

## 10 — Networking quick-reference

| Target              | `backendBaseUrl`            | Notes                                |
| ------------------- | --------------------------- | ------------------------------------ |
| iOS Simulator       | `http://localhost:3000`     | Shares host network                  |
| Android Emulator    | `http://10.0.2.2:3000`     | Special alias for host loopback      |
| Physical iOS device | `http://<LAN_IP>:3000`     | Same Wi-Fi required                  |
| Physical Android    | `http://<LAN_IP>:3000`     | Same Wi-Fi required                  |
| Expo Tunnel         | Auto-provided URL           | `npx expo start --tunnel` (fallback) |
