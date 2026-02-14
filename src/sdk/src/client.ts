// ============================================================
// AI Receptionist Client SDK — Core Client
//
// Usage (website embed):
//   const client = new ReceptionistClient({
//     serverUrl: 'https://receptionist.example.com',
//     tenantId: 'your-tenant-id',
//   });
//   const session = await client.startSession();
//   client.on('message', (msg) => console.log(msg.response));
//   await client.sendMessage('I want to book a haircut');
//
// Usage (REST-only / mobile):
//   const client = new ReceptionistClient({
//     serverUrl: 'https://receptionist.example.com',
//     tenantId: 'your-tenant-id',
//     transport: 'rest',
//   });
//   const session = await client.startSession();
//   const reply = await client.sendMessage('Hello');
//   console.log(reply.response);
// ============================================================

import { io, type Socket } from 'socket.io-client';
import type {
  ReceptionistConfig,
  ReceptionistEvents,
  SessionResponse,
  ChatResponse,
  PushEvent,
  StatusEvent,
} from './types.js';

type EventCallback = (...args: any[]) => void;

export class ReceptionistClient {
  private config: Required<
    Pick<ReceptionistConfig, 'serverUrl' | 'tenantId' | 'wsPath' | 'transport' | 'autoReconnect'>
  > & ReceptionistConfig;
  private token: string | null = null;
  private sessionId: string | null = null;
  private socket: Socket | null = null;
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private _session: SessionResponse | null = null;

  constructor(config: ReceptionistConfig) {
    this.config = {
      wsPath: '/ws',
      authEndpoint: '/api/auth/session',
      transport: 'websocket',
      autoReconnect: true,
      ...config,
    };
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Start a new session. Obtains a session token from the server,
   * then (in WebSocket mode) opens a real-time connection.
   *
   * Returns the session details including the token.
   */
  async startSession(): Promise<SessionResponse> {
    // 1. Obtain session token
    const authUrl = `${this.config.serverUrl}${this.config.authEndpoint}`;
    const body: Record<string, string> = { tenant_id: this.config.tenantId };
    if (this.config.customerEmail) body.customer_email = this.config.customerEmail;
    if (this.config.customerPhone) body.customer_phone = this.config.customerPhone;

    const res = await fetch(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `Session creation failed: ${res.status}`);
    }

    const session: SessionResponse = await res.json();
    this.token = session.token;
    this.sessionId = session.session_id;
    this._session = session;

    // 2. Open WebSocket if in ws mode
    if (this.config.transport === 'websocket') {
      await this.connectSocket();
    }

    this.emit('connected', session);
    return session;
  }

  /**
   * Send a message to the AI receptionist.
   *
   * - WebSocket mode: fires and forgets (response comes via 'message' event).
   *   Returns a resolved promise immediately.
   * - REST mode: sends HTTP POST and returns the response.
   */
  async sendMessage(text: string): Promise<ChatResponse | void> {
    if (!this.token || !this.sessionId) {
      throw new Error('Session not started. Call startSession() first.');
    }

    if (this.config.transport === 'rest') {
      return this.sendViaRest(text);
    }

    // WebSocket mode
    if (!this.socket?.connected) {
      throw new Error('WebSocket not connected.');
    }
    this.socket.emit('message', { message: text });
  }

  /**
   * Subscribe to push notifications (WebSocket mode only).
   * In REST mode, push events are not available — use WebSocket transport.
   *
   * This is a no-op if already connected; push events arrive
   * automatically via the 'push' event listener.
   */
  subscribeToPush(): void {
    if (this.config.transport === 'rest') {
      console.warn(
        '[ReceptionistSDK] Push subscriptions require WebSocket transport. ' +
        'Set transport: "websocket" in config.',
      );
    }
    // Push events are automatically delivered over the socket.
    // This method exists for API clarity and future REST polling support.
  }

  /**
   * Register an event listener.
   */
  on<K extends keyof ReceptionistEvents>(
    event: K,
    callback: ReceptionistEvents[K],
  ): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback as EventCallback);
    return this;
  }

  /**
   * Remove an event listener.
   */
  off<K extends keyof ReceptionistEvents>(
    event: K,
    callback: ReceptionistEvents[K],
  ): this {
    this.listeners.get(event)?.delete(callback as EventCallback);
    return this;
  }

  /**
   * Disconnect and clean up.
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.token = null;
    this.sessionId = null;
    this._session = null;
    this.emit('disconnected');
  }

  /**
   * Get the current session token (for passing to other API calls).
   */
  getToken(): string | null {
    return this.token;
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get the full session response (includes returning customer info).
   */
  getSession(): SessionResponse | null {
    return this._session;
  }

  // ── Private: WebSocket ────────────────────────────────────

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = io(this.config.serverUrl, {
        path: this.config.wsPath,
        transports: ['websocket', 'polling'],
        reconnection: this.config.autoReconnect,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      });

      this.socket = socket;

      const joinTimeout = setTimeout(() => {
        reject(new Error('WebSocket join timed out.'));
      }, 10000);

      socket.on('connect', () => {
        socket.emit('join', {
          tenant_id: this.config.tenantId,
          session_id: this.sessionId,
          token: this.token,
        });
      });

      socket.on('joined', () => {
        clearTimeout(joinTimeout);
        resolve();
      });

      socket.on('response', (data: ChatResponse) => {
        this.emit('message', data);
      });

      socket.on('typing', (data: { typing: boolean }) => {
        this.emit('typing', data.typing);
      });

      socket.on('status', (data: StatusEvent) => {
        this.emit('status', data);
      });

      socket.on('push', (data: PushEvent) => {
        this.emit('push', data);
      });

      socket.on('error', (data: { error: string }) => {
        this.emit('error', data);
      });

      socket.on('disconnect', () => {
        this.emit('disconnected');
      });

      socket.on('connect_error', (err) => {
        clearTimeout(joinTimeout);
        reject(new Error(`WebSocket connection failed: ${err.message}`));
      });
    });
  }

  // ── Private: REST Transport ───────────────────────────────

  private async sendViaRest(text: string): Promise<ChatResponse> {
    const chatUrl =
      this.config.chatEndpoint?.replace('{tenantId}', this.config.tenantId) ??
      `${this.config.serverUrl}/api/tenants/${this.config.tenantId}/chat`;

    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        session_id: this.sessionId,
        message: text,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `Chat request failed: ${res.status}`);
    }

    const data: ChatResponse = await res.json();
    this.emit('message', data);
    return data;
  }

  // ── Private: Event Emitter ────────────────────────────────

  private emit(event: string, ...args: any[]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(...args);
        } catch (err) {
          console.error(`[ReceptionistSDK] Error in ${event} listener:`, err);
        }
      }
    }
  }
}
