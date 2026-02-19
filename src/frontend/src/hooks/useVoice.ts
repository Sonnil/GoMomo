// ============================================================
// useVoice — Conversational Voice Mode (hands-free)
//
// Conversation Mode (single agent icon):
//   Tap agent icon → conversationMode ON → autoSpeak ON → start recording
//   User speaks → 3s silence → auto-stop → transcribe → send → AI responds
//   → TTS speaks response → auto-restart recording → loop
//   Tap agent icon again → exit conversation mode
//   Empty transcript (silence only) → auto-restart recording (stays active)
//   Conversation mode remains active until user taps icon or navigates away
//
// State machine: idle → recording → transcribing → idle
//                                ↘ error → idle
// TTS: idle → speaking → idle (barge-in cancels)
//
// Silence Detection: Uses Web Audio API AnalyserNode to monitor
// microphone RMS level. When audio stays below SILENCE_THRESHOLD
// for 3 seconds, recording auto-stops and transcribes.
//
// TTS: Neural speech via OpenAI TTS API (POST /api/tts).
// Audio played through HTML5 Audio element with barge-in support.
//
// Token Usage: No tokens consumed during recording (only local
// MediaRecorder + Web Audio). Tokens consumed only on STT/TTS API calls.
//
// Dependencies: MediaRecorder API, AudioContext, fetch, Audio
// No audio stored on disk — streamed to /api/stt then discarded.
// ============================================================

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';

// ── Types ───────────────────────────────────────────────────

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'speaking' | 'error';

export interface UseVoiceOptions {
  /** Base URL for the backend API (e.g. http://localhost:3000) */
  apiUrl: string;
  /** Called with the transcript text — caller decides what to do with it */
  onTranscript: (text: string) => void;
  /** When true, automatically speak assistant responses via TTS */
  autoSpeak?: boolean;
  /** Seconds of silence before auto-stopping (default: 3) */
  silenceTimeout?: number;
}

export interface UseVoiceReturn {
  /** Current state of the voice subsystem */
  state: VoiceState;
  /** Human-readable error message (cleared on next action) */
  errorMessage: string | null;
  /** Start recording audio from the microphone */
  startRecording: () => void;
  /** Stop recording and begin transcription */
  stopRecording: () => void;
  /** Toggle recording (tap once to start, auto-stops on silence) */
  toggleRecording: () => void;
  /** Speak text using neural TTS (OpenAI via /api/tts) */
  speak: (text: string) => void;
  /** Cancel any in-progress speech (barge-in) */
  cancelSpeech: () => void;
  /** Whether browser supports the required APIs */
  isSupported: boolean;
  /** Whether conversation mode is active (STT+TTS loop) */
  conversationMode: boolean;
  /** Enter or exit conversation mode */
  toggleConversationMode: () => void;
}

// ── Constants ───────────────────────────────────────────────

const PREFERRED_MIME = 'audio/webm;codecs=opus';
const FALLBACK_MIMES = ['audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** RMS below this is considered silence (0–1 scale, ~0.01 = quiet room) */
const SILENCE_THRESHOLD = 0.015;

/** How often to check audio level (ms) */
const SILENCE_CHECK_INTERVAL_MS = 200;

function getRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  if (MediaRecorder.isTypeSupported(PREFERRED_MIME)) return PREFERRED_MIME;
  for (const mime of FALLBACK_MIMES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return ''; // let browser choose default
}

// ── TTS Text Preprocessing ─────────────────────────────────

/** Strip fenced code blocks — not useful for speech */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' (code omitted) ');
}

/** Strip inline code — replace with just the identifier */
function stripInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, '$1');
}

