# Date-Distance Confirmation Guardrail — Example Transcript

Demonstrates the agent's behavior when a user requests a booking date more than 30 days in the future. The agent confirms the far-out date before placing a hold.

**Configurable via:** `BOOKING_FAR_DATE_CONFIRM_DAYS` (default: 30, set to 0 to disable)

---

## Transcript: Far-Future Booking with Date Confirmation

> **Scenario:** Today is February 7, 2026. The user asks for an appointment on April 15 — 67 days out, well beyond the 30-day threshold.

```
USER:  Hi, I'd like to book a wellness consultation for April 15th.

AGENT: One moment — I'm checking the schedule…

       [calls check_availability for April 15]

AGENT: I have a few openings on April 15th:
       • 9:00 AM
       • 11:00 AM
       • 2:30 PM

       Just to confirm — you're looking to book for Wednesday,
       April 15, 2026. That's about 10 weeks out. Is that right?

USER:  Yes, that's correct — I'm planning ahead!

AGENT: Great, I love the planning! Let me hold 2:30 PM for you.
       Which time would you prefer?

USER:  2:30 PM works.

AGENT: Perfect — holding 2:30 PM on April 15.

       [calls hold_slot for April 15 at 2:30 PM]

AGENT: Got it — 2:30 PM is held for the next 5 minutes.
       Could I get your full name and email address?

USER:  Jordan Wells, jordan@example.com

       [calls confirm_booking]

AGENT: You're all set — your appointment is confirmed!
       📋 Reference: APT-4W28KQ
       📅 Wednesday, April 15, 2026 at 2:30 PM
       🩺 Service: Wellness Consultation

       See you in April, Jordan!
```

**Key behaviors shown:**
- ✅ `check_availability` was called first (allowed — the guardrail only blocks `hold_slot`)
- ✅ Agent presented available times from the tool output
- ✅ Before calling `hold_slot`, agent asked: *"Just to confirm — you're looking to book for April 15, 2026. That's about 10 weeks out. Is that right?"*
- ✅ Waited for user's explicit "yes" before placing the hold
- ✅ "confirmed" only said after `confirm_booking` returned success

---

## Transcript: User Catches a Mistake via the Guardrail

> **Scenario:** The user says "March" but meant next week. The guardrail catches it.

```
USER:  Can I get an appointment for March 20th?

AGENT: One moment — I'm checking the schedule…

       [calls check_availability for March 20]

AGENT: March 20 looks good — here are the open slots:
       • 10:00 AM
       • 1:00 PM
       • 3:30 PM

       Just to confirm — you're looking to book for Friday,
       March 20, 2026. That's about 6 weeks from now.
       Is that right?

USER:  Oh wait, no — I meant this coming Friday, February 13th!

AGENT: No problem! Let me check February 13th instead.
       One moment — I'm checking the schedule…

       [calls check_availability for Feb 13]

AGENT: Here's what's open on Friday, Feb 13:
       • 9:00 AM
       • 10:30 AM
       • 2:00 PM
       • 4:00 PM

       Which time works for you?

USER:  10:30 AM.

AGENT: Holding 10:30 AM for you now.

       [calls hold_slot — no date-distance guardrail needed,
        Feb 13 is only 6 days away]

       …continues with normal booking flow…
```

**Key behaviors shown:**
- ✅ Guardrail fired for March 20 (41 days out > 30-day threshold)
- ✅ User caught their own mistake thanks to the confirmation question
- ✅ Agent gracefully re-checked the corrected date
- ✅ No guardrail for Feb 13 (within 30 days) — proceeded directly to `hold_slot`

---

## Transcript: Near-Date Booking — Guardrail Does NOT Fire

> **Scenario:** User requests next Monday (3 days away). No confirmation needed.

```
USER:  I'd like to book something for next Monday.

AGENT: One moment — I'm checking the schedule…

       [calls check_availability for Monday Feb 9]

AGENT: Monday has plenty of openings:
       • 9:00 AM
       • 10:30 AM
       • 1:00 PM
       • 3:00 PM
       • 4:30 PM

       Which time would you prefer?

USER:  1 PM.

AGENT: Let me hold that for you.

       [calls hold_slot for Mon 1:00 PM — no guardrail,
        only 2 days away]

AGENT: 1:00 PM is held! Could I get your name and email?

       …continues with normal booking flow…
```

**Key behaviors shown:**
- ✅ Monday is 2 days away — well within the 30-day threshold
- ✅ Agent went straight to `hold_slot` without extra confirmation
- ✅ Guardrail is invisible when it doesn't apply — no unnecessary friction

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `BOOKING_FAR_DATE_CONFIRM_DAYS` | `30` | Days threshold. Bookings beyond this many days require explicit user confirmation before hold. |
| Set to `0` | — | Disables the guardrail entirely. |
| Set to `14` | — | Tighter window — confirms any booking more than 2 weeks out. |
| Set to `90` | — | Looser window — only confirms bookings 3+ months out. |
