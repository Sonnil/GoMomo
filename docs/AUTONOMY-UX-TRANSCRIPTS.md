# Autonomy UX — Example Web Chat Transcripts

Three example conversations showing the new language patterns, deterministic guardrails, and proactive push notification handling.

---

## Transcript 1: "One moment — I'm checking the schedule…"

> **Pattern demonstrated:** Progress language while calling `check_availability`, deterministic slot presentation, confirmation only after `confirm_booking` success.

```
USER:  Hi, I'd like to book a consultation for next Tuesday.

AGENT: I'd be happy to help! Let me look into that.
       One moment — I'm checking the schedule…

       [calls check_availability for Tuesday]

AGENT: Here are the open slots for Tuesday:
       • 10:00 AM
       • 11:30 AM
       • 2:00 PM
       Which works best for you?

USER:  2 PM please.

AGENT: Great choice. Let me hold that for you while I grab your details.

       [calls hold_slot for 2:00 PM]

AGENT: Got it — 2:00 PM is held for the next 5 minutes.
       Could I get your full name and email address?

USER:  Jane Rivera, jane@example.com

AGENT: Thanks, Jane!

       [calls confirm_booking]

AGENT: You're all set — your appointment is confirmed!
       📋 Reference: APT-7X92K3
       📅 Tuesday, Feb 11 at 2:00 PM
       🩺 Service: Consultation

       Is there anything else I can help with?
```

**Key guardrails shown:**
- ✅ "One moment — I'm checking the schedule…" said *before* tool call
- ✅ Only times returned by `check_availability` were offered (10:00, 11:30, 2:00)
- ✅ "confirmed" only said *after* `confirm_booking` succeeded
- ✅ No fabricated reference code — came from tool response

---

## Transcript 2: "I'll follow up shortly with options" + Queued Job Fallback

> **Pattern demonstrated:** No availability → waitlist + follow-up contact → fallback SLA range wording (no exact time promised).

```
USER:  I need a teeth cleaning this Friday afternoon.

AGENT: One moment — I'm checking the schedule…

       [calls check_availability for Friday PM]

AGENT: Unfortunately, Friday afternoon is fully booked.
       I can do two things for you:
       1. Add you to our waitlist — if a Friday PM slot opens up, we'll let you know right away.
       2. I'll follow up shortly with options via text or email.
       Would you like both?

USER:  Yes please. Text me — my number is 555-0142.

AGENT: Got it. Could I get your full name and email as well?

USER:  Marcus Chen, marcus@example.com

       [calls create_inquiry — preferred_days: ["friday"],
        preferred_time_start: "12:00", preferred_time_end: "17:00"]

       [calls schedule_contact_followup — preferred_contact: "sms",
        client_phone: "+15550142", reason: "no_availability"]

AGENT: All set, Marcus! Here's what I've done:
       ✅ Added you to the Friday PM waitlist
       ✅ Scheduled a text follow-up with alternative options

       It usually takes a few minutes, but could be up to a couple of
       hours depending on how the schedule fills up.

       Is there anything else I can help with?

USER:  No, that's great. Thanks!

AGENT: You're welcome, Marcus! We'll be in touch soon. 😊
```

**Key guardrails shown:**
- ✅ "I'll follow up shortly with options" — no exact time promised
- ✅ Fallback range: "a few minutes…up to a couple of hours"
- ✅ Combined waitlist + follow-up (both tools called)
- ✅ Did NOT say "I'll text you in 10 minutes" or any specific SLA

---

## Transcript 3: "Good news — I found new openings!" (Push Notification Flow)

> **Pattern demonstrated:** User was previously waitlisted → system pushes a real-time notification with new slots → user clicks a slot → normal booking flow resumes, "confirmed" only after success.

```
── Earlier in the session ──

USER:  [was added to waitlist for Wednesday morning]

AGENT: You're on the waitlist for Wednesday morning.
       I'll follow up shortly with options if anything opens up!

── 20 minutes later ── a push notification appears in the chat ──

SYSTEM PUSH:
┌──────────────────────────────────────────┐
│  🔔 New slots available!                 │
│  Wednesday, Feb 12:                      │
│  [ 9:00 AM ]  [ 10:30 AM ]              │
│  Tap a time to book.                     │
└──────────────────────────────────────────┘

USER:  [clicks "9:00 AM"]

AGENT: Good news — I found new openings!
       Let me hold 9:00 AM on Wednesday for you.

       [calls hold_slot for Wed 9:00 AM]

AGENT: 9:00 AM is held — I just need to confirm your details.
       I have Marcus Chen and marcus@example.com on file.
       Shall I go ahead and book it?

USER:  Yes!

       [calls confirm_booking]

AGENT: You're all set — your appointment is confirmed!
       📋 Reference: APT-3M81QZ
       📅 Wednesday, Feb 12 at 9:00 AM
       🦷 Service: Teeth Cleaning

       See you Wednesday, Marcus!
```

**Key guardrails shown:**
- ✅ Push notification showed only slots from actual availability data
- ✅ "Good news — I found new openings!" used on push-originated flow
- ✅ Normal hold → confirm flow followed (no shortcut)
- ✅ "confirmed" only after `confirm_booking` returned success
- ✅ No fabricated reference code
- ✅ Prior waitlist context carried over naturally

---

## Summary of New Language Patterns

| Scenario | Pattern |
|---|---|
| Checking availability | "One moment — I'm checking the schedule…" |
| Queuing a background job | "I'll follow up shortly with options." |
| Push notification arrives | "Good news — I found new openings!" |
| Calendar retry succeeds | "Great news — that slot is now available!" |
| SLA unknown | "It usually takes a few minutes, but could be up to a couple of hours depending on availability." |

## Deterministic Guardrails

| Rule | Violation Example | Correct Behavior |
|---|---|---|
| Only say "confirmed" after `confirm_booking` success | "I've confirmed your 2 PM appointment" (before tool call) | Call `confirm_booking`, wait for success, THEN say "confirmed" |
| Only offer times from `check_availability` | "I think 3 PM might work" (invented) | Only present slots returned by the tool |
| No exact SLA for queued jobs | "I'll text you in 15 minutes" | "I'll follow up shortly" / give a range |
