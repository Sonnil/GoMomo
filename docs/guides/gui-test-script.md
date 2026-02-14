# 🖥️ GUI-Only Test Script

> **gomomo.ai** — full manual test using only the browser.
> Zero terminal commands, zero API tools, zero database inspection.

---

## Prerequisites

Before you start, your stack should be running. Ask a developer to:

```
docker compose up --build -d
docker compose exec backend npx tsx src/db/seed.ts
```

Then verify by opening: **http://localhost:3000/health**
→ You should see: `{ "status": "ok", "timestamp": "..." }`

---

## URLs to Open

| Purpose | URL | Notes |
|---------|-----|-------|
| **Full-featured test widget** | `http://localhost:5173?demo=1` | Polished Bloom Wellness UI with toasts + session banner |
| **Minimal test widget** | `http://localhost:5173` | Basic chat widget (same AI, simpler UI) |
| **Health check** | `http://localhost:3000/health` | Quick "is backend alive?" check |

> **Use `?demo=1` for all tests below.** It has the toast notifications, quick-action chips, session banner, and Bloom Wellness branding.

---

## Visual Indicators Reference

Before testing, know what to watch for:

| Indicator | Location | Meaning |
|-----------|----------|---------|
| 🟢 Green dot + "Online" | Chat header | Backend connected |
| 🟡 Amber dot + "Connecting…" | Chat header | Backend not reachable |
| **Session banner** (tiny text above header) | Top of widget | Shows: Tenant name, Session ID, Live/Connecting |
| ✅ **Green toast** (top-right) | Fixed overlay | Booking confirmed — shows reference code |
| ❌ **Red toast** (top-right) | Fixed overlay | Slot unavailable or system error |
| ⚠️ **Amber toast** (top-right) | Fixed overlay | Hold expired or disconnection |
| ℹ️ **Blue toast** (top-right) | Fixed overlay | Booking cancelled |
| 🌸 Typing dots | Message area | AI is processing your message |
| Quick-action chips | Below first message | Shortcut buttons for common actions |

---

## Test A — Happy-Path Booking

**Goal:** Book an appointment end-to-end and see visual confirmation.

