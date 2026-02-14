# Web Voice Mode — Conversation Mode with AI Agent Icon

**Phase**: Feature Addition  
**Status**: Implemented  
**Flag**: `FEATURE_VOICE_WEB` (default: `false` — opt-in)

---

## Overview

Web Voice Mode adds a **single AI agent icon** that activates a hands-free conversation loop combining **speech-to-text (STT)** and **neural text-to-speech (TTS)**. One tap starts a natural back-and-forth conversation with the AI receptionist.

- **STT**: MediaRecorder → backend `/api/stt` → OpenAI Whisper → transcript auto-sent
- **TTS**: Frontend fetches `/api/tts` → backend OpenAI TTS (tts-1) → audio streamed to browser `Audio` element
- **Silence Detection**: Web Audio API AnalyserNode auto-stops recording after **3s** of silence
- **Conversation Mode**: Tap agent icon → speak → 3s pause → transcribe → send → AI speaks reply → auto-restart recording → loop
- **Exit**: Tap agent icon again, or 3s silence with no speech exits conversation mode
- **No audio stored on disk** — streamed directly, discarded after use

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Widget (Vite — port 5173)                  │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │ ChatWidget   │  │ useVoice hook        │  │
│  │ • 🤖 agent   │──│ • conversationMode   │  │
│  │   icon btn   │  │ • MediaRecorder      │  │
│  │ • status bar │  │ • fetch /api/stt     │  │
│  │              │  │ • fetch /api/tts     │  │
│  │              │  │ • Audio element      │  │
│  │              │  │ • Silence detection   │  │
│  │              │  │ • 3s silence timeout  │  │
│  └─────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────┘
      │ POST /api/stt           │ POST /api/tts
      │ (multipart audio)       │ (JSON {text})
      ▼                         ▼
