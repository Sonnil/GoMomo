# Follow-Up Policy Guardrails — Example Transcripts

> Generated: 2026-02-07
> Feature: Follow-up messaging guardrails (per-session limit, cooldown, explicit confirmation)

---

## Transcript 1: First follow-up (happy path)

```
User: I can't find any openings this week. Can you text me when something opens up?

Agent: Of course! I can schedule a follow-up text for you. What's your phone number?

User: 555-867-5309

Agent: Got it. One moment — I'm setting that up…
       [calls schedule_contact_followup → success, followup_number: 1, remaining: 1]

Agent: All set — I'll text you at (555) 867-5309 with available options shortly.
       It usually takes a few minutes, but could be up to a couple of hours
       depending on how the schedule fills up.
```

---

## Transcript 2: Second follow-up — explicit confirmation required

```
User: Actually, can you also email me? I want to make sure I don't miss it.

Agent: [calls schedule_contact_followup → CONFIRMATION_REQUIRED error]

Agent: I've already scheduled a text. Do you also want me to send an email
       to your address on file?

User: Yes, please.

Agent: [calls schedule_contact_followup with notes="__confirmed_additional__" → success, followup_number: 2, remaining: 0]

Agent: Done — I'll also email you with options. That's the last follow-up
       I can schedule for this conversation. If you need anything else,
       you can always call us directly.
```

---

## Transcript 3: Follow-up limit reached

```
User: Can you send me another text to a different number? My partner's number is 555-123-4567.

Agent: [calls schedule_contact_followup → limit reached error]

Agent: I've already scheduled the maximum number of follow-ups for this
       conversation (2 of 2). If you'd like us to reach your partner,
       you're welcome to call us directly at (555) 200-1000 and our
       team can help.
```

---

## Transcript 4: Cooldown blocks rapid follow-ups

```
[New session, but same email was contacted 10 minutes ago]

User: I haven't received the text yet. Can you send it again?

Agent: [calls schedule_contact_followup → cooldown error, ~50 min remaining]

Agent: A follow-up was recently sent to your contact — we'll be in touch
       soon. Please check your messages. If you don't receive anything
       within the next hour, feel free to reach out again.
```

---

## Configuration Reference

| Environment Variable         | Default | Description                                       |
|------------------------------|---------|---------------------------------------------------|
| `FOLLOWUP_MAX_PER_BOOKING`   | `2`     | Max follow-up contacts per chat session            |
| `FOLLOWUP_COOLDOWN_MINUTES`  | `60`    | Min minutes between follow-ups to same recipient   |

### Audit Events Emitted

| Event Type                              | When                                    |
|-----------------------------------------|-----------------------------------------|
| `followup.scheduled`                    | Every successful follow-up scheduling   |
| `followup.limit_reached`               | Per-session limit hit                   |
| `followup.cooldown_blocked`            | Cooldown window prevents follow-up      |
| `followup.additional_confirmation_required` | Agent asked user before 2nd+ follow-up |

### Domain Events

| Event Name                 | Trigger                                  |
|----------------------------|------------------------------------------|
| `FollowupLimitReached`     | Session follow-up count >= max allowed   |
| `FollowupCooldownBlocked`  | Follow-up attempted within cooldown      |
