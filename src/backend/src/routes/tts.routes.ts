// ============================================================
// POST /api/tts — Neural Text-to-Speech
//
// Accepts JSON { text, voice?, format? } and returns audio bytes.
// Uses OpenAI TTS (tts-1) for natural-sounding speech.
//
// Feature-gated by FEATURE_VOICE_WEB.
// No audio is stored on disk — generated and streamed directly.
// ============================================================

import { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import {
  ttsProvider,
  preprocessForTTS,
  chunkText,
  VALID_VOICES,
  VALID_FORMATS,
  MAX_TEXT_LENGTH,
  MIN_TEXT_LENGTH,
} from '../voice/ttsProvider.js';

// ── Route Registration ──────────────────────────────────────
export async function ttsRoutes(app: FastifyInstance): Promise<void> {

  app.post('/api/tts', async (req, reply) => {
    // ── Feature gate (belt + suspenders) ────────────────────
    if (env.FEATURE_VOICE_WEB !== 'true') {
      return reply.code(404).send({ error: 'Voice web feature is not enabled.' });
    }

    // ── Parse & validate body ───────────────────────────────
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Request body must be JSON with a "text" field.' });
    }

    const rawText = body.text;
    if (typeof rawText !== 'string' || rawText.trim().length < MIN_TEXT_LENGTH) {
      return reply.code(400).send({ error: 'Field "text" is required and must be a non-empty string.' });
    }

    // ── Preprocess text ─────────────────────────────────────
    const processed = preprocessForTTS(rawText);
    if (!processed) {
      return reply.code(400).send({ error: 'Text is empty after preprocessing (e.g. only code blocks).' });
    }

    if (processed.length > MAX_TEXT_LENGTH) {
      return reply.code(400).send({
        error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters (got ${processed.length}).`,
      });
    }

    // ── Validate optional params ────────────────────────────
    const voice = typeof body.voice === 'string' && VALID_VOICES.has(body.voice)
      ? body.voice
      : undefined;
    const format = typeof body.format === 'string' && VALID_FORMATS.has(body.format)
      ? (body.format as 'mp3' | 'wav')
      : 'mp3';

    // ── Chunk text if needed ────────────────────────────────
    // For very long text, we chunk into sentences and concatenate
    // the audio buffers. For typical assistant messages (<4096 chars)
    // this produces a single chunk.
    const chunks = chunkText(processed, MAX_TEXT_LENGTH);

    try {
      if (chunks.length === 1) {
        // Single chunk — simple path
        const result = await ttsProvider.synthesize(chunks[0], { voice, format });
        return reply
          .code(200)
          .header('Content-Type', result.contentType)
          .header('Cache-Control', 'no-store')
          .send(result.buffer);
      }

      // Multiple chunks — synthesize each and concatenate
      // (For MP3, concatenation of MP3 frames works correctly)
      const buffers: Buffer[] = [];
      let contentType = 'audio/mpeg';

      for (const chunk of chunks) {
        const result = await ttsProvider.synthesize(chunk, { voice, format });
        buffers.push(result.buffer);
        contentType = result.contentType;
      }

      const combined = Buffer.concat(buffers);
      return reply
        .code(200)
        .header('Content-Type', contentType)
        .header('Cache-Control', 'no-store')
        .send(combined);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'TTS synthesis failed';
      req.log.error({ err }, 'TTS synthesis error');
      return reply.code(502).send({ error: msg });
    }
  });

  // ── GET /api/tts/voices — Available voices ────────────────
  app.get('/api/tts/voices', async (_req, reply) => {
    if (env.FEATURE_VOICE_WEB !== 'true') {
      return reply.code(404).send({ error: 'Voice web feature is not enabled.' });
    }

    return reply.send({
      voices: [...VALID_VOICES],
      default: ttsProvider.getDefaultVoice(),
      model: ttsProvider.getModel(),
    });
  });
}