┌─────────────────────────────────────────────┐
│  Backend (Fastify — port 3000)              │
│  ┌──────────────────┐  ┌────────────────┐   │
│  │ stt.routes.ts    │  │ tts.routes.ts  │   │
│  │ • multipart      │  │ • JSON body    │   │
│  │ • Whisper API    │  │ • ttsProvider  │   │
│  └──────────────────┘  └────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │ ttsProvider.ts                       │   │
│  │ • OpenAI TTS (tts-1 / tts-1-hd)     │   │
│  │ • Text preprocessing                │   │
│  │ • Sentence chunking                 │   │
│  │ • Voice selection                    │   │
│  └──────────────────────────────────────┘   │
│  Feature-gated: FEATURE_VOICE_WEB           │
└─────────────────────────────────────────────┘
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `FEATURE_VOICE_WEB` | `false` | Master kill switch. When `true`, `/api/stt` and `/api/tts` are registered and the mic button appears. |
| `TTS_VOICE` | `nova` | Neural TTS voice. Options: `alloy`, `ash`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer` |
| `TTS_MODEL` | `tts-1` | TTS model. `tts-1` (fast, lower latency) or `tts-1-hd` (higher quality) |

> **Note**: Requires `OPENAI_API_KEY` to be set (same key used by chat). No additional API keys needed.

---

## Files Changed / Created

### Backend
| File | Change |
|---|---|
| `src/backend/src/config/env.ts` | Added `FEATURE_VOICE_WEB`, `TTS_VOICE`, `TTS_MODEL` to Zod schema |
| `src/backend/src/config/capabilities.ts` | Added `voiceWeb` to `AppCapabilities` interface + `deriveCapabilities()` |
| `src/backend/src/routes/stt.routes.ts` | **NEW** — POST `/api/stt` route (multipart audio → Whisper → transcript) |
| `src/backend/src/routes/tts.routes.ts` | **NEW** — POST `/api/tts` route (JSON text → OpenAI TTS → audio buffer) |
| `src/backend/src/voice/ttsProvider.ts` | **NEW** — TTS provider abstraction (OpenAI TTS, text preprocessing, chunking) |
| `src/backend/src/index.ts` | Import + register `sttRoutes` and `ttsRoutes` (gated by `FEATURE_VOICE_WEB`) |
| `src/backend/.env` | Added `FEATURE_VOICE_WEB=true`, `TTS_VOICE=nova`, `TTS_MODEL=tts-1` |
| `src/backend/.env.example` | Added documentation for voice config variables |
| `src/backend/package.json` | Added `@fastify/multipart` dependency |
| `src/backend/tests/capabilities.test.ts` | Added `voiceWeb` to all expected shapes + 3 new tests |
| `src/backend/tests/feature-flags.test.ts` | Added `FEATURE_VOICE_WEB` schema validation test |
| `src/backend/tests/tts-route.test.ts` | **NEW** — TTS route tests (feature gate, validation, synthesis, preprocessing) |

### Frontend (Widget)
| File | Change |
|---|---|
| `src/frontend/src/hooks/useVoice.ts` | **NEW** — React hook: state machine, MediaRecorder, silence detection, neural TTS via `/api/tts` + Audio element |
| `src/frontend/src/hooks/useCapabilities.ts` | Added `voiceWeb` to `AppCapabilities` interface |
| `src/frontend/src/components/ChatWidget.tsx` | Added mic button, auto-speak toggle, voice status bar, auto-speak on new assistant message |

---

## How It Works

### Conversation Mode Flow
1. User taps the **AI agent icon** (human silhouette SVG) in the input row
2. `conversationMode` activates → `autoSpeak` turns ON → `startRecording()` begins
3. `MediaRecorder` captures audio chunks (WebM/Opus preferred)
4. Web Audio API `AnalyserNode` monitors RMS volume level
5. When silence detected for **3s** (after speech) → auto-stop recording
6. Blob sent to `POST /api/stt` as `multipart/form-data`
7. Backend streams to OpenAI Whisper (`whisper-1`), returns `{ transcript }`
8. Transcript auto-sent via `sendMessageRef.current(text)` — hands-free flow
9. Assistant response arrives → TTS auto-speaks the reply (neural voice)
10. TTS finishes (`audio.onended`) → auto-restart recording → **loop back to step 3**
11. **Exit**: User taps agent icon again, OR 3s silence without any speech → conversation mode exits

### Neural TTS (Auto-Speak)
1. Auto-speak is automatically enabled when entering conversation mode
2. When new assistant message arrives:
   a. `voice.speak(text)` → `preprocessForSpeech()` strips code blocks, markdown
   b. `POST /api/tts` with `{ text }` → backend calls OpenAI TTS API
   c. Response: raw audio bytes (`audio/mpeg`) → blob → `URL.createObjectURL()`
   d. `new Audio(blobUrl).play()` → natural-sounding neural speech
3. **Barge-in**: starting a new recording stops audio playback immediately
4. After TTS finishes, recording auto-restarts (in conversation mode)

### State Machine
```
idle → recording → transcribing → idle
                ↘ error → idle (auto-recover 3s)

idle → speaking → idle
     (barge-in cancels)
```

---

## API Reference

### POST /api/stt

**Content-Type**: `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `audio` | File | ✅ | Audio recording (max 25 MB) |

**Accepted MIME types**: `audio/webm`, `audio/wav`, `audio/mp4`, `audio/mpeg`, `audio/ogg`, `audio/flac`

**Success Response** (200):
```json
{ "transcript": "I'd like to book an appointment for Tuesday" }
```

**Error Responses**:
- `400` — No file, empty file, or unsupported format
- `404` — `FEATURE_VOICE_WEB` not enabled
- `413` — File exceeds 25 MB
- `502` — Whisper transcription failed

### POST /api/tts

**Content-Type**: `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✅ | Text to synthesize (1–4096 chars after preprocessing) |
| `voice` | string | ❌ | Voice override: `alloy`, `ash`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer` |
| `format` | string | ❌ | Output format: `mp3` (default) or `wav` |

