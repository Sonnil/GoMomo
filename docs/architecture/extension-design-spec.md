# gomomo.ai — Extension Design Spec
## Phone Channel (Twilio) + Excel Booking Backend

> Project: prj-20260205-001 | Version: 2.0-DRAFT | Date: 2026-02-05
> **Classification: DESIGN SPEC ONLY — No implementation code**
> Status: Approved for architectural review

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Extension A: Phone Channel via Twilio](#2-extension-a-phone-channel-via-twilio)
   - 2.1 System Diagram
   - 2.2 Component Architecture
   - 2.3 Speech-to-Text (STT) Pipeline
   - 2.4 Text-to-Speech (TTS) Pipeline
   - 2.5 Barge-In Handling
   - 2.6 SMS Handoff to Web
   - 2.7 Call Flow State Machine
   - 2.8 Twilio Webhook Sequence
   - 2.9 Failure Modes & Fallbacks
   - 2.10 Risks & Mitigations
3. [Extension B: Excel as Booking System](#3-extension-b-excel-as-booking-system)
   - 3.1 System Diagram
   - 3.2 Architecture Options
   - 3.3 Concurrency Strategy
   - 3.4 Locking & Versioning
   - 3.5 SharePoint / OneDrive Considerations
   - 3.6 Excel Schema Design
   - 3.7 Sync Architecture
   - 3.8 Failure Modes & Fallbacks
   - 3.9 Risks & Mitigations
4. [Combined Architecture Diagram](#4-combined-architecture-diagram)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Decision Log](#6-decision-log)
7. [Open Questions](#7-open-questions)

---

## 1. Executive Summary

This document specifies two extensions to gomomo.ai MVP that remain
**out-of-scope for implementation** but require design-level readiness for
stakeholder conversations and future sprint planning.

| Extension | Purpose | Complexity | Estimated Effort |
|---|---|---|---|
| **A: Phone Channel** | Accept inbound calls, conduct voice-based booking via Twilio | High | 3–4 sprints |
| **B: Excel Backend** | Replace or augment PostgreSQL with Excel/SharePoint as the booking store | Medium–High | 2–3 sprints |

Both extensions reuse the existing **Service Layer** and **AI Agent Layer**
without modification. New adapter layers sit beneath the existing abstractions.

---

## 2. Extension A: Phone Channel via Twilio

### 2.1 System Diagram

```
                           ┌──────────────┐
                           │  PSTN / SIP  │
                           │  Caller      │
                           └──────┬───────┘
                                  │ Inbound call
                                  ▼
                         ┌─────────────────┐
                         │   Twilio Voice   │
                         │   Platform       │
                         │                  │
                         │  ┌────────────┐  │
                         │  │ Media       │  │
                         │  │ Streams API │──┼──── Raw audio (μ-law / L16)
                         │  └────────────┘  │     via WebSocket
                         │                  │
                         │  ┌────────────┐  │
                         │  │ TwiML       │  │
                         │  │ Webhooks    │──┼──── HTTP POST events
                         │  └────────────┘  │     (call status, DTMF)
                         │                  │
                         │  ┌────────────┐  │
                         │  │ SMS / MMS   │──┼──── Outbound SMS
                         │  │ API         │  │     (web handoff link)
                         │  └────────────┘  │
                         └────────┬─────────┘
                                  │
                                  │ WebSocket (audio stream)
                                  │ + HTTP webhooks
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    AI RECEPTIONIST SERVER                             │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   VOICE CHANNEL ADAPTER                       │    │
│  │                                                               │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │    │
│  │  │ Audio       │  │ STT Engine  │  │ Barge-In            │  │    │
│  │  │ Buffer &    │──│ (Streaming) │  │ Controller          │  │    │
│  │  │ Resampler   │  │             │  │                     │  │    │
│  │  │             │  │ Deepgram /  │  │ - VAD detection     │  │    │
│  │  │ μ-law→L16   │  │ Azure /     │  │ - TTS interruption  │  │    │
│  │  │ 8kHz→16kHz  │  │ Whisper     │  │ - Partial flush     │  │    │
│  │  └─────────────┘  └──────┬──────┘  └──────────┬──────────┘  │    │
│  │                          │ text                │              │    │
│  │                          ▼                     │              │    │
│  │  ┌───────────────────────────────────────┐    │              │    │
│  │  │         TURN MANAGER                   │    │              │    │
│  │  │                                        │    │              │    │
│  │  │  - Silence detection (end of turn)     │◄───┘              │    │
│  │  │  - Partial transcript accumulation     │                   │    │
│  │  │  - Final transcript → Agent dispatch   │                   │    │
│  │  │  - Timeout → re-prompt                 │                   │    │
│  │  └───────────────────┬────────────────────┘                   │    │
│  │                      │ final transcript                       │    │
│  │                      ▼                                        │    │
│  │  ┌───────────────────────────────────────┐                   │    │
│  │  │         TTS ENGINE                     │                   │    │
│  │  │                                        │                   │    │
│  │  │  Agent text → TTS API                  │                   │    │
│  │  │  (ElevenLabs / Azure Neural / Google)  │                   │    │
│  │  │                                        │                   │    │
│  │  │  Streaming audio → Twilio Media Stream │                   │    │
│  │  │  Sentence-chunked for low latency      │                   │    │
│  │  └───────────────────────────────────────┘                   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                      │                                               │
│                      │ (same interface as WebSocket chat)            │
│                      ▼                                               │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │              EXISTING SERVICE + AGENT LAYER                   │    │
│  │              (BookingService, AvailService, AI Agent, etc.)   │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Architecture

The phone channel introduces a **Voice Channel Adapter** that sits parallel
to the existing WebSocket/REST channel. The adapter is composed of five
sub-components:

| Component | Responsibility | Technology Options |
|---|---|---|
| **Audio Buffer** | Receive Twilio Media Stream, convert μ-law 8kHz → L16 16kHz PCM | Node.js `Buffer`, `audiobuffer` lib |
| **STT Engine** | Stream audio → interim + final transcripts | Deepgram Nova-2, Azure Speech, Whisper API |
| **Turn Manager** | Detect end-of-utterance, accumulate partials, dispatch finals | Custom state machine with VAD + silence timer |
| **TTS Engine** | Convert agent text response → streaming audio | ElevenLabs, Azure Neural TTS, Google WaveNet |
| **Barge-In Controller** | Detect caller interruption, halt TTS playback | VAD energy threshold + Twilio `<Stop>` |

**Key Design Principle:** The Voice Channel Adapter translates audio↔text
at the boundary. The existing `ChatHandler` and `ReceptionistAgent` receive
plain text and return plain text — **zero modifications to the AI layer.**

```
  Voice Adapter boundary
  ┌────────────────────────┐
  │  Audio In  → STT → ┐  │
  │                     ├──┼──→  ChatHandler.handleMessage(text)
  │  Audio Out ← TTS ← ┘  │         │
  │                        │         ▼
  │  Barge-In → Cancel TTS │     Agent text response
  └────────────────────────┘
```

### 2.3 Speech-to-Text (STT) Pipeline

#### Provider Comparison

| Provider | Latency | Streaming | Cost/hr | Accuracy | Barge-In Support |
|---|---|---|---|---|---|
| **Deepgram Nova-2** | ~300ms | ✅ Real-time | $0.0043/min | 95%+ | ✅ Interim results |
| **Azure Speech** | ~400ms | ✅ Real-time | $0.0100/min | 94%+ | ✅ Interim results |
| **OpenAI Whisper API** | ~1–3s | ❌ Batch only | $0.0060/min | 96%+ | ❌ Not suitable |

**Recommendation:** Deepgram Nova-2 for production (lowest latency, streaming,
best price). Azure Speech as fallback.

#### STT Flow

```
Twilio Media Stream (WebSocket)
    │
    │  Audio chunk every 20ms (μ-law, 8kHz, mono)
    ▼
┌─────────────────────┐
│ Audio Preprocessor   │
│                      │
│ 1. Decode μ-law      │
│ 2. Resample 8→16kHz  │
│ 3. Normalize volume   │
│ 4. Buffer 100ms       │
│    chunks             │
└──────────┬──────────┘
           │  L16 PCM 16kHz
           ▼
┌─────────────────────┐
│ STT WebSocket        │
│ (Deepgram/Azure)     │
│                      │
│ ← Interim transcript │ ──→  Turn Manager (partial update)
│                      │       - Display "listening..." feedback
│                      │       - Barge-in detection trigger
│ ← Final transcript   │ ──→  Turn Manager (final dispatch)
│                      │       - Send to ChatHandler
│ ← Speech-end event   │ ──→  Silence confirmation
└─────────────────────┘
```

#### Critical Settings

```yaml
stt_config:
  model: "nova-2"          # or "nova-2-phonecall" for telephony
  language: "en-US"
  encoding: "linear16"
  sample_rate: 16000
  channels: 1
  smart_format: true       # "february fifth" → "February 5th"
  punctuate: true
  interim_results: true    # Required for barge-in
  endpointing: 500         # 500ms silence = end of utterance
  utterance_end_ms: 1200   # Max gap before forced final
  vad_events: true         # Voice Activity Detection callbacks
  filler_words: false      # Strip "um", "uh"
```

### 2.4 Text-to-Speech (TTS) Pipeline

#### Provider Comparison

| Provider | Latency (first byte) | Streaming | Naturalness | Cost/1M chars |
|---|---|---|---|---|
| **ElevenLabs** | ~200ms | ✅ Chunked | ⭐⭐⭐⭐⭐ | $0.30 |
| **Azure Neural** | ~150ms | ✅ Real-time | ⭐⭐⭐⭐ | $0.016 |
| **Google WaveNet** | ~250ms | ✅ Chunked | ⭐⭐⭐⭐ | $0.016 |

**Recommendation:** Azure Neural TTS for production (lowest cost, fastest first-byte,
good naturalness). ElevenLabs for premium voice option.

#### TTS Strategy: Sentence-Level Streaming

```
Agent response: "Great! I have an opening at 2 PM on Thursday. Shall I book that for you?"
                 └─── Sentence 1 ───┘  └─── Sentence 2 ──────────────────────────────────┘

Timeline:
  t=0ms     Agent starts generating response
  t=50ms    Sentence 1 detected (". " boundary)
  t=80ms    TTS API call for Sentence 1 begins
  t=230ms   First audio chunk arrives → stream to Twilio  ◄── Caller hears response
  t=400ms   Sentence 1 complete; Sentence 2 TTS already in-flight
  t=500ms   Sentence 2 audio starts streaming (seamless join)
  t=900ms   Full response delivered

Total perceived latency: ~230ms from agent text → caller hears audio
```

#### Audio Output Format

```yaml
tts_config:
  voice: "en-US-JennyNeural"        # Azure
  format: "audio-24khz-48kbitrate-mono-opus"  # Twilio-compatible
  # OR for raw PCM:
  format: "raw-8khz-8bit-mono-mulaw"  # Direct to Twilio without transcoding
  speaking_rate: "+5%"                 # Slightly faster for receptionist tone
  pitch: "default"
  
  # Sentence splitting regex:
  sentence_boundary: '/(?<=[.!?])\s+|(?<=:)\s*\n/'
  
  # Buffering:
  min_chunk_size: 640    # bytes — Twilio needs minimum payload
  max_concurrent_tts: 2  # Pipeline next sentence while current plays
```

### 2.5 Barge-In Handling

Barge-in occurs when a caller starts speaking **while the bot is still talking**.
This is the most complex aspect of voice UI and requires careful coordination.

#### Barge-In State Machine

```
                    ┌──────────────┐
         ┌─────────│   IDLE       │
         │         │ (listening)  │
         │         └──────┬───────┘
         │                │ Agent produces response
         │                ▼
         │         ┌──────────────┐
         │         │  SPEAKING    │
         │         │ (TTS active) │
         │         └──────┬───────┘
         │                │
         │    ┌───────────┼───────────┐
         │    │           │           │
         │    │ Caller    │ TTS       │ No speech
         │    │ speaks    │ finishes  │ detected
         │    ▼           ▼           ▼
         │ ┌──────────┐ ┌──────────┐ ┌──────────┐
         │ │ BARGE-IN │ │ TURN     │ │ SILENCE  │
         │ │ DETECTED │ │ YIELDED  │ │ TIMEOUT  │
         │ └────┬─────┘ └────┬─────┘ └────┬─────┘
         │      │             │             │
         │      │ Actions:    │             │ Actions:
         │      │ 1. Stop TTS │             │ 1. Play re-prompt
         │      │ 2. Flush    │             │ 2. "Are you still
         │      │    audio buf│             │     there?"
         │      │ 3. Mark     │             │
         │      │    partial  │             │
         │      │    heard    │             │
         │      ▼             │             │
         │ ┌──────────┐      │             │
         │ │ LISTENING │◄─────┘             │
         │ │ (STT on)  │◄──────────────────┘
         │ └────┬──────┘
         │      │ End of utterance
         │      │ (silence > 500ms)
         │      ▼
         │ ┌──────────────┐
         │ │ PROCESSING   │
         │ │ (agent call) │
         └─│              │
           └──────────────┘
```

#### Barge-In Implementation Strategy

```
Detection:
  ┌────────────────────────────────────────────────────────┐
  │ During TTS playback, STT remains ACTIVE on the         │
  │ inbound audio stream.                                   │
  │                                                         │
  │ IF:  VAD detects voice energy > threshold (≈-26 dBFS)  │
  │ AND: energy sustained > 150ms (avoid false positives)   │
  │ AND: STT produces interim transcript > 2 chars          │
  │                                                         │
  │ THEN: trigger BARGE-IN                                  │
  └────────────────────────────────────────────────────────┘

Response:
  1. Send Twilio <Stop> or clear the media stream queue
  2. Record how much of the response was played
     (for context: "I said X but they interrupted at Y")
  3. Flush TTS buffer — discard remaining sentences
  4. Let STT continue capturing the caller's interruption
  5. On end-of-utterance → dispatch to agent with context:
     {
       "interrupted_response": "Great! I have an opening at 2 PM on...",
       "heard_up_to": "...2 PM on",
       "caller_said": "actually, do you have anything in the morning?"
     }
```

#### Sensitivity Tuning

```yaml
barge_in:
  enabled: true
  
  # Energy-based voice activity detection
  vad_threshold_dbfs: -26          # Background noise floor
  min_speech_duration_ms: 150      # Avoid coughs, clicks
  
  # Transcript-based confirmation
  min_interim_chars: 2             # "ok" is valid, "u" is not
  
  # Debounce — don't barge on every breath
  cooldown_after_barge_ms: 2000    # Wait 2s before allowing another
  
  # Context preservation
  track_playback_position: true    # Know what caller heard
  include_partial_in_context: true # Help agent understand interruption
  
  # Graceful modes (per-tenant configurable)
  mode: "immediate"                # or "after-sentence" for less aggressive
```

### 2.6 SMS Handoff to Web

When a voice interaction is better served by visual content (picking from many
slots, entering an email, reviewing a booking summary), the system can send
an SMS with a deep-link to the web widget, preserving conversation state.

#### Handoff Flow

```
┌──────────────────────────────────────────────────────────┐
│                    VOICE CALL                             │
│                                                          │
│  Agent: "I found 8 available slots this week.            │
│          It might be easier to pick one on screen.        │
│          Would you like me to send a link to your phone?" │
│                                                          │
│  Caller: "Sure, that'd be great."                        │
│                                                          │
│  Agent: "Sending now — you'll get a text in a moment.    │
│          The link will show all available times and let    │
│          you finish booking from there."                  │
└────────────────────────┬─────────────────────────────────┘
                         │
           ┌─────────────┼──────────────────┐
           │             │                  │
           ▼             ▼                  ▼
    ┌────────────┐ ┌───────────┐   ┌──────────────────┐
    │ 1. Persist │ │ 2. Send   │   │ 3. Caller opens  │
    │ session    │ │ SMS via   │   │ link on phone    │
    │ state to   │ │ Twilio    │   │                  │
    │ Redis/DB   │ │           │   │ Web widget loads │
    │            │ │ Body:     │   │ with ?session=X  │
    │ Includes:  │ │ "Continue │   │                  │
    │ - context  │ │  booking: │   │ Session state    │
    │ - service  │ │  https:// │   │ restored from DB │
    │ - date     │ │  bloom.   │   │                  │
    │ - slots    │ │  well/    │   │ Chat picks up    │
    │ - caller#  │ │  ?s=X"    │   │ where call left  │
    └────────────┘ └───────────┘   │ off              │
                                   └──────────────────┘
```

#### SMS Template

```
Bloom Wellness Studio ✨

Continue your booking here:
https://bloom.wellness/chat?session={{SESSION_TOKEN}}&channel=sms-handoff

This link expires in 15 minutes.
Reply STOP to opt out.
```

#### Session Continuity Schema

```typescript
interface HandoffSession {
  session_id:    string;       // UUID
  phone_number:  string;       // E.164 format
  tenant_id:     string;
  
  // Conversation state at handoff
  conversation:  Message[];    // Full history
  booking_state: {
    service?:     string;
    date?:        string;      // ISO 8601
    time?:        string;
    name?:        string;
    email?:       string;
    hold_id?:     string;
  };
  
  // Metadata
  handoff_reason: 'many_slots' | 'email_input' | 'user_request' | 'timeout';
  created_at:     Date;
  expires_at:     Date;        // +15 minutes
  claimed:        boolean;     // true once web widget connects
}
```

### 2.7 Call Flow State Machine

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│    ┌───────────┐    Twilio webhook    ┌──────────────────────┐     │
│    │ RINGING   │ ─────────────────► │ ANSWER / GREETING     │     │
│    │           │    POST /voice       │                      │     │
│    └───────────┘                      │ TwiML: <Connect>     │     │
│                                       │   <Stream url="/ws"> │     │
│                                       │ Play welcome TTS     │     │
│                                       └──────────┬───────────┘     │
│                                                  │                  │
│                                                  ▼                  │
│                                       ┌──────────────────────┐     │
│                      ┌───────────────│ CONVERSATION LOOP     │     │
│                      │               │                      │     │
│                      │    ┌──────────┤ STT → Agent → TTS    │     │
│                      │    │          │ (repeat per turn)     │     │
│                      │    │          └──────────┬───────────┘     │
│                      │    │                     │                  │
│                      │    │          ┌──────────┼──────────┐      │
│                      │    │          │          │          │      │
│                      │    │     SMS Handoff  Booking    Goodbye   │
│                      │    │          │       Complete      │      │
│                      │    │          ▼          │          ▼      │
│                      │    │   ┌────────────┐   │   ┌──────────┐  │
│                      │    │   │ HANDOFF    │   │   │ FAREWELL │  │
│                      │    │   │ Send SMS   │   │   │ Thank +  │  │
│                      │    │   │ Keep call  │   │   │ summary  │  │
│                      │    │   │ open 30s   │   │   └────┬─────┘  │
│                      │    │   └─────┬──────┘   │        │        │
│                      │    │         │          │        │        │
│         3 failures   │    │         ▼          ▼        ▼        │
│         or timeout   │    │   ┌─────────────────────────────┐    │
│                      │    │   │          HANG UP             │    │
│                      └────┼──►│  Close stream, log call      │    │
│                           │   │  Audit: duration, outcome    │    │
│                           │   └─────────────────────────────┘    │
│                           │                                       │
│              Barge-in ────┘                                       │
│              (loops back to conversation)                         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.8 Twilio Webhook Sequence

```
Caller dials          Twilio                    Our Server
  │                     │                           │
  │ ── INVITE ────────► │                           │
  │                     │ ── POST /voice ─────────► │
  │                     │                           │
  │                     │ ◄── TwiML Response ────── │
  │                     │     <Connect>             │
  │                     │       <Stream url=        │
  │                     │        "wss://host/       │
  │                     │         twilio-stream"/>   │
  │                     │     </Connect>            │
  │                     │                           │
  │ ◄── 200 OK ─────── │                           │
  │     (call connects) │                           │
  │                     │                           │
  │                     │ ═══ WebSocket opens ════► │
  │                     │                           │
  │                     │ ── { event: "connected",  │
  │                     │      streamSid: "..." } ─►│
  │                     │                           │
  │                     │ ── { event: "start",      │
  │                     │      mediaFormat: {...} } ►│
  │                     │                           │
  │ (caller speaks)     │ ── { event: "media",      │
  │                     │      payload: "base64..." }│
  │                     │     (every 20ms)          │
  │                     │                           │── STT processing
  │                     │                           │── Agent response
  │                     │                           │── TTS generation
  │                     │                           │
  │                     │ ◄── { event: "media",     │
  │                     │       payload: "b64..." } │
  │ (hears response)    │     (TTS audio chunks)    │
  │                     │                           │
  │ ... (loop) ...      │                           │
  │                     │                           │
  │                     │ ── { event: "stop" } ────►│
  │ ── BYE ───────────► │                           │
  │                     │ ── POST /status ─────────►│
  │                     │     (call ended)          │
```

### 2.9 Failure Modes & Fallbacks

| Failure | Detection | Fallback |
|---|---|---|
| STT provider down | WebSocket disconnect / timeout >3s | Switch to Azure Speech (secondary); if both down → play "please try our website" + hang up |
| TTS provider down | API error / timeout >2s | Fall back to Twilio `<Say>` with basic voice; degraded but functional |
| Agent timeout (>10s) | Timer on ChatHandler call | Play filler: "Let me check that for you…" + retry once; if still fails → SMS handoff |
| Twilio Media Stream drops | WebSocket close event | Twilio auto-reconnects; if >3 drops in 60s → escalate to human or hang up gracefully |
| Background noise / false barge-in | VAD energy below threshold after initial spike | Increase `min_speech_duration_ms` dynamically for that call |
| Caller silence >30s | Silence timer | "Are you still there?" prompt; after 2nd silence → "Goodbye" + hang up |
| Toll fraud / bot caller | Call duration >15min or >20 turns with no booking | Auto-terminate with message; flag in audit log |

### 2.10 Risks & Mitigations

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| P1 | **Latency budget exceeded** — STT + Agent + TTS combined >2s makes conversation feel unnatural | 🔴 High | Medium | Sentence-level TTS streaming; STT streaming with endpointing; pre-buffer filler phrases; measure P95 latency per component |
| P2 | **Barge-in false positives** — Background noise triggers interruption, causing response truncation | 🟡 Medium | High | Dual-gate detection (VAD energy + STT transcript length); per-call adaptive threshold; configurable sensitivity |
| P3 | **STT accuracy on names/emails** — Proper nouns and email addresses have lower transcription accuracy | 🟡 Medium | High | Use STT keyword boosting for service names; for emails always SMS-handoff; spell-back confirmation ("M as in Mary...") |
| P4 | **Twilio cost escalation** — Media Streams + STT + TTS per call can cost $0.10–0.30/min | 🟡 Medium | Medium | Set max call duration (10min); monitor spend per tenant; offer as premium tier |
| P5 | **Compliance: call recording consent** — Some jurisdictions require two-party consent | 🔴 High | High | Play legal disclaimer at call start; make recording opt-in; document per-jurisdiction rules |
| P6 | **Session state loss during handoff** — Redis/DB failure loses context between voice→web | 🟡 Medium | Low | Write-through to PostgreSQL; session token includes encrypted minimal state as fallback |
| P7 | **Concurrent calls overwhelming server** — Each call holds a persistent WebSocket + STT stream | 🟡 Medium | Medium | Connection pooling; horizontal scaling with sticky sessions; per-tenant concurrent call limits |

---

## 3. Extension B: Excel as Booking System

### 3.1 System Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                    AI RECEPTIONIST SERVER                             │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │              EXISTING SERVICE LAYER                           │    │
│  │  BookingService  │  AvailService  │  TenantService           │    │
│  │                  │                │                           │    │
│  │  Uses BookingStore interface (abstraction)                    │    │
│  └──────────────────────────┬───────────────────────────────────┘    │
│                             │                                        │
│              ┌──────────────┼──────────────────┐                    │
│              │              │                  │                    │
│              ▼              ▼                  ▼                    │
│  ┌─────────────────┐ ┌─────────────┐ ┌──────────────────┐         │
│  │  PostgresStore   │ │ ExcelStore  │ │ HybridStore      │         │
│  │  (existing)      │ │ (new)       │ │ (Postgres + sync │         │
│  │                  │ │             │ │  to Excel)       │         │
│  │  Direct DB       │ │ Graph API   │ │                  │         │
│  │  read/write      │ │ read/write  │ │ DB = source of   │         │
│  │                  │ │             │ │ truth; Excel =   │         │
│  │                  │ │             │ │ human-readable   │         │
│  │                  │ │             │ │ mirror           │         │
│  └─────────────────┘ └──────┬──────┘ └────────┬─────────┘         │
│                             │                  │                    │
└─────────────────────────────┼──────────────────┼────────────────────┘
                              │                  │
                ┌─────────────┼──────────────────┼─────────────────┐
                │             ▼                  ▼                 │
                │  ┌────────────────────────────────────────────┐  │
                │  │          Microsoft Graph API                │  │
                │  │                                             │  │
                │  │  POST   /drives/{id}/items/{id}/workbook/  │  │
                │  │          tables/{name}/rows                 │  │
                │  │  PATCH  .../worksheets/{name}/range         │  │
                │  │  GET    .../worksheets/{name}/usedRange     │  │
                │  │  POST   .../createSession (for locking)     │  │
                │  │                                             │  │
                │  └──────────────────┬─────────────────────────┘  │
                │                     │                             │
                │                     ▼                             │
                │  ┌────────────────────────────────────────────┐  │
                │  │  SharePoint / OneDrive                      │  │
                │  │                                             │  │
                │  │  📄 Bloom_Appointments.xlsx                 │  │
                │  │                                             │  │
                │  │  ┌──────────────────────────────────────┐  │  │
                │  │  │ Sheet: "Appointments"                 │  │  │
                │  │  │ Sheet: "Availability"                 │  │  │
                │  │  │ Sheet: "Config"                       │  │  │
                │  │  │ Sheet: "_Locks" (system)              │  │  │
                │  │  └──────────────────────────────────────┘  │  │
                │  └────────────────────────────────────────────┘  │
                │              Microsoft 365                        │
                └──────────────────────────────────────────────────┘
```

### 3.2 Architecture Options

Three viable patterns, each with distinct tradeoffs:

#### Option A: Excel as Primary Store (Direct)

```
  Chat → Agent → Service → ExcelStore → Graph API → Excel file
                                          ▲
                                          │ (human also edits)
                                      Admin opens
                                      file in Excel
```

| Pros | Cons |
|---|---|
| Simple architecture, one data source | Graph API latency: 200–800ms per call |
| Admin sees live data in familiar tool | No ACID transactions |
| No database to maintain | Concurrent edit conflicts |
| Easy to audit by non-technical staff | Rate limits: 10,000 req/10min per app |

#### Option B: Hybrid (Postgres Primary + Excel Mirror)

```
  Chat → Agent → Service → PostgresStore → PostgreSQL (source of truth)
                                │
                                ├── on write → SyncWorker → Graph API → Excel
                                │
                           Admin edits Excel
                                │
                           Webhook / poll → IngestWorker → PostgreSQL
```

| Pros | Cons |
|---|---|
| Full ACID on all booking operations | Two data sources to keep in sync |
| Low latency (DB reads: <5ms) | Sync lag: 5–30s for Excel to reflect DB |
| Excel serves as human-friendly view | Conflict resolution needed |
| Existing hardening (SERIALIZABLE, advisory locks) preserved | More infrastructure to maintain |

#### Option C: Excel as Primary with Local Cache

```
  Chat → Agent → Service → ExcelStore → Local Cache (SQLite/Map)
                                │               │
                                │          cache miss
                                │               │
                                └──── Graph API → Excel file
                                        │
                                   cache invalidation
                                   via webhook / ETag
```

| Pros | Cons |
|---|---|
| Reduced API calls | Cache staleness risk |
| Better read latency | Cache invalidation is hard |
| Excel remains source of truth | Lost writes if cache diverges |

**Recommendation: Option B (Hybrid)** — Preserves all production hardening
from the PostgreSQL implementation while giving admins the Excel experience
they want. Excel becomes a human interface, not a database.

### 3.3 Concurrency Strategy

Excel lacks database-grade concurrency primitives. This is the central
engineering challenge.

#### The Fundamental Problem

```
  Time ──────────────────────────────────────────────────────►

  Receptionist Bot                              Admin (Excel Desktop)
       │                                              │
  t=0  │ GET  available slots                         │
       │ (reads row 15: 2pm slot = "open")            │
       │                                              │
  t=1  │                                    Clicks on row 15
       │                                    Types "Mrs. Johnson"
       │                                    (2pm slot manually booked)
       │                                              │
  t=2  │ POST book 2pm slot                           │
       │ (writes row 15: 2pm = "booked, Mr. Smith")   │
       │                                              │
  t=3  │ ✅ Bot confirms booking                       │ Saves file
       │                                              │ ❌ Overwrites bot's booking!
       │                                              │    "Mrs. Johnson" wins
       │                                              │    Mr. Smith's booking LOST
       │                                              │
       └──── DOUBLE-BOOKING ──────────────────────────┘
```

#### Mitigation Strategies by Architecture Option

**Option B (Hybrid — Recommended):**

```
┌──────────────────────────────────────────────────────────────┐
│ WRITE PATH (Bot books an appointment)                        │
│                                                              │
│ 1. Bot → BookingService → PostgresStore                      │
│    - SERIALIZABLE transaction + advisory lock                │
│    - EXCLUDE constraint prevents overlap  ✅                  │
│    - ZERO Excel involvement during write                     │
│                                                              │
│ 2. After COMMIT → SyncWorker pushes to Excel                │
│    - Graph API: PATCH row with booking details               │
│    - Idempotent (uses appointment_id as key)                 │
│    - If Graph API fails → retry queue (max 3)                │
│                                                              │
│ WRITE PATH (Admin edits Excel)                               │
│                                                              │
│ 1. Admin changes cell in Excel                               │
│    - SharePoint webhook fires (Δ notification)               │
│    - OR: poll every 30s via ETag comparison                  │
│                                                              │
│ 2. IngestWorker picks up change                              │
│    - Reads full Appointments sheet                           │
│    - Diffs against PostgreSQL                                │
│    - Applies changes inside SERIALIZABLE transaction         │
│    - If conflict (bot booked same slot in the meantime):     │
│      → REJECT admin change                                   │
│      → Write back bot's version to Excel                     │
│      → Notify admin via comment/highlight                    │
│                                                              │
│ RESULT: PostgreSQL always wins. No double-bookings.          │
└──────────────────────────────────────────────────────────────┘
```

**Option A (Direct Excel — If forced):**

```
┌──────────────────────────────────────────────────────────────┐
│ OPTIMISTIC CONCURRENCY via VERSION COLUMN                    │
│                                                              │
│ 1. Bot reads slot:  row 15 = { status: "open", ver: 7 }     │
│                                                              │
│ 2. Bot writes:                                               │
│    Graph API → PATCH row 15                                  │
│    WITH formula check:                                       │
│      IF(O15 = 7, "booked", ERROR("version conflict"))       │
│      IF(B15 = "open", "booked", ERROR("slot taken"))        │
│    SET O15 = 8  (increment version)                          │
│                                                              │
│ 3. If formula error → retry (re-read, check again)          │
│                                                              │
│ PROBLEM: Graph API doesn't support conditional writes.       │
│ This must be simulated — see Locking section below.          │
└──────────────────────────────────────────────────────────────┘
```

### 3.4 Locking & Versioning

#### Graph API Session Locking

```
┌──────────────────────────────────────────────────────────────┐
│ Microsoft Graph "Workbook Session" mechanism:                 │
│                                                              │
│ POST /drives/{id}/items/{id}/workbook/createSession          │
│ Body: { "persistChanges": true }                             │
│                                                              │
│ Response: { "id": "session_xyz_123" }                        │
│                                                              │
│ All subsequent API calls include:                            │
│   Header: workbook-session-id: session_xyz_123               │
│                                                              │
│ This provides:                                               │
│   ✅  Read-your-own-writes consistency                        │
│   ✅  Batch multiple operations atomically                    │
│   ❌  Does NOT prevent other users from writing               │
│   ❌  Does NOT provide row-level locks                        │
│   ❌  Session timeout: 5 minutes of inactivity                │
│                                                              │
│ VERDICT: Necessary but NOT sufficient for concurrency.       │
└──────────────────────────────────────────────────────────────┘
```

#### Application-Level Locking (for Option A)

Since Excel/Graph API has no row-level locking, we implement it in a
dedicated `_Locks` sheet:

```
Sheet: "_Locks"
┌──────────┬─────────┬──────────────┬──────────────┬───────────┐
│ lock_key │ held_by │ acquired_at  │ expires_at   │ version   │
├──────────┼─────────┼──────────────┼──────────────┼───────────┤
│ slot:    │ bot:    │ 2026-02-05   │ 2026-02-05   │ 1         │
│ 2026-02- │ sess_   │ T14:00:00Z   │ T14:05:00Z   │           │
│ 10T14:00 │ abc123  │              │              │           │
└──────────┴─────────┴──────────────┴──────────────┴───────────┘

Lock acquisition protocol (CAS — Compare-And-Swap emulation):
─────────────────────────────────────────────────────────────
1. Read _Locks sheet for target slot key
2. If no row OR expires_at < now:
     a. Write new lock row with our session + expires_at=now+5min
     b. Immediately re-read the row
     c. If held_by === our session → LOCK ACQUIRED ✅
     d. If held_by !== our session → LOCK FAILED (race lost) ❌
3. If row exists AND not expired AND held_by !== us:
     → LOCK BUSY — retry after 1s (max 3 retries)

Release protocol:
─────────────────
1. Delete lock row where held_by === our session
2. OR: let it expire (5-min TTL auto-cleans)
```

#### Versioning Strategy (ETag-Based)

```
  ┌────────────────────────────────────────────────────────────┐
  │ Every write operation:                                      │
  │                                                             │
  │ 1. GET file with If-None-Match header                       │
  │    → Response includes ETag: "abc123"                       │
  │                                                             │
  │ 2. Read current state, prepare changes                      │
  │                                                             │
  │ 3. PATCH with If-Match: "abc123"                            │
  │    → If file unchanged → 200 OK ✅                          │
  │    → If file changed  → 412 Precondition Failed ❌          │
  │                                                             │
  │ 4. On 412 → re-read, re-evaluate, retry (max 3)            │
  │                                                             │
  │ ⚠️  ETag is FILE-LEVEL, not row-level.                      │
  │    Any change to any cell invalidates it.                   │
  │    In a busy file, this causes excessive retries.           │
  └────────────────────────────────────────────────────────────┘
```

### 3.5 SharePoint / OneDrive Considerations

#### Feature Comparison

```
┌───────────────────────────────┬───────────────────┬──────────────────┐
│ Capability                    │ OneDrive Personal │ SharePoint/OD4B  │
├───────────────────────────────┼───────────────────┼──────────────────┤
│ Graph API workbook access     │ ✅                 │ ✅                │
│ Workbook sessions             │ ✅                 │ ✅                │
│ Delta query (change tracking) │ ✅ (file-level)    │ ✅ (file-level)   │
│ Webhooks (change notify)      │ ✅                 │ ✅                │
│ Co-authoring support          │ ✅                 │ ✅                │
│ File size limit               │ 250 MB            │ 250 MB           │
│ Row limit (practical)         │ ~500K rows        │ ~500K rows       │
│ API rate limits               │ 10K req/10min     │ 10K req/10min    │
│ Concurrent sessions           │ Limited           │ Better           │
│ Audit trail (native)          │ ❌                 │ ✅ Compliance     │
│ Permissions model             │ Simple sharing    │ Full RBAC        │
│ Retention policies            │ ❌                 │ ✅                │
│ eDiscovery                    │ ❌                 │ ✅                │
│ Versioning                    │ Auto (25 versions)│ Auto (500 vers.) │
│ Recycle bin                   │ 30 days           │ 93 days          │
│ Multi-geo support             │ ❌                 │ ✅                │
│ Guest access control          │ Limited           │ Full             │
└───────────────────────────────┴───────────────────┴──────────────────┘
```

**Recommendation:** SharePoint Online (via OneDrive for Business) for any
tenant beyond a solo practitioner. The audit trail, versioning depth, and
permissions model are essential for a booking system.

#### Co-Authoring Conflict Scenario

```
  Time ─────────────────────────────────────────────────────────►

  Bot (via Graph API)                    Admin (Excel Desktop)
       │                                        │
  t=0  │                              Opens file in Excel
       │                              (co-authoring lock held)
       │                                        │
  t=1  │ createSession()                        │
       │ → Session S1                           │
       │                                        │
  t=2  │ PATCH row 15 via S1                    │
       │ → ⚠️ CONFLICT with co-author           │
       │                                        │
       │ Possible outcomes:                     │
       │ a) 409 Conflict → retry                │
       │ b) Write succeeds but admin doesn't    │
       │    see it until they refresh            │
       │ c) Admin saves → overwrites bot's      │
       │    change (LAST WRITE WINS)             │
       │                                        │
       │ THIS IS WHY OPTION B (Hybrid) EXISTS   │
       └────────────────────────────────────────┘
```

#### Authentication Flow

```
  ┌─────────────────────────────────────────────────────────┐
  │ Microsoft Entra ID (Azure AD) OAuth 2.0                  │
  │                                                          │
  │ App Registration:                                        │
  │   - Client ID + Secret                                   │
  │   - Permissions: Files.ReadWrite.All (delegated)         │
  │     OR Sites.ReadWrite.All (application)                 │
  │   - Redirect URI for tenant admin consent                │
  │                                                          │
  │ Token flow:                                              │
  │   1. Tenant admin authorizes app → refresh token stored  │
  │   2. Server exchanges refresh → access token (1hr TTL)   │
  │   3. Access token used in Graph API Authorization header │
  │   4. On 401 → refresh token rotation → retry             │
  │                                                          │
  │ Per-tenant: each tenant's Excel file is in THEIR         │
  │ SharePoint/OneDrive. Our app holds delegated access.     │
  └─────────────────────────────────────────────────────────┘
```

### 3.6 Excel Schema Design

```
Sheet: "Appointments"
┌───┬────────────┬────────────┬────────────┬─────────┬──────────┬────────────┬────────────┬──────────┬────────┬──────────────┬───────────────┬───────┐
│ # │ Appt ID    │ Date       │ Start Time │End Time │ Service  │ Client     │ Email      │ Phone    │ Status │ Booked By    │ Modified At   │ Ver   │
├───┼────────────┼────────────┼────────────┼─────────┼──────────┼────────────┼────────────┼──────────┼────────┼──────────────┼───────────────┼───────┤
│ 1 │ BK-7X3M9K  │ 2026-02-10 │ 14:00      │ 15:00   │ Deep     │ Alex       │ alex@      │ +1...    │ booked │ ai-bot       │ 2026-02-05    │ 1     │
│   │            │            │            │         │ Tissue   │ Morrison   │ email.com  │          │        │              │ T14:23:00Z    │       │
├───┼────────────┼────────────┼────────────┼─────────┼──────────┼────────────┼────────────┼──────────┼────────┼──────────────┼───────────────┼───────┤
│ 2 │ BK-4R8T2W  │ 2026-02-08 │ 13:00      │ 13:30   │ Facial   │ Jennifer   │ jen.wu@    │          │ cancel │ ai-bot       │ 2026-02-05    │ 3     │
│   │            │            │            │         │ Treatmt  │ Wu         │ gmail.com  │          │        │              │ T15:01:00Z    │       │
└───┴────────────┴────────────┴────────────┴─────────┴──────────┴────────────┴────────────┴──────────┴────────┴──────────────┴───────────────┴───────┘

Sheet: "Availability"
┌───┬────────────┬─────────┬──────────┬──────────┬──────────────┐
│ # │ Date       │ Start   │ End      │ Status   │ Held By      │
├───┼────────────┼─────────┼──────────┼──────────┼──────────────┤
│ 1 │ 2026-02-10 │ 09:00   │ 10:00    │ open     │              │
│ 2 │ 2026-02-10 │ 10:00   │ 11:00    │ held     │ sess_abc123  │
│ 3 │ 2026-02-10 │ 14:00   │ 15:00    │ booked   │ BK-7X3M9K   │
└───┴────────────┴─────────┴──────────┴──────────┴──────────────┘

Sheet: "Config"
┌───────────────────┬──────────────────────────────┐
│ Key               │ Value                        │
├───────────────────┼──────────────────────────────┤
│ business_name     │ Bloom Wellness Studio         │
│ timezone          │ America/New_York             │
│ slot_duration_min │ 30                           │
│ hold_ttl_min      │ 5                            │
│ mon_start         │ 09:00                        │
│ mon_end           │ 18:00                        │
│ sat_start         │ 10:00                        │
│ sat_end           │ 16:00                        │
│ sun_start         │ CLOSED                       │
└───────────────────┴──────────────────────────────┘

Sheet: "_Locks" (system — hidden from admin)
┌──────────────────────────┬──────────────┬──────────────┬──────────────┐
│ lock_key                 │ held_by      │ acquired_at  │ expires_at   │
├──────────────────────────┼──────────────┼──────────────┼──────────────┤
│ slot:2026-02-10T10:00    │ sess_abc123  │ ...T14:00:00 │ ...T14:05:00 │
└──────────────────────────┴──────────────┴──────────────┴──────────────┘
```

### 3.7 Sync Architecture (Option B Detail)

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SYNC PIPELINE                                 │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                  DB → EXCEL (Outbound)                       │    │
│  │                                                              │    │
│  │  Trigger:  After each successful COMMIT in BookingService    │    │
│  │                                                              │    │
│  │  1. Emit event: { type: 'booking.created', payload: {...} }  │    │
│  │  2. SyncWorker picks up from event queue                     │    │
│  │  3. createSession() on Graph API                             │    │
│  │  4. Find or create row by Appt ID (UPSERT logic)            │    │
│  │  5. PATCH row with booking data                              │    │
│  │  6. closeSession()                                           │    │
│  │                                                              │    │
│  │  Retry:  3 attempts, exponential backoff (1s, 4s, 16s)      │    │
│  │  DLQ:    Failed syncs → dead_letter table for manual review  │    │
│  │                                                              │    │
│  │  Events handled:                                             │    │
│  │    booking.created  → Add row                                │    │
│  │    booking.updated  → Update row                             │    │
│  │    booking.cancelled → Set status = "cancelled"              │    │
│  │    hold.created     → Update Availability sheet              │    │
│  │    hold.released    → Update Availability sheet              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                  EXCEL → DB (Inbound)                        │    │
│  │                                                              │    │
│  │  Trigger:  SharePoint webhook OR polling (30s interval)      │    │
│  │                                                              │    │
│  │  1. GET /drives/{id}/items/{id} with If-None-Match: {etag}  │    │
│  │     → 304 Not Modified = no changes, skip                    │    │
│  │     → 200 OK = file changed                                  │    │
│  │                                                              │    │
│  │  2. Read full Appointments sheet via usedRange               │    │
│  │  3. Diff against PostgreSQL:                                 │    │
│  │     - New rows in Excel (admin manually added booking)       │    │
│  │     - Modified rows (admin changed time, status, etc.)       │    │
│  │     - Deleted rows (admin removed a row)                     │    │
│  │                                                              │    │
│  │  4. For each change:                                         │    │
│  │     a. Validate (schema, no overlaps, business rules)        │    │
│  │     b. Apply in SERIALIZABLE transaction                     │    │
│  │     c. If conflict → REJECT and write-back DB version        │    │
│  │     d. Log in audit_log: { source: "excel-admin" }           │    │
│  │                                                              │    │
│  │  Conflict resolution: DATABASE WINS (always)                 │    │
│  │  Admin notification: Conditional formatting on conflict cell  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                  CONFLICT VISUALIZATION                      │    │
│  │                                                              │    │
│  │  When a sync conflict is detected:                           │    │
│  │                                                              │    │
│  │  1. The conflicting cell is highlighted RED in Excel         │    │
│  │  2. A cell comment is added:                                 │    │
│  │     "⚠️ Conflict: AI bot booked this slot at 14:23.          │    │
│  │      Your change was reverted. Contact support if needed."   │    │
│  │  3. The _SyncLog sheet gets a new entry                      │    │
│  │  4. (Optional) Email notification to admin                   │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.8 Failure Modes & Fallbacks

| Failure | Detection | Fallback |
|---|---|---|
| Graph API down / 503 | HTTP error + retry exhaustion | Queue writes in DB; mark sync pending; retry when API recovers |
| Excel file deleted | 404 on file access | Alert admin; continue serving from DB; recreate file on admin action |
| Excel file locked (exclusive edit) | 423 Locked / 409 Conflict | Retry 3x with backoff; if persistent → queue + alert admin |
| Admin reformats sheet (breaks schema) | Column header validation fails | Reject inbound sync; alert admin; serve from DB until fixed |
| Graph API rate limit (429) | `Retry-After` header | Honor retry-after; implement token bucket; batch operations |
| Token expired / revoked | 401 Unauthorized | Attempt refresh; if refresh fails → alert admin to re-authorize |
| SharePoint webhook missed | Poll comparison detects drift | Always run polling as backup (30s interval), even with webhooks active |
| Large file (>5000 rows) | Performance degradation | Archive old rows to "Archive" sheet; keep active sheet <1000 rows |

### 3.9 Risks & Mitigations

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| E1 | **Last-write-wins data loss** — Admin saves Excel overwriting bot's booking | 🔴 Critical | High | Option B (Hybrid): DB is source of truth; Excel is mirror with conflict detection |
| E2 | **Graph API rate limits** — 10K requests per 10 minutes per app, shared across all tenants | 🟡 Medium | Medium | Batch read/writes; per-tenant throttling; read caching with ETag invalidation |
| E3 | **Co-authoring interference** — Bot's Graph API session and admin's desktop Excel clash | 🟡 Medium | High | Short-lived sessions (open→write→close in <2s); non-persistent sessions for reads |
| E4 | **Schema drift** — Admin renames columns, inserts rows, changes formatting | 🔴 High | High | Strict schema validation on every read; reject and alert on mismatch; use Excel Tables (ListObject) for structural stability |
| E5 | **Sync lag perceived as bug** — Admin adds booking in Excel, bot doesn't see it for 30s | 🟡 Medium | Medium | Document expected lag; offer manual "sync now" button; use webhooks for faster notification |
| E6 | **File corruption** — Concurrent Graph API writes + desktop autosave | 🔴 High | Low | SharePoint auto-versioning (500 versions); always verify after write; use workbook sessions |
| E7 | **Scaling ceiling** — Excel is not a database; performance degrades beyond ~10K rows | 🟡 Medium | Low (per tenant) | Auto-archive rows older than 90 days; warn at 5K rows; hard limit at 10K |
| E8 | **Auth complexity** — Each tenant needs Microsoft 365 license + Entra ID app consent | 🟡 Medium | Medium | Provide step-by-step onboarding wizard; support both delegated and application permissions |

---

## 4. Combined Architecture Diagram

When both extensions are deployed alongside the existing web channel:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CHANNELS                                        │
│                                                                              │
│  ┌──────────────┐   ┌──────────────────┐   ┌────────────────────────────┐   │
│  │ 🌐 Web Chat   │   │ 📞 Phone (Twilio) │   │ 📱 SMS Handoff            │   │
│  │ (React Widget)│   │ (Voice + PSTN)    │   │ (Twilio SMS → Web link)   │   │
│  │              │   │                   │   │                           │   │
│  │ Socket.IO    │   │ Media Streams WS  │   │ Deep-link with session    │   │
│  └──────┬───────┘   └────────┬──────────┘   └─────────────┬─────────────┘   │
│         │                    │                             │                  │
└─────────┼────────────────────┼─────────────────────────────┼──────────────────┘
          │                    │                             │
          ▼                    ▼                             │
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CHANNEL ADAPTERS                                     │
│                                                                              │
│  ┌──────────────┐   ┌──────────────────┐                                    │
│  │ WebSocket     │   │ Voice Adapter     │                                    │
│  │ Adapter       │   │ STT ←→ TTS       │                                    │
│  │ (existing)    │   │ Barge-In Ctrl     │                                    │
│  │              │   │ Turn Manager      │                                    │
│  └──────┬───────┘   └────────┬──────────┘                                    │
│         │                    │                             │                  │
│         │     text in / text out                           │                  │
│         ▼                    ▼                             ▼                  │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                    SHARED AGENT + SERVICE LAYER                        │   │
│  │                    (channel-agnostic)                                  │   │
│  │                                                                       │   │
│  │   ChatHandler → ReceptionistAgent → Tools → Services → Store          │   │
│  └───────────────────────────────────────────┬───────────────────────────┘   │
│                                              │                               │
└──────────────────────────────────────────────┼───────────────────────────────┘
                                               │
                          ┌────────────────────┼─────────────────────┐
                          │                    │                     │
                          ▼                    ▼                     ▼
               ┌────────────────┐   ┌──────────────────┐   ┌────────────────┐
               │ PostgreSQL     │   │ Google Calendar   │   │ Excel/SP       │
               │ (primary)      │   │ (external cal)    │   │ (mirror or     │
               │                │   │                   │   │  alt store)    │
               │ ◄── SyncWorker │─► │                   │   │                │
               │      ──────►  │   │                   │   │ ◄── Graph API  │
               └────────────────┘   └──────────────────┘   └────────────────┘
```

---

## 5. Cross-Cutting Concerns

### 5.1 Latency Budgets

```
Web Chat (current):
  User msg → Agent response: < 3,000ms
  ├── Network:     ~50ms
  ├── Agent/LLM:   ~1,500ms
  ├── Tool exec:   ~200ms
  └── DB:          ~5ms

Phone Channel (target):
  Caller utterance end → first audio heard: < 1,500ms  ⚠️ MUCH TIGHTER
  ├── STT finalize:     ~300ms
  ├── Agent/LLM:        ~800ms  (may need faster model or streaming)
  ├── Tool exec:        ~200ms
  ├── TTS first-byte:   ~200ms
  └── Total:            ~1,500ms ✅ (with sentence-level streaming)

  ⚠️ Without streaming TTS: ~2,500ms — UNACCEPTABLE for voice UX

Excel Backend (added latency):
  Option A (direct): +200-800ms per Graph API call
  Option B (hybrid): +0ms reads (DB), +5-30s async sync to Excel
```

### 5.2 Observability

```yaml
phone_channel_metrics:
  - call_duration_seconds          # Histogram
  - stt_latency_ms                 # P50, P95, P99
  - tts_latency_first_byte_ms     # P50, P95, P99
  - barge_in_count_per_call        # Avg, Max
  - barge_in_false_positive_rate   # %
  - stt_word_error_rate            # % (sampled)
  - call_outcome                   # booked, cancelled, rescheduled, abandoned, handoff
  - handoff_to_web_rate            # %
  - concurrent_calls               # Gauge

excel_sync_metrics:
  - sync_outbound_latency_ms       # DB commit → Excel updated
  - sync_inbound_latency_ms        # Excel change → DB updated
  - sync_conflict_count            # Counter
  - sync_failure_count             # Counter
  - graph_api_rate_remaining       # Gauge (from response headers)
  - excel_row_count                # Gauge (per tenant)
```

### 5.3 Security Additions

| Concern | Phone Channel | Excel Backend |
|---|---|---|
| **Data in transit** | Twilio TLS for Media Streams; TLS to STT/TTS providers | TLS to Graph API |
| **Data at rest** | Call recordings (if enabled) encrypted; transcripts in DB | Excel file protected by SharePoint/OneDrive permissions |
| **PII handling** | Phone numbers, voice recordings are PII; GDPR/CCPA apply | Client names, emails in Excel; shared access must be controlled |
| **Auth** | Twilio webhook signature validation (`X-Twilio-Signature`) | Microsoft Entra ID OAuth 2.0; per-tenant consent |
| **Abuse** | Rate limiting (max calls/min/tenant); max duration; fraud detection | Rate limiting on Graph API; max sync frequency |

---

## 6. Decision Log

| # | Decision | Rationale | Alternatives Rejected |
|---|---|---|---|
| D1 | Deepgram Nova-2 as primary STT | Lowest latency (300ms), best streaming support, cost-effective | Whisper (no streaming), Azure Speech (higher latency) |
| D2 | Azure Neural TTS as primary | Fastest first-byte (150ms), lowest cost, native μ-law output | ElevenLabs (premium option kept for upgrade), Google WaveNet |
| D3 | Sentence-level TTS streaming | Reduces perceived latency from ~2.5s to ~230ms | Full-response TTS (too slow), word-level (too choppy) |
| D4 | Dual-gate barge-in (VAD + transcript) | Reduces false positives from background noise | VAD-only (too many false alarms), transcript-only (too slow) |
| D5 | Option B (Hybrid) for Excel | Preserves ACID guarantees; Excel is a view, not a database | Option A (too risky for concurrency), Option C (cache complexity) |
| D6 | DB-wins conflict resolution | Prevents double-booking; bot operations are higher-velocity than admin | Excel-wins (data loss), manual merge (too complex for MVP) |
| D7 | SharePoint over personal OneDrive | Audit trail, versioning depth (500), RBAC, compliance features | Personal OneDrive (insufficient for business use) |
| D8 | Polling + webhooks for inbound sync | Webhooks for speed; polling as safety net (webhooks can be missed) | Webhooks-only (unreliable), polling-only (30s lag minimum) |

---

## 7. Open Questions

| # | Question | Owner | Deadline | Impact |
|---|---|---|---|---|
| Q1 | Which STT provider's BAA (Business Associate Agreement) covers HIPAA for healthcare tenants? | Engineering | Before phone MVP | Blocks healthcare vertical |
| Q2 | Should barge-in sensitivity be tenant-configurable or fixed? | Product | Sprint planning | UX tuning complexity |
| Q3 | What is the maximum acceptable sync lag for Excel (Option B)? 5s? 30s? 60s? | Product | Before Excel MVP | Determines polling interval + infra cost |
| Q4 | Do we need call recording for compliance, and in which jurisdictions? | Legal | Before phone MVP | Architecture + storage + consent flow |
| Q5 | Should the Excel file be auto-created during tenant onboarding, or does the admin bring their own? | Product | Before Excel MVP | Onboarding flow design |
| Q6 | Is there demand for outbound calling (reminders, confirmations) or inbound only? | Product | Phase 2 planning | Scope expansion |
| Q7 | How should we handle tenants who manually rearrange Excel columns? | Engineering | Before Excel MVP | Schema validation strictness |
