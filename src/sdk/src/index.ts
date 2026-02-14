// ============================================================
// AI Receptionist Client SDK
// @eon/receptionist-sdk
//
// Embed AI-powered appointment booking on any website or app.
// ============================================================

export { ReceptionistClient } from './client.js';
export type {
  ReceptionistConfig,
  ReceptionistEvents,
  SessionResponse,
  ChatMessage,
  ChatResponse,
  ResponseMeta,
  PushEvent,
  StatusEvent,
} from './types.js';

// Convenience: version from package.json
export const SDK_VERSION = '1.0.0';