**Text Preprocessing** (server-side):
- Fenced code blocks (` ```...``` `) are stripped
- Inline code backticks are removed
- Excess whitespace is collapsed

**Success Response** (200):
- `Content-Type`: `audio/mpeg` or `audio/wav`
- `Cache-Control`: `no-store`
- Body: raw audio bytes

**Error Responses**:
- `400` — Empty text, text-only code blocks, or text exceeds 4096 chars
- `404` — `FEATURE_VOICE_WEB` not enabled
- `502` — OpenAI TTS API error

### GET /api/tts/voices

Returns available TTS voices and current defaults.

**Success Response** (200):
```json
{
  "voices": ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"],
  "default": "nova",
  "model": "tts-1"
}
```

**Error Responses**:
- `404` — `FEATURE_VOICE_WEB` not enabled

---

## Manual Test Checklist

### Prerequisites
- [ ] Backend running (`npm run dev` in `src/backend/`)
- [ ] Widget running (`npm run dev` in `src/frontend/`)
- [ ] `FEATURE_VOICE_WEB=true` in `src/backend/.env`
- [ ] `OPENAI_API_KEY` set with valid key
- [ ] HTTPS or localhost (mic requires secure context)

### Feature Flag Gating
- [ ] With `FEATURE_VOICE_WEB=false`: no agent icon visible, POST `/api/stt` and `/api/tts` return 404
- [ ] With `FEATURE_VOICE_WEB=true`: agent icon visible, routes respond

### Conversation Mode
- [ ] Click the AI agent icon (human silhouette) → browser asks for mic permission
- [ ] Grant permission → icon glows green, status bar shows "🎙️ Listening…"
- [ ] Speak a message → pause for 3 seconds
- [ ] Auto-stops recording, status bar shows "⏳ Processing…"
- [ ] Transcript auto-sent into chat — message appears immediately
- [ ] Assistant reply is auto-spoken with neural TTS
- [ ] After TTS finishes, recording auto-restarts (conversation loop)
- [ ] Click agent icon again → conversation mode exits, everything stops
- [ ] 3s silence without speaking → exits conversation mode automatically
- [ ] Click ✕ in status bar → ends conversation mode

### Neural TTS
- [ ] In conversation mode, assistant replies are spoken automatically
- [ ] Sound quality is natural-sounding neural voice
- [ ] Start speaking while AI is talking → speech stops immediately (barge-in)
- [ ] Code blocks in assistant replies are not spoken (stripped)

### Error Handling
- [ ] Deny mic permission → error shown, auto-recovers in 3s
- [ ] Send empty recording → no transcript injected
- [ ] Backend down → "Transcription failed" error, auto-recovers

### Capabilities Endpoint
- [ ] `GET /api/capabilities` returns `"voiceWeb": true` when enabled
- [ ] `GET /api/capabilities` returns `"voiceWeb": false` when disabled

---

## Reversal

To disable Web Voice Mode completely:

1. Set `FEATURE_VOICE_WEB=false` in `src/backend/.env`
2. Restart the backend

The mic button will disappear, the `/api/stt` and `/api/tts` routes won't be registered, and the `voiceWeb` capability will report `false`. No code removal needed.

To remove the code entirely, delete:
- `src/backend/src/routes/stt.routes.ts`
- `src/backend/src/routes/tts.routes.ts`
- `src/backend/src/voice/ttsProvider.ts`
- `src/frontend/src/hooks/useVoice.ts`
- Voice-related sections in `ChatWidget.tsx` (search for `voiceEnabled` / `voiceStyles`)
- `FEATURE_VOICE_WEB`, `TTS_VOICE`, `TTS_MODEL` from `env.ts`, `capabilities.ts`, `.env`, `.env.example`
- `voiceWeb` from `useCapabilities.ts` interface
- `@fastify/multipart` from `package.json`
- `src/backend/tests/tts-route.test.ts`
