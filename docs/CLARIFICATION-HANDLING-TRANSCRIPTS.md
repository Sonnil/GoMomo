# Clarification Handling — Example Web Chat Transcripts

Three example conversations demonstrating correct handling of ambiguous availability requests. The agent asks a clarification question **before** calling `check_availability` whenever the user's intent could be interpreted multiple ways.

---

## Transcript 1: "Next 24 available" — Numeric Ambiguity

> **Pattern demonstrated:** The number "24" could mean the next 24 hours or the next 24 available time slots. The agent clarifies before proceeding.

```
USER:  Hi! Can I see the next 24 available?

AGENT: Hi there! Just to make sure I understand — do you mean the
       next 24 hours, or the next 24 available time slots?

USER:  Oh, sorry — I meant the next 24 hours.

AGENT: No problem! One moment — I'm checking the schedule…

       [calls check_availability for the next 24 hours]

AGENT: Here are the open slots over the next 24 hours:

       Today (Friday, Feb 7):
       • 2:00 PM
       • 3:30 PM

       Tomorrow (Saturday, Feb 8):
       (Closed — we reopen Monday)

       Would you like to book one of today's slots, or should I
       check next week?

USER:  2 PM today works!

AGENT: Great choice. Let me hold that for you.

       [calls hold_slot for today 2:00 PM]

       …continues with normal booking flow…
```

**Key behaviors shown:**
- ✅ Agent did NOT call `check_availability` on first message
- ✅ Asked short, friendly clarification with two interpretations
- ✅ After clarification, proceeded normally with the correct date range
- ✅ Only showed times returned by the tool

---

## Transcript 2: "Next few openings" — Vague Quantity + No Date

> **Pattern demonstrated:** "Next few" is vague (how many? over what time range?). The agent clarifies the scope before searching.

```
USER:  Hey, can you show me the next few openings?

AGENT: Sure! Are you looking for openings over the next few days,
       or would you like me to find a specific number of available
       slots?

USER:  Just this week is fine.

AGENT: Perfect — let me check this week for you.
       One moment — I'm checking the schedule…

       [calls check_availability for Mon Feb 9 – Fri Feb 13]

AGENT: Here's what's open this week:

       Monday, Feb 9:
       • 9:00 AM  • 10:30 AM  • 1:00 PM  • 3:00 PM

       Tuesday, Feb 10:
       • 9:00 AM  • 11:00 AM  • 2:00 PM  • 4:00 PM

       Wednesday, Feb 11:
       • 10:00 AM  • 1:30 PM  • 3:30 PM

       Thursday, Feb 12:
       • 9:00 AM  • 11:30 AM  • 2:00 PM

       Friday, Feb 13:
       • 9:00 AM  • 10:00 AM  • 1:00 PM

       Which day and time work best for you?

USER:  Wednesday at 1:30 PM.

AGENT: Great — let me hold that for you!

       [calls hold_slot for Wed 1:30 PM]

       …continues with normal booking flow…
```

**Key behaviors shown:**
- ✅ "Next few" was correctly flagged as ambiguous
- ✅ Clarification offered two options (next few days vs. specific count)
- ✅ User clarified → agent scoped the search to this week
- ✅ No slots invented — all came from `check_availability`

---

## Transcript 3: "Soonest times" — Ambiguous Urgency

> **Pattern demonstrated:** "Soonest times" implies urgency but gives no date range. The agent confirms scope before checking, then contrasts with a non-ambiguous follow-up that needs no clarification.

```
USER:  What are your soonest times?

AGENT: I'd be happy to find the soonest openings! Are you flexible
       on which day, or is there a particular day or week you had
       in mind?

USER:  I'm totally flexible — just the earliest anything's open.

AGENT: Got it — let me check the next few business days for you.
       One moment — I'm checking the schedule…

       [calls check_availability for Mon Feb 9 – Wed Feb 11]

AGENT: The soonest openings are:

       Monday, Feb 9:
       • 9:00 AM (earliest!)
       • 10:30 AM
       • 1:00 PM

       Want me to grab that 9:00 AM Monday slot for you?

USER:  Actually, do you have anything Tuesday afternoon?

AGENT: One moment — I'm checking the schedule…

       [calls check_availability for Tue Feb 10 afternoon]

AGENT: Tuesday afternoon has a couple of options:
       • 2:00 PM
       • 4:00 PM

       Which would you prefer?

USER:  2 PM please!

AGENT: Let me hold that for you.

       [calls hold_slot for Tue 2:00 PM]

       …continues with normal booking flow…
```

**Key behaviors shown:**
- ✅ "Soonest times" (vague) → agent asked for clarification
- ✅ User said "totally flexible" → agent checked the next few business days
- ✅ "Do you have anything Tuesday afternoon?" (specific) → agent proceeded **without** clarification (not ambiguous)
- ✅ Demonstrates the difference: vague requests get clarified, specific ones don't

---

## Quick Reference: Ambiguous vs. Clear Requests

| User Says | Ambiguous? | Agent Action |
|---|---|---|
| "Next 24 available" | ✅ Yes | Clarify: next 24 hours or 24 slots? |
| "Next few openings" | ✅ Yes | Clarify: next few days or specific count? |
| "Soonest times" | ✅ Yes | Clarify: flexible on day or specific range? |
| "Show me what's available" | ✅ Yes | Ask for date range preference |
| "Next 10 slots" | ✅ Yes | Clarify: 10 slots or next 10 hours/days? |
| "Next available" | ❌ No | Check next few business days directly |
| "Tomorrow afternoon" | ❌ No | Check tomorrow PM directly |
| "This Friday at 2" | ❌ No | Check Friday at 2 PM directly |
| "Next Monday morning" | ❌ No | Check Monday AM directly |

## Rule Summary

1. **Number + "available/openings"** → Always clarify (count vs. time range)
2. **No date reference at all** → Ask for date range preference
3. **Clear date/day/time** → Proceed directly, no clarification needed
4. **Keep it short** — offer the two most likely interpretations
5. **After clarification** — proceed with normal `check_availability` flow
