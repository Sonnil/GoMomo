// ============================================================
// POST /api/stt — Browser Push-to-Talk Speech-to-Text
//
// Accepts multipart/form-data with a single `audio` field
// (WebM/Opus or WAV from MediaRecorder), sends it to the
// OpenAI Whisper API, and returns the transcript.
//
// Feature-gated by FEATURE_VOICE_WEB.
// No audio is stored on disk — streamed directly to OpenAI.
// ============================================================

import { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import OpenAI, { toFile } from 'openai';
import { env } from '../config/env.js';

// ── Constants ───────────────────────────────────────────────
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB (Whisper limit)
const ALLOWED_MIME_TYPES = new Set([
  'audio/webm',
  'audio/wav',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/flac',
]);

// Map MIME type → file extension (Whisper needs a filename hint)
const MIME_TO_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

// ── OpenAI client (reuses same key as chat) ─────────────────
const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.OPENAI_BASE_URL,
});

// ── Route Registration ──────────────────────────────────────
export async function sttRoutes(app: FastifyInstance): Promise<void> {
  // Register multipart parser scoped to this plugin
  await app.register(multipart, {
    limits: {
      fileSize: MAX_AUDIO_BYTES,
      files: 1,
    },
  });

  app.post('/api/stt', async (req, reply) => {
    // ── Feature gate (belt + suspenders — route shouldn't be
    //    registered at all when disabled, but guard anyway) ───
    if (env.FEATURE_VOICE_WEB !== 'true') {
      return reply.code(404).send({ error: 'Voice web feature is not enabled.' });
    }

    // ── Parse multipart ─────────────────────────────────────
    const data = await req.file();
    if (!data) {
      return reply.code(400).send({ error: 'No audio file uploaded. Send a `audio` field.' });
    }

    // ── Validate MIME type ──────────────────────────────────
    const mime = data.mimetype.split(';')[0].trim(); // strip codec params
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      return reply.code(400).send({
        error: `Unsupported audio format: ${mime}. Accepted: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      });
    }

    // ── Read audio into buffer (no disk) ────────────────────
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length === 0) {
      return reply.code(400).send({ error: 'Audio file is empty.' });
    }

    if (audioBuffer.length > MAX_AUDIO_BYTES) {
      return reply.code(413).send({ error: 'Audio file exceeds 25 MB limit.' });
    }

    // ── Call OpenAI Whisper ──────────────────────────────────
    try {
      const ext = MIME_TO_EXT[mime] || 'webm';
      const file = await toFile(audioBuffer, `recording.${ext}`, { type: mime });

      const transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file,
        language: 'en', // default — can be made configurable
      });

      return reply.send({
        transcript: transcription.text,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, 'STT transcription failed');
      return reply.code(502).send({
        error: 'Transcription failed. Please try again.',
        detail: env.NODE_ENV === 'development' ? message : undefined,
      });
    }
  });
}