/** Clean text for TTS: remove code, excess whitespace, markdown artifacts */
export function preprocessForSpeech(text: string): string {
  let clean = stripCodeBlocks(text);
  clean = stripInlineCode(clean);
  // Remove markdown bold/italic markers
  clean = clean.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  clean = clean.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
  // Remove markdown headers
  clean = clean.replace(/^#{1,6}\s+/gm, '');
  // Remove markdown links — keep text
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Collapse whitespace
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean;
}

// ── Auto-Speak localStorage key ─────────────────────────────

const AUTO_SPEAK_KEY = 'gomomo_auto_speak';

export function getAutoSpeak(): boolean {
  try {
    return localStorage.getItem(AUTO_SPEAK_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setAutoSpeak(value: boolean): void {
  try {
    localStorage.setItem(AUTO_SPEAK_KEY, String(value));
  } catch { /* localStorage may be blocked */ }
}

// ── Silence Detection Helper ────────────────────────────────

/** Computes RMS (root mean square) volume from analyser frequency data */
function computeRMS(analyser: AnalyserNode, dataArray: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const val = (dataArray[i] - 128) / 128; // normalize to -1..1
    sum += val * val;
  }
  return Math.sqrt(sum / dataArray.length);
}

// ── Hook ────────────────────────────────────────────────────

export function useVoice({
  apiUrl,
  onTranscript,
  autoSpeak,
  silenceTimeout = 3,
}: UseVoiceOptions): UseVoiceReturn {
  const [state, setState] = useState<VoiceState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conversationMode, setConversationMode] = useState(false);

  // ── Stable ref for current state — avoids cascading useCallback invalidation ──
  const stateRef = useRef<VoiceState>(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const hasSpokenRef = useRef(false);
  /** Ref to track conversationMode inside callbacks (avoids stale closures) */
  const conversationModeRef = useRef(false);
  /** Ref to startRecording so TTS onended can auto-restart recording */
  const startRecordingRef = useRef<(() => void) | null>(null);

  // ── Neural TTS Audio element refs ─────────────────────
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsBlobUrlRef = useRef<string | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);

  const silenceDurationMs = silenceTimeout * 1000;

  // ── Browser support check ───────────────────────────────
  const isSupported =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof MediaRecorder !== 'undefined';

  // ── Cleanup helpers ─────────────────────────────────────
  const cleanupSilenceDetection = useCallback(() => {
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    silenceStartRef.current = null;
    hasSpokenRef.current = false;
  }, []);

  /** Stop TTS audio, revoke blob URL, abort in-flight fetch */
  const cleanupTTSAudio = useCallback(() => {
    // Abort any in-flight TTS fetch
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    // Stop and release audio element
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.removeAttribute('src');
      ttsAudioRef.current.load(); // release media resources
      ttsAudioRef.current = null;
    }
    // Revoke blob URL to free memory
    if (ttsBlobUrlRef.current) {
      URL.revokeObjectURL(ttsBlobUrlRef.current);
      ttsBlobUrlRef.current = null;
    }
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────
  useEffect(() => {
    return () => {
      // Stop any active recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      // Release mic
      streamRef.current?.getTracks().forEach((t) => t.stop());
      // Abort in-flight fetch
      abortRef.current?.abort();
      // Clean up audio analysis
      cleanupSilenceDetection();
      // Clean up TTS audio
      cleanupTTSAudio();
    };
  }, [cleanupSilenceDetection, cleanupTTSAudio]);

  // ── Transcribe audio blob ───────────────────────────────
  const transcribe = useCallback(
    async (blob: Blob) => {
      setState('transcribing');
      setErrorMessage(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const formData = new FormData();
        formData.append('audio', blob, 'recording.webm');

        const res = await fetch(`${apiUrl}/api/stt`, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(body.error || `Transcription failed (HTTP ${res.status})`);
        }

        const data: { transcript: string } = await res.json();
        const text = data.transcript?.trim();

        if (text) {
          onTranscript(text);
        } else if (conversationModeRef.current) {
          // Empty transcript in conversation mode → user was silent
          // No tokens consumed during silence (only MediaRecorder + Web Audio)
          // → keep conversation mode active and auto-restart recording
          setState('idle');
          setTimeout(() => {
            if (conversationModeRef.current && startRecordingRef.current) {
              startRecordingRef.current();
            }
          }, 300);
          return;
        }

        setState('idle');
      } catch (err: unknown) {
        if ((err as Error).name === 'AbortError') {
          setState('idle');
          return;
        }
        const msg = err instanceof Error ? err.message : 'Transcription failed';
        setErrorMessage(msg);
        setState('error');
        // Auto-recover after 3s
        setTimeout(() => setState('idle'), 3000);
      } finally {
        abortRef.current = null;
      }
    },
    [apiUrl, onTranscript],
  );

  // ── Start Recording (with silence detection) ───────────
  const startRecording = useCallback(async () => {
    if (!isSupported) {
      setErrorMessage('Voice input is not supported in this browser.');
      setState('error');
      return;
    }

    // Cancel any speech when user starts talking (barge-in)
    cleanupTTSAudio();
    if (stateRef.current === 'speaking') {
      setState('idle');
    }

    setErrorMessage(null);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // ── Set up Web Audio API for silence detection ──────
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.fftSize);

      // Track silence — only trigger after user has spoken at least once
      silenceStartRef.current = null;
      hasSpokenRef.current = false;

      const mimeType = getRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        // Release mic immediately
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        cleanupSilenceDetection();

        const blob = new Blob(chunksRef.current, {
          type: mimeType || 'audio/webm',
        });
        chunksRef.current = [];

        if (blob.size > 0) {
          transcribe(blob);
        } else {
          setState('idle');
        }
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        cleanupSilenceDetection();
        setErrorMessage('Recording failed. Please try again.');
        setState('error');
        setTimeout(() => setState('idle'), 3000);
      };

      recorder.start();
      setState('recording');

      // ── Silence detection loop ──────────────────────────
      silenceTimerRef.current = setInterval(() => {
        // Guard: if recorder was already stopped, clean up
        if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') {
          cleanupSilenceDetection();
          return;
        }

        const rms = computeRMS(analyser, dataArray);

        if (rms > SILENCE_THRESHOLD) {
          // User is speaking — reset silence timer
          hasSpokenRef.current = true;
          silenceStartRef.current = null;
        } else if (hasSpokenRef.current) {
          // Audio is quiet AND user has spoken before
          if (silenceStartRef.current === null) {
            silenceStartRef.current = Date.now();
          } else if (Date.now() - silenceStartRef.current >= silenceDurationMs) {
            // Silence exceeded threshold — auto-stop
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              mediaRecorderRef.current.stop();
            }
            // Cleanup happens in recorder.onstop
          }
        }
      }, SILENCE_CHECK_INTERVAL_MS);
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : 'Microphone access denied';
      if (msg.includes('not allowed') || msg.includes('denied') || msg.includes('NotAllowedError')) {
        msg = 'Microphone access denied. Please allow mic permissions in your browser and try again.';
      }
      setErrorMessage(msg);
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }, [isSupported, transcribe, cleanupSilenceDetection, cleanupTTSAudio, silenceDurationMs]);

  // Keep startRecordingRef in sync for TTS auto-restart
  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);
  // ── Stop Recording ──────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      // State transitions happen in onstop handler
    }
  }, []);

  // ── Toggle ──────────────────────────────────────────────
  const toggleRecording = useCallback(() => {
    if (stateRef.current === 'recording') {
      stopRecording();
    } else if (stateRef.current === 'idle') {
      startRecording();
    }
    // Ignore toggle during transcribing/speaking/error states
  }, [startRecording, stopRecording]);

  // ── Text-to-Speech (Neural TTS via /api/tts) ─────────
  const speak = useCallback(
    async (text: string) => {
      // Preprocess: strip code blocks, markdown, etc.
      const cleaned = preprocessForSpeech(text);
      if (!cleaned || cleaned.length < 1) return;

      // Cancel any ongoing speech first
      cleanupTTSAudio();

      setState('speaking');

      const controller = new AbortController();
      ttsAbortRef.current = controller;

      try {
        const res = await fetch(`${apiUrl}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cleaned }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // Non-fatal — just don't speak
          console.warn('[useVoice] TTS request failed:', res.status);
          setState('idle');
          return;
        }

        const audioBlob = await res.blob();
        const blobUrl = URL.createObjectURL(audioBlob);
        ttsBlobUrlRef.current = blobUrl;

        const audio = new Audio(blobUrl);
        ttsAudioRef.current = audio;

        audio.onended = () => {
          cleanupTTSAudio();
          setState('idle');
          // In conversation mode, auto-restart recording after TTS finishes
          if (conversationModeRef.current && startRecordingRef.current) {
            // Small delay to let audio resources settle
            setTimeout(() => {
              if (conversationModeRef.current && startRecordingRef.current) {
                startRecordingRef.current();
              }
            }, 300);
          }
        };

        audio.onerror = () => {
          cleanupTTSAudio();
          setState('idle');
        };

        await audio.play();
      } catch (err: unknown) {
        if ((err as Error).name === 'AbortError') {
          // Barge-in — expected, state already handled by caller
          return;
        }
        console.warn('[useVoice] TTS error:', err);
        cleanupTTSAudio();
        setState('idle');
      }
    },
    [apiUrl, cleanupTTSAudio],
  );

  const cancelSpeech = useCallback(() => {
    cleanupTTSAudio();
    if (stateRef.current === 'speaking') {
      setState('idle');
    }
  }, [cleanupTTSAudio]);

  // ── Exit Conversation Mode ──────────────────────────────
  const exitConversationMode = useCallback(() => {
    setConversationMode(false);
    conversationModeRef.current = false;
    // Stop everything: recording, TTS, pending transcription
    cleanupTTSAudio();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    cleanupSilenceDetection();
    abortRef.current?.abort();
    setState('idle');
  }, [cleanupTTSAudio, cleanupSilenceDetection]);

  // ── Toggle Conversation Mode ────────────────────────────
  const toggleConversationMode = useCallback(() => {
    if (conversationModeRef.current) {
      // Currently active → exit
      exitConversationMode();
    } else {
      // Activate: set mode, then start recording
      setConversationMode(true);
      conversationModeRef.current = true;
      startRecording();
    }
  }, [exitConversationMode, startRecording]);

  // ── Stable return object — prevents consumer useEffect cascades ──
  // Without useMemo, every render creates a new object reference, which
  // triggers useEffect([..., voice]) in ChatWidget on every render,
  // causing setState → re-render → new object → re-fire → hang.
  return useMemo(
    () => ({
      state,
      errorMessage,
      startRecording,
      stopRecording,
      toggleRecording,
      speak,
      cancelSpeech,
      isSupported,
      conversationMode,
      toggleConversationMode,
    }),
    [
      state,
      errorMessage,
      startRecording,
      stopRecording,
      toggleRecording,
      speak,
      cancelSpeech,
      isSupported,
      conversationMode,
      toggleConversationMode,
    ],
  );
}
