// ============================================================
// TTS Provider — Neural Text-to-Speech Abstraction
//
// Provides a clean interface for generating speech audio from
// text. Currently implements OpenAI TTS (tts-1 / tts-1-hd).
//
// Features:
//   • Voice selection via TTS_VOICE env var
//   • Model selection via TTS_MODEL env var
//   • Text preprocessing: code block stripping, sentence chunking
//   • Returns raw audio buffer (mp3 or wav) — no disk storage
//
// Usage:
//   const audio = await ttsProvider.synthesize('Hello!');
//   // audio: { buffer: Buffer, contentType: string }
// ============================================================

import OpenAI from 'openai';
import { env } from '../config/env.js';

// ── Types ───────────────────────────────────────────────────

export type TTSFormat = 'mp3' | 'wav';

export type TTSVoice = 'alloy' | 'ash' | 'coral' | 'echo' | 'fable' | 'nova' | 'onyx' | 'sage' | 'shimmer';

export const VALID_VOICES: ReadonlySet<string> = new Set<string>([
  'alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer',
]);

export const VALID_FORMATS: ReadonlySet<string> = new Set<string>(['mp3', 'wav']);

export interface TTSResult {
  /** Raw audio bytes */
  buffer: Buffer;
  /** MIME content type (audio/mpeg or audio/wav) */
  contentType: string;
}

export interface TTSOptions {
  /** Override the default voice */
  voice?: string;
  /** Output format: mp3 (default) or wav */
  format?: TTSFormat;
}

// ── Constants ───────────────────────────────────────────────

/** Maximum text length to synthesize in one request (characters) */
export const MAX_TEXT_LENGTH = 4096;

/** Minimum text length */
export const MIN_TEXT_LENGTH = 1;

const FORMAT_TO_CONTENT_TYPE: Record<TTSFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

// ── Text Preprocessing ─────────────────────────────────────

/**
 * Strip fenced code blocks (```…```) and replace with a short
 * spoken summary. Inline `code` is kept as-is.
 */
export function stripCodeBlocks(text: string): string {
  // Match fenced code blocks (``` or ~~~)
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '(code example omitted)');
}

/**
 * Split text into sentence-sized chunks for more natural TTS.
 * Each chunk is ≤ maxLen characters. Splits on sentence boundaries
 * (. ! ?) then falls back to commas, then hard-splits.
 */
export function chunkText(text: string, maxLen = 4096): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxLen) return [cleaned];

  const chunks: string[] = [];
  let remaining = cleaned;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining.trim());
      break;
    }

    // Try to split at sentence boundary
    let splitIdx = -1;
    const searchWindow = remaining.slice(0, maxLen);

    // Look for last sentence-ending punctuation followed by space
    for (let i = searchWindow.length - 1; i >= Math.floor(maxLen * 0.3); i--) {
      if ((searchWindow[i] === '.' || searchWindow[i] === '!' || searchWindow[i] === '?') &&
          (i + 1 >= searchWindow.length || searchWindow[i + 1] === ' ' || searchWindow[i + 1] === '\n')) {
        splitIdx = i + 1;
        break;
      }
    }

    // Fallback: split at last comma or space
    if (splitIdx < 0) {
      const lastComma = searchWindow.lastIndexOf(', ');
      if (lastComma > Math.floor(maxLen * 0.3)) {
        splitIdx = lastComma + 2;
      } else {
        const lastSpace = searchWindow.lastIndexOf(' ');
        splitIdx = lastSpace > 0 ? lastSpace + 1 : maxLen;
      }
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  return chunks.filter(Boolean);
}

/**
 * Preprocess text for TTS: strip code blocks, collapse whitespace.
 * Returns empty string if the result contains only placeholder text
 * (i.e. the original was code-only with no speakable content).
 */
export function preprocessForTTS(text: string): string {
  let processed = stripCodeBlocks(text);
  // Collapse multiple newlines / whitespace
  processed = processed.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ');
  processed = processed.replace(/\s{2,}/g, ' ');
  processed = processed.trim();

  // If the result is ONLY placeholder(s), the original was code-only → nothing to speak
  const withoutPlaceholders = processed.replace(/\(code example omitted\)/g, '').replace(/[.\s]+/g, '').trim();
  if (!withoutPlaceholders) return '';

  return processed;
}

// ── Provider ────────────────────────────────────────────────

class OpenAITTSProvider {
  private client: OpenAI;
  private defaultVoice: string;
  private model: string;

  constructor() {
    this.client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL,
    });
    this.defaultVoice = env.TTS_VOICE ?? 'nova';
    this.model = env.TTS_MODEL ?? 'tts-1';
  }

  /**
   * Synthesize speech from text.
   * Returns raw audio buffer + content type.
   * No audio stored on disk.
   */
  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    const voice = options.voice && VALID_VOICES.has(options.voice)
      ? options.voice
      : this.defaultVoice;
    const format: TTSFormat = options.format && VALID_FORMATS.has(options.format)
      ? options.format as TTSFormat
      : 'mp3';

    const response = await this.client.audio.speech.create({
      model: this.model,
      voice: voice as TTSVoice,
      input: text,
      response_format: format,
    });

    // Response is a Response-like object with arrayBuffer()
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      contentType: FORMAT_TO_CONTENT_TYPE[format],
    };
  }

  /** Get the default voice name */
  getDefaultVoice(): string {
    return this.defaultVoice;
  }

  /** Get the model in use */
  getModel(): string {
    return this.model;
  }
}

// ── Singleton Export ────────────────────────────────────────

export const ttsProvider = new OpenAITTSProvider();
