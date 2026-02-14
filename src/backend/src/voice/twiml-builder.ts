/**
 * TwiML Builder — Construct Twilio VoiceResponse XML
 *
 * Uses Twilio's built-in <Gather speech> for STT and <Say> for TTS.
 * This keeps the MVP simple — no external STT/TTS providers, no
 * Media Streams WebSocket. Twilio handles audio encoding/decoding.
 */

import { env } from '../config/env.js';

// We build TwiML as raw XML strings to avoid requiring the full twilio SDK.
// This is intentional — the twilio SDK is ~15MB and we only need XML generation.

export interface GatherOptions {
  prompt: string;
  action: string;      // URL for Twilio to POST speech result to
  timeout?: number;    // Seconds to wait for speech (default: 3)
  speechTimeout?: string; // "auto" or seconds
  bargeIn?: boolean;   // Allow caller to interrupt <Say>
  numDigits?: number;  // For DTMF fallback (optional)
  hints?: string;      // Speech recognition hints
  pauseBeforeSec?: number; // Optional pause before the prompt (natural pacing)
}

/**
 * Build a TwiML response that says something and gathers speech input.
 */
export function buildGatherTwiML(options: GatherOptions): string {
  const {
    prompt,
    action,
    timeout = 3,
    speechTimeout = env.VOICE_SPEECH_TIMEOUT,
    bargeIn = true,
    hints,
    pauseBeforeSec,
  } = options;

  const voice = env.VOICE_TTS_VOICE;
  const language = env.VOICE_TTS_LANGUAGE;
  const speechModel = env.VOICE_SPEECH_MODEL;

  // Escape XML special characters in prompt
  const escaped = escapeXml(prompt);

  const hintsAttr = hints ? ` hints="${escapeXml(hints)}"` : '';
  const pauseTag = pauseBeforeSec ? `\n    <Pause length="${pauseBeforeSec}"/>` : '';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Gather input="speech" action="${escapeXml(action)}" method="POST"`,
    `    timeout="${timeout}" speechTimeout="${speechTimeout}"`,
    `    speechModel="${speechModel}" language="${language}"`,
    `    enhanced="true"${bargeIn ? ' bargeIn="true"' : ''}${hintsAttr}>${pauseTag}`,
    `    <Say voice="${voice}" language="${language}">${escaped}</Say>`,
    `  </Gather>`,
    // Fallback if no speech detected — redirect back to same action with empty
    `  <Redirect method="POST">${escapeXml(action)}?timeout=true</Redirect>`,
    '</Response>',
  ].join('\n');
}

/**
 * Build a TwiML response that just says something and hangs up.
 * Automatically inserts a brief pause between sentences for natural pacing.
 */
export function buildSayHangupTwiML(message: string): string {
  const voice = env.VOICE_TTS_VOICE;
  const language = env.VOICE_TTS_LANGUAGE;
  // Split at sentence boundaries and interleave short pauses
  const parts = splitForPacing(message);
  const sayTags = parts.map((p) =>
    `  <Say voice="${voice}" language="${language}">${escapeXml(p)}</Say>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    ...sayTags,
    `  <Hangup/>`,
    '</Response>',
  ].join('\n');
}

/**
 * Build a TwiML response that says something then redirects to continue.
 */
export function buildSayRedirectTwiML(message: string, redirectUrl: string): string {
  const voice = env.VOICE_TTS_VOICE;
  const language = env.VOICE_TTS_LANGUAGE;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Say voice="${voice}" language="${language}">${escapeXml(message)}</Say>`,
    `  <Redirect method="POST">${escapeXml(redirectUrl)}</Redirect>`,
    '</Response>',
  ].join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Split a message into sentence segments interleaved with <Pause> tags
 * for natural voice pacing. Groups of 1-2 sentences per Say tag with
 * a short pause between groups.
 */
function splitForPacing(message: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace
  const sentences = message
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);

  if (sentences.length <= 2) return [message]; // Short messages — no splitting

  // Group sentences into pairs with SSML-style natural breaks
  const parts: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const group = sentences.slice(i, i + 2).join(' ');
    parts.push(group);
  }
  return parts;
}
