// ============================================================
// Chat Service — Socket.IO client for React Native
//
// Manages the WebSocket connection to the gomomo backend.
// No React DOM dependencies — pure TypeScript + socket.io-client.
//
// Events emitted (subscribe via on()):
//   'response'           — assistant reply { session_id, response, meta }
//   'typing'             — { typing: boolean }
//   'status'             — { phase, detail }
//   'email_gate_required'— { session_id, message, message_count }
//   'trial_limit_reached'— { session_id, code, message, limit }
//   'error'              — { error: string }
//   'connected'          — session_id joined
//   'disconnected'       — connection lost
// ============================================================

import { io, Socket } from 'socket.io-client';
import { BACKEND_BASE_URL, WS_PATH, TENANT_ID } from './config';
import type { SessionData } from './session';

// ── Types ──────────────────────────────────────────────────

/** Structured booking data returned when confirm_booking succeeds. */
export interface BookingData {
  appointment_id: string;
  reference_code: string;
  client_name: string;
  service: string | null;
  start_time: string;
  end_time: string;
  display_time: string;
  timezone: string;
  add_to_calendar_url: string;
}

export interface ChatResponse {
  session_id: string;
  response: string;
  meta: {
    tools_used: string[];
    has_async_job: boolean;
    /** Present when confirm_booking succeeded — structured data for rich UI. */
    booking_data?: BookingData;
  };
}

export interface EmailGateEvent {
  session_id: string;
  message: string;
  message_count: number;
}

export interface TrialLimitEvent {
  session_id: string;
  code: string;
  message: string;
  limit: number;
}

export interface StatusEvent {
  phase: string;
  detail: string;
}

type ChatEventMap = {
  response: ChatResponse;
  typing: { typing: boolean };
  status: StatusEvent;
  email_gate_required: EmailGateEvent;
  trial_limit_reached: TrialLimitEvent;
  error: { error: string };
  connected: string; // session_id
  disconnected: void;
};

type Listener<T> = (data: T) => void;

// ── Chat Client ────────────────────────────────────────────

export class ChatClient {
  private socket: Socket | null = null;
  private listeners = new Map<string, Set<Listener<any>>>();
  private sessionData: SessionData | null = null;

  /** Connect to the backend via Socket.IO and join the session. */
  connect(session: SessionData): Promise<string> {
    this.sessionData = session;

    return new Promise((resolve, reject) => {
      const socket = io(BACKEND_BASE_URL, {
        path: WS_PATH,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      });

      this.socket = socket;

      const joinTimeout = setTimeout(() => {
        reject(new Error('WebSocket join timed out.'));
      }, 10_000);

      socket.on('connect', () => {
        socket.emit('join', {
          tenant_id: TENANT_ID,
          session_id: session.session_id,
          token: session.token,
        });
      });

      socket.on('joined', (data: { session_id: string }) => {
        clearTimeout(joinTimeout);
        this.emit('connected', data.session_id);
        resolve(data.session_id);
      });

      socket.on('response', (data: ChatResponse) => {
        this.emit('response', data);
      });

      socket.on('typing', (data: { typing: boolean }) => {
        this.emit('typing', data);
      });

      socket.on('status', (data: StatusEvent) => {
        this.emit('status', data);
      });

      socket.on('email_gate_required', (data: EmailGateEvent) => {
        this.emit('email_gate_required', data);
      });

      socket.on('trial_limit_reached', (data: TrialLimitEvent) => {
        this.emit('trial_limit_reached', data);
      });

      socket.on('error', (data: { error: string }) => {
        this.emit('error', data);
      });

      socket.on('disconnect', () => {
        this.emit('disconnected', undefined as any);
      });

      socket.on('connect_error', (err: Error) => {
        clearTimeout(joinTimeout);
        reject(new Error(`Connection failed: ${err.message}`));
      });
    });
  }

  /** Send a chat message. */
  send(message: string): void {
    if (!this.socket?.connected) {
      throw new Error('Not connected. Call connect() first.');
    }
    this.socket.emit('message', { message });
  }

  /** Register an event listener. */
  on<K extends keyof ChatEventMap>(event: K, listener: Listener<ChatEventMap[K]>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  /** Remove an event listener. */
  off<K extends keyof ChatEventMap>(event: K, listener: Listener<ChatEventMap[K]>): void {
    this.listeners.get(event)?.delete(listener);
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.sessionData = null;
  }

  /** Whether the socket is currently connected. */
  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Get the current session data. */
  getSession(): SessionData | null {
    return this.sessionData;
  }

  // ── Private ──────────────────────────────────────────────

  private emit<K extends keyof ChatEventMap>(event: K, data: ChatEventMap[K]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => {
        try {
          cb(data);
        } catch (err) {
          console.error(`[ChatClient] Error in ${event} listener:`, err);
        }
      });
    }
  }
}

/** Singleton instance — shared across the app. */
export const chatClient = new ChatClient();
