# Feature 2 — "I'll text/email you options shortly" — GUI Test Script

## Prerequisites

1. **Backend running** — `npm run dev` (or `node src/backend/dist/server.js`)
2. **Frontend running** — `npm run dev:frontend` (or Vite at http://localhost:5173)
3. **Database seeded** — `npx tsx src/backend/src/db/seed.ts`
   - Re-seed after this feature to pick up the new `send_contact_followup` policy rules
4. **DEMO_AVAILABILITY=true** (recommended — guarantees Mon–Fri 9–5 ET availability)
5. **AUTONOMY_ENABLED=true** (recommended — enables job runner processing)

---

## Test A — No Availability → Follow-up via Email

**Goal:** When all slots are taken / none match, the agent offers a follow-up contact.

| # | Action | Expected |
|---|--------|----------|
| 1 | Open the Demo Chat widget at http://localhost:5173 | Widget loads, "Live" indicator shows |
| 2 | Type: *"I'd like to book an acupuncture session next Sunday"* | Agent calls `check_availability` — Sunday is closed, returns 0 slots |
| 3 | Agent responds with no-availability message | Should mention no slots and offer waitlist **and/or** follow-up contact |
| 4 | Type: *"Yes, please contact me later with options"* | Agent asks for preferred contact method (email or text) |
| 5 | Type: *"Email is fine"* | Agent asks for name + email (or uses info already collected) |
| 6 | Type: *"Jane Doe, jane@example.com"* | Agent calls `schedule_contact_followup` → ⚙️ status chip appears briefly |
| 7 | Agent confirms | Response should include "I'll email you" + "shortly" / no exact time promise |
| 8 | **Check UI** | ✅ **Follow-up Scheduled** card appears below the message (green border, contact method: Email, timeframe: shortly) |
| 9 | **Check toast** | 🟢 Toast notification: "Follow-up Scheduled — You'll be contacted…" |
| 10 | **Check DB** (optional) | `SELECT * FROM jobs WHERE type = 'send_contact_followup' ORDER BY created_at DESC LIMIT 1;` → should show pending job with payload containing jane@example.com |

---

## Test B — User Explicitly Asks to Be Contacted via SMS

**Goal:** User initiates a follow-up request proactively, choosing SMS.

| # | Action | Expected |
|---|--------|----------|
| 1 | Click the **📩 Contact me later** quick action chip | Message sent: "Contact me later" |
| 2 | Agent responds | Should ask how you'd like to be contacted (email or text) |
| 3 | Type: *"Text me please, my number is +1-555-123-4567"* | Agent asks for name + email |
| 4 | Type: *"John Smith, john@example.com"* | Agent calls `schedule_contact_followup` with `preferred_contact: 'sms'` + phone |
| 5 | Agent confirms | Response: "I'll text you with available options shortly" |
| 6 | **Check UI** | ✅ **Follow-up Scheduled** card — Contact method: **SMS**, timeframe: **shortly** |
| 7 | **Check status chip** | ⚙️ "Scheduling follow-up in progress…" chip shown briefly during processing |

---

## Test C — Calendar Retry Scenario (Simulated)

**Goal:** After a booking with a calendar sync failure, the agent offers follow-up.

| # | Action | Expected |
|---|--------|----------|
| 1 | Book a normal appointment (go through full flow: check avail → hold → confirm) | Booking confirmed with reference code |
| 2 | If calendar sync fails (simulated via GOOGLE_CALENDAR_ID=invalid), agent may mention the calendar issue | Agent should offer a follow-up contact if the calendar retry is queued |
| 3 | Type: *"Can you email me when it's sorted?"* | Agent collects contact info → calls `schedule_contact_followup` with reason `calendar_retry_queued` |
| 4 | Confirm UI card appears | ✅ Follow-up Scheduled |

---

## Test D — Policy Denial (Edge Case)

**Goal:** Verify the policy engine can block follow-up contacts.

| # | Action | Expected |
|---|--------|----------|
| 1 | Manually insert a deny rule: `INSERT INTO policy_rules (tenant_id, action, effect, conditions, priority) VALUES (NULL, 'send_contact_followup', 'deny', '{}', 100);` | Higher priority deny rule |
| 2 | Try to trigger a follow-up (repeat Test A or B) | Agent should inform user the follow-up couldn't be scheduled |
| 3 | Response message | Should say something like "unable to schedule" or offer alternatives |
| 4 | **Cleanup:** Delete the deny rule afterwards | `DELETE FROM policy_rules WHERE action = 'send_contact_followup' AND effect = 'deny';` |

---

## Test E — Status Chip Behavior

**Goal:** Verify the ⚙️ status chip and async-job indicator work correctly.

| # | Action | Expected |
|---|--------|----------|
| 1 | Trigger a follow-up (Test A or B) | During processing: ⚙️ spinning gear + status text |
| 2 | After response arrives | Status chip clears, then briefly shows "Scheduling follow-up in progress…" for ~3s |
| 3 | Chip auto-clears | Status returns to normal after timeout |

---

## Test F — ChatWidget (Simpler Widget)

**Goal:** Ensure the simpler ChatWidget also shows the follow-up card.

| # | Action | Expected |
|---|--------|----------|
| 1 | Navigate to a page using `<ChatWidget tenantId="..." />` (or test via REST mode) | Widget loads |
| 2 | Trigger a follow-up flow (same as Test A) | Follow-up card appears with green styling |
| 3 | Card shows method + timeframe | Contact method: Email/SMS, Expected: shortly |

---

## Verification Checklist

- [ ] **Test A** — No-availability → email follow-up → card + toast
- [ ] **Test B** — User-initiated SMS follow-up → card with SMS method
- [ ] **Test C** — Calendar retry → follow-up offer
- [ ] **Test D** — Policy deny blocks follow-up gracefully
- [ ] **Test E** — Status chip spins during processing, auto-clears
- [ ] **Test F** — ChatWidget shows follow-up card
- [ ] **No exact time promises** — Agent never says "in 10 minutes" etc.
- [ ] **DB job created** — `jobs` table has `send_contact_followup` entries
- [ ] **Audit logged** — `audit_log` has `followup.scheduled` events
- [ ] **Notification outbox** — When job runner processes: `notification_outbox` has the follow-up message (if AUTONOMY_ENABLED=true)
- [ ] **Existing tests pass** — `npx vitest run` → 50/50 (or more)
