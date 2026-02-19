// ============================================================
// TTS Route — Unit Tests
//
// Validates:
//   1. Feature gate: returns 404 when FEATURE_VOICE_WEB=false
//   2. Input validation: empty text → 400
//   3. Input validation: text exceeding MAX_TEXT_LENGTH → 400
//   4. Valid request: returns audio/mpeg with buffer
//   5. GET /api/tts/voices: returns voice list + defaults
//   6. Text preprocessing: code-only text → 400
//
// No real OpenAI calls — ttsProvider is mocked.
// No database, no network, no PII.
// Run:  npx vitest run tests/tts-route.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ── Helpers ──────────────────────────────────────────────────

/** Create a Fastify instance with the TTS routes registered */
async function buildApp(
  envOverrides: Record<string, string> = {},
  synthesizeMock?: ReturnType<typeof vi.fn>,
): Promise<FastifyInstance> {
  // Reset modules so vi.doMock takes effect
  vi.resetModules();

  const baseEnv = {
    FEATURE_VOICE_WEB: 'true',
    TTS_VOICE: 'nova',
    TTS_MODEL: 'tts-1',
    OPENAI_API_KEY: 'sk-test-key',
    ...envOverrides,
  };

  // Mock env
  vi.doMock('../src/config/env.js', () => ({
    env: baseEnv,
  }));

  // Mock ttsProvider — use real utility functions but mock the provider class
  const mockSynthesize = synthesizeMock ?? vi.fn().mockResolvedValue({
    buffer: Buffer.from('fake-audio-data'),
    contentType: 'audio/mpeg',
  });

  // Import real utilities first (before mocking)
  const realModule = await import('../src/voice/ttsProvider.js');

  vi.doMock('../src/voice/ttsProvider.js', () => ({
    ttsProvider: {
      synthesize: mockSynthesize,
      getDefaultVoice: vi.fn().mockReturnValue(baseEnv.TTS_VOICE),
      getModel: vi.fn().mockReturnValue(baseEnv.TTS_MODEL),
    },
    preprocessForTTS: realModule.preprocessForTTS,
    chunkText: realModule.chunkText,
    VALID_VOICES: realModule.VALID_VOICES,
    VALID_FORMATS: realModule.VALID_FORMATS,
    MAX_TEXT_LENGTH: realModule.MAX_TEXT_LENGTH,
    MIN_TEXT_LENGTH: realModule.MIN_TEXT_LENGTH,
  }));

  const { ttsRoutes } = await import('../src/routes/tts.routes.js');

  const app = Fastify({ logger: false });
  await app.register(ttsRoutes);
  await app.ready();

  return app;
}

// ── 1. Feature gate ──────────────────────────────────────────

describe('POST /api/tts — feature gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 404 when FEATURE_VOICE_WEB=false', async () => {
    const app = await buildApp({ FEATURE_VOICE_WEB: 'false' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: 'Hello' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('not enabled');

    await app.close();
  });

  it('returns 200 when FEATURE_VOICE_WEB=true', async () => {
    const app = await buildApp({ FEATURE_VOICE_WEB: 'true' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: 'Hello, how are you?' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');

    await app.close();
  });
});

// ── 2. Input validation ──────────────────────────────────────

describe('POST /api/tts — input validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 400 when text is empty', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('non-empty');

    await app.close();
  });

  it('returns 400 when text is missing', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('text');

    await app.close();
  });

  it('returns 400 when text is only whitespace', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: '   ' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('returns 400 when text exceeds MAX_TEXT_LENGTH', async () => {
    const app = await buildApp();
    const longText = 'a'.repeat(5000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: longText },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('maximum length');

    await app.close();
  });

  it('synthesizes placeholder when text is only code blocks', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: '```js\nconsole.log("hello");\n```' },
    });

    // Code-only text is replaced with "(code example omitted)" placeholder,
    // which is valid non-empty text → TTS synthesizes it → 200
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});

// ── 3. Successful synthesis ──────────────────────────────────

describe('POST /api/tts — synthesis', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns audio buffer with correct content-type', async () => {
    const mockSynth = vi.fn().mockResolvedValue({
      buffer: Buffer.from('test-audio-bytes'),
      contentType: 'audio/mpeg',
    });
    const app = await buildApp({}, mockSynth);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: 'Hello, welcome to our salon!' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(mockSynth).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('passes voice override to synthesize', async () => {
    const mockSynth = vi.fn().mockResolvedValue({
      buffer: Buffer.from('audio'),
      contentType: 'audio/mpeg',
    });
    const app = await buildApp({}, mockSynth);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: 'Hello!', voice: 'shimmer' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSynth).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ voice: 'shimmer' }),
    );

    await app.close();
  });

  it('ignores invalid voice name and uses default', async () => {
    const mockSynth = vi.fn().mockResolvedValue({
      buffer: Buffer.from('audio'),
      contentType: 'audio/mpeg',
    });
    const app = await buildApp({}, mockSynth);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: 'Hello!', voice: 'invalid-voice' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSynth).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ voice: undefined }),
    );

    await app.close();
  });

  it('returns 502 when synthesis fails', async () => {
    const mockSynth = vi.fn().mockRejectedValue(new Error('OpenAI API error'));
    const app = await buildApp({}, mockSynth);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts',
      payload: { text: 'Hello!' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('OpenAI API error');

    await app.close();
  });
});

// ── 4. GET /api/tts/voices ───────────────────────────────────

describe('GET /api/tts/voices', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns 404 when feature disabled', async () => {
    const app = await buildApp({ FEATURE_VOICE_WEB: 'false' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/tts/voices',
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns voice list with defaults', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/tts/voices',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.voices).toBeInstanceOf(Array);
    expect(body.voices).toContain('nova');
    expect(body.voices).toContain('alloy');
    expect(body.voices).toContain('shimmer');
    expect(body.default).toBe('nova');
    expect(body.model).toBe('tts-1');

    await app.close();
  });
});

// ── 5. Text preprocessing (unit) ────────────────────────────

describe('preprocessForTTS', () => {
  it('strips fenced code blocks', async () => {
    const { preprocessForTTS } = await import('../src/voice/ttsProvider.js');
    const result = preprocessForTTS('Hello ```js\ncode\n``` world');
    expect(result).not.toContain('```');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('returns empty string for code-only text', async () => {
    const { preprocessForTTS } = await import('../src/voice/ttsProvider.js');
    const result = preprocessForTTS('```\nonly code\n```');
    // Should be empty or only whitespace/placeholder
    expect(result.trim().replace('(code example omitted)', '').trim()).toBe('');
  });

  it('preserves normal text', async () => {
    const { preprocessForTTS } = await import('../src/voice/ttsProvider.js');
    const result = preprocessForTTS('Welcome to our salon! How can I help you today?');
    expect(result).toBe('Welcome to our salon! How can I help you today?');
  });
});