| Step | What to Do | What You Should See | Pass / Fail |
|------|-----------|---------------------|-------------|
| A1 | Open `http://localhost:5173?demo=1` | ① Page loads with Bloom Wellness branding ② Session banner shows `Tenant: Bloom Wellness · Session: <id> · Live` ③ 🟢 Online status in header ④ Quick-action chips visible | ☐ |
| A2 | Click the **"📅 Book an appointment"** chip | ① Your message "Book an appointment" appears as a purple user bubble ② 🌸 Typing indicator appears ③ AI responds asking which service you'd like | ☐ |
| A3 | Type: `I'd like a Follow-up Visit` and press Enter | AI asks for your preferred date/time | ☐ |
| A4 | Type: `Tomorrow at 10am` and press Enter | ① AI calls check_availability (you'll see typing dots) ② AI responds with available slots including times around 10am ③ If 10am is available, it offers to hold it. If not, it suggests nearby times. | ☐ |
| A5 | Type: `Yes, that works` (or pick a suggested time) | ① AI says it has placed a **5-minute hold** on the slot ② AI asks for your **full name** | ☐ |
| A6 | Type: `Jane Smith` and press Enter | AI asks for your **email address** | ☐ |
| A7 | Type: `jane@test.com` and press Enter | AI asks if you'd like to add any **notes** or if everything looks correct (a confirmation summary) | ☐ |
| A8 | Type: `No notes, please confirm` and press Enter | ① AI responds with a **confirmation message** including: a reference code like `APT-XXXX`, date, time, service name ② ✅ **GREEN TOAST** appears top-right: "Booking Confirmed — Reference: APT-XXXX" | ☐ |

**Pass criteria:** Green toast appeared with reference code. AI message contains all booking details.

---

## Test B — Overbooking Attempt (Two Windows)

**Goal:** Prove that two people cannot book the same slot.

| Step | What to Do | What You Should See | Pass / Fail |
|------|-----------|---------------------|-------------|
| B1 | Open **Window 1**: `http://localhost:5173?demo=1` | Session banner shows a unique session ID | ☐ |
| B2 | Open **Window 2**: `http://localhost:5173?demo=1` (new tab or Incognito) | Session banner shows a **different** session ID | ☐ |
| B3 | In **Window 1**, type: `Book a Follow-up Visit for next Thursday at 2pm` | AI checks availability and responds with slot options | ☐ |
| B4 | In **Window 1**, confirm the slot: `Yes, hold that for me` | AI confirms a hold is placed. Asks for your name. | ☐ |
| B5 | **IMMEDIATELY** switch to **Window 2** and type: `Book a Follow-up Visit for next Thursday at 2pm` | ① AI checks availability ② The 2pm slot should **NOT** appear as available (it's on hold by Window 1) ③ AI suggests different times nearby | ☐ |
| B6 | In **Window 2**, try to insist: `I really need 2pm exactly` | ① AI should say the slot is not available / already reserved ② ❌ **RED TOAST** may appear: "Slot Unavailable" | ☐ |
| B7 | In **Window 1**, complete the booking: provide name `Alice Test`, email `alice@test.com`, confirm | ① AI confirms booking in Window 1 ② ✅ **GREEN TOAST** in Window 1 | ☐ |
| B8 | In **Window 2**, try again: `How about next Thursday at 2pm?` | AI confirms the slot is still not available (now it's a confirmed appointment, not just a hold) | ☐ |

**Pass criteria:** Window 2 was never able to book the same slot. No double-booking.

---

## Test C — Hold Expiration

**Goal:** Prove that an unfinished booking releases the slot after 5 minutes.

| Step | What to Do | What You Should See | Pass / Fail |
|------|-----------|---------------------|-------------|
| C1 | Open `http://localhost:5173?demo=1` | Widget loads, Online, session banner visible | ☐ |
| C2 | Type: `I want to book an Acupuncture Session for next Wednesday at 11am` | AI checks availability and offers 11am (or nearby time) | ☐ |
| C3 | Confirm: `Yes, hold 11am` | AI says the hold is placed (5-minute hold) and asks for your name | ☐ |
| C4 | **⏱️ DO NOTHING for 5 minutes.** Do not type. Just wait. | After 5 minutes, the hold expires server-side. Nothing visible happens yet. | ☐ |
| C5 | After waiting 5+ minutes, type: `My name is Chris Test` | ① AI may attempt to confirm but the hold has expired ② AI should tell you the hold has timed out or the slot needs to be re-reserved ③ ⚠️ **AMBER TOAST** may appear: "Hold Expired" | ☐ |
| C6 | Open a **NEW tab**: `http://localhost:5173?demo=1` | Fresh session | ☐ |
| C7 | In the new tab, type: `Book Acupuncture for next Wednesday at 11am` | The 11am slot **should now be available again** (hold expired, slot released) | ☐ |

**Pass criteria:** After 5 minutes, the abandoned hold is released and the slot becomes bookable again.

> **Tip:** If 5 minutes feels long, ask a developer to temporarily set `HOLD_TTL_MINUTES=1` in `.env` and restart the backend.

---

## Test D — Calendar Failure / System Error

**Goal:** Verify the AI handles backend failures gracefully.

> ⚠️ **This test requires a developer to toggle an environment variable**, then you observe results in the browser. This is the one test that needs minimal developer assistance to set up.

### Setup (developer does this once)

Tell your developer to run:
```
CALENDAR_FAIL_MODE=auth_error CALENDAR_SYNC_REQUIRED=true docker compose up -d --force-recreate backend
```

### Test Steps

| Step | What to Do | What You Should See | Pass / Fail |
|------|-----------|---------------------|-------------|
| D1 | Open `http://localhost:5173?demo=1` | Widget loads with Online status | ☐ |
| D2 | Type: `Book a Follow-up Visit for next Monday at 10am` | AI checks availability, offers slots normally (availability check doesn't hit calendar) | ☐ |
| D3 | Confirm a slot and provide: name `Error Test`, email `error@test.com`, confirm booking | ① AI tries to confirm the booking ② Booking **FAILS** because calendar sync is required but the calendar is simulating an auth error ③ AI says something like "I wasn't able to complete the booking" or "unable to sync with the calendar" ④ ❌ **RED TOAST** appears: "System Issue" | ☐ |
| D4 | Type: `Can you try again?` | AI should honestly say there's a system issue and suggest trying again later or calling directly | ☐ |

### Cleanup (developer does this)

Tell your developer to restore normal mode:
```
CALENDAR_FAIL_MODE=none docker compose up -d --force-recreate backend
```

### Verify Recovery

| Step | What to Do | What You Should See | Pass / Fail |
|------|-----------|---------------------|-------------|
| D5 | Refresh the page (Cmd+R) | Fresh session, Online status | ☐ |
| D6 | Book normally: `Book a Follow-up Visit for next Monday at 10am`, provide name and email, confirm | ① Booking succeeds ② ✅ **GREEN TOAST** appears with reference code | ☐ |

**Pass criteria:** During simulated failure, the AI never falsely confirms a booking. After fix, booking works normally.

---

## Test E — Reschedule Flow

**Goal:** Reschedule an existing booking using only the chat.

| Step | What to Do | What You Should See | Pass / Fail |
|------|-----------|---------------------|-------------|
| E1 | Open `http://localhost:5173?demo=1` | Widget loads | ☐ |
| E2 | Click the **"🔄 Reschedule"** chip | AI asks for your reference code or email | ☐ |
| E3 | Type the reference code from Test A (e.g., `APT-XXXX`) | AI looks up your booking and displays the current details (name, date, service) | ☐ |
| E4 | Type: `Move it to next Friday at 3pm` | ① AI checks availability for the new time ② If available, AI asks you to confirm the change | ☐ |
| E5 | Type: `Yes, please reschedule` | ① AI confirms the reschedule with new date/time ② ✅ **GREEN TOAST** appears: "Booking Rescheduled" | ☐ |

**Pass criteria:** AI showed old booking, confirmed new time, toast appeared.

---

## Test F — Cancel Flow

**Goal:** Cancel a booking using only the chat.

| Step | What to Do | What You Should See | Pass / Fail |
|------|-----------|---------------------|-------------|
| F1 | Open `http://localhost:5173?demo=1` | Widget loads | ☐ |
| F2 | Click the **"❌ Cancel booking"** chip | AI asks for your reference code or email | ☐ |
| F3 | Type the reference code (from Test A or E) | AI looks up your booking and shows the details | ☐ |
| F4 | AI asks: "Are you sure you want to cancel?" Type: `Yes, cancel it` | ① AI confirms the cancellation ② ℹ️ **BLUE TOAST** appears: "Booking Cancelled" | ☐ |

**Pass criteria:** AI confirmed cancellation. Blue toast appeared.

---

## Test G — Disconnect / Backend Down

**Goal:** Verify the widget shows clear feedback when the server is unreachable.

| Step | What to Do | What You Should See | Pass / Fail |
|------|-----------|---------------------|-------------|
| G1 | Open `http://localhost:5173?demo=1` and confirm "Online" | ✅ Connected | ☐ |
| G2 | Ask a developer to stop the backend: `docker compose stop backend` | ① 🟡 Amber dot appears: "Connecting…" ② Session banner changes to "Connecting" ③ ⚠️ **AMBER TOAST**: "Disconnected — Connection to server lost" | ☐ |
| G3 | Try to type a message | Send button should be **disabled** (greyed out). Nothing happens. | ☐ |
| G4 | Ask developer to restart: `docker compose start backend` | ① Within ~5 seconds, 🟢 Green dot reappears: "Online" ② Session banner shows "Live" again | ☐ |
| G5 | Type: `Hello` | AI responds normally — service restored | ☐ |

**Pass criteria:** Clear visual feedback during downtime. No silent failures.

---

## Summary Checklist

| Test | Scenario | Key Visual Indicators | Status |
|------|----------|----------------------|--------|
| A | Happy-path booking | ✅ Green toast with APT-XXXX | ☐ |
| B | Overbooking prevention | ❌ Red toast in Window 2, only Window 1 books | ☐ |
| C | Hold expiration | ⚠️ Amber toast, slot re-available after wait | ☐ |
| D | Calendar failure | ❌ Red toast, AI doesn't falsely confirm | ☐ |
| E | Reschedule | ✅ Green toast with new time | ☐ |
| F | Cancel | ℹ️ Blue toast confirming cancellation | ☐ |
| G | Backend disconnect | ⚠️ Amber toast, disabled input, auto-reconnect | ☐ |

---

## Known Limitations

| Limitation | Workaround |
|-----------|------------|
| **Test D** (calendar failure) requires a developer to toggle an env var and restart the backend | This is a one-time setup step — the actual test is done entirely in the browser |
| **Test C** requires waiting 5 minutes | Ask developer to set `HOLD_TTL_MINUTES=1` for faster testing |
| Toast notifications are triggered by **pattern-matching** the AI's response text | If the AI uses unusual wording, a toast might not fire. The chat text itself is always the source of truth. |
| No admin panel exists yet | All verification is through the chat conversation and toast notifications |

---

*Last updated: 2026-02-06*
