// ============================================================
// AI Receptionist Client SDK — Types
// ============================================================

/** Configuration for creating a ReceptionistClient. */
export interface ReceptionistConfig {
  /** Base URL of the AI Receptionist server (e.g. "https://receptionist.example.com"). */
  serverUrl: string;
  /** Tenant ID to connect to. */
  tenantId: string;
  /** Optional customer email for identity resolution. */
  customerEmail?: string;
  /** Optional customer phone for identity resolution. */
  customerPhone?: string;
  /** Optional: override WebSocket path (default: "/ws"). */
  wsPath?: string;
  /** Optional: override auth endpoint (default: "/api/auth/session"). */
  authEndpoint?: string;
  /** Optional: override chat endpoint (default: "/api/tenants/{tenantId}/chat"). */
  chatEndpoint?: string;
  /**
   * Transport mode:
   *   - 'websocket' (default): real-time via Socket.IO — best for web
   *   - 'rest': HTTP polling — best for mobile/serverless
   */
  transport?: 'websocket' | 'rest';
  /**
   * Auto-reconnect on disconnect (WebSocket mode only).
   * Default: true
   */
  autoReconnect?: boolean;
}

/** Response from POST /api/auth/session. */
export interface SessionResponse {
  token: string;
  session_id: string;
  tenant_id: string;
  expires_at: string;
  returning_customer: {
    display_name: string | null;
    booking_count: number;
  } | null;
}

/** A chat message. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Metadata returned with each assistant response. */
export interface ResponseMeta {
  tools_used: string[];
  has_async_job: boolean;
}

/** Chat response from the server. */
export interface ChatResponse {
  session_id: string;
  response: string;
  meta: ResponseMeta;
}

/** Push notification from the server. */
export interface PushEvent {
  type: string;
  payload: {
    message?: string;
    slots?: Array<{
      start: string;
      end: string;
      display_time: string;
      service: string | null;
    }>;
    reference_code?: string;
    [key: string]: unknown;
  };
}

/** Status event from the server. */
export interface StatusEvent {
  phase: string;
  detail: string;
}

/** Events emitted by ReceptionistClient. */
export interface ReceptionistEvents {
  /** Fired when a session is established. */
  connected: (session: SessionResponse) => void;
  /** Fired when the assistant sends a response. */
  message: (msg: ChatResponse) => void;
  /** Fired when the assistant is typing. */
  typing: (isTyping: boolean) => void;
  /** Fired on status changes (tool calls, async jobs). */
  status: (status: StatusEvent) => void;
  /** Fired on push notifications (waitlist matches, etc.). */
  push: (event: PushEvent) => void;
  /** Fired on errors. */
  error: (error: { error: string }) => void;
  /** Fired on disconnect. */
  disconnected: () => void;
}
