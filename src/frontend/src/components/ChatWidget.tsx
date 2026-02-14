import React, { useState, useRef, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { IntakeForm } from './IntakeForm';
import { EmailGateModal } from './EmailGateModal';
import { loadChat, saveChat, saveChatDebounced, clearChat } from '../lib/chat-persistence';
import { useVoice, getAutoSpeak, setAutoSpeak } from '../hooks/useVoice';
import { useCapabilities } from '../hooks/useCapabilities';
import { AGENT_AVATAR_URL } from '../assets/agent-avatar';

interface BookingData {
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

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  pushType?: 'waitlist_match' | 'calendar_retry_success';
  pushSlots?: Array<{ start: string; end: string; display_time: string; service: string | null }>;
  pushRef?: string;
  bookingData?: BookingData;
  /** Internal flag: true while tokens are still streaming in. Cleared when 'response' event arrives. */
  _streaming?: boolean;
}

interface ChatWidgetProps {
  tenantId: string;
  /** When true, fills parent container — no fixed height, no border/shadow. */
  embed?: boolean;
  /** External message to inject into chat (e.g. from CEO test panel). Cleared after sending. */
  pendingMessage?: string | null;
  /** Called after the pending message has been consumed. */
  onPendingMessageConsumed?: () => void;
}

const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:3000';
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

/* ── Follow-up Detection ────────────────────────────────── */
function isFollowupMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (lower.includes('follow-up') || lower.includes('follow up') || lower.includes('followup')) &&
    (lower.includes('scheduled') || lower.includes("i'll text") || lower.includes("i'll email") ||
     lower.includes("we'll text") || lower.includes("we'll email") || lower.includes('contact you shortly'))
  );
}

function FollowupCardInline({ text }: { text: string }) {
  const lower = text.toLowerCase();
  const method = lower.includes('text') || lower.includes('sms') ? 'SMS' : 'Email';
  return (
    <div style={followupStyles.card}>
      <div style={followupStyles.icon}>✅</div>
      <div style={followupStyles.body}>
        <div style={followupStyles.title}>Follow-up Scheduled</div>
        <div style={followupStyles.detail}>Contact method: <strong>{method}</strong></div>
        <div style={followupStyles.detail}>Expected timeframe: <strong>shortly</strong></div>
      </div>
    </div>
  );
}

const followupStyles: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 8,
    padding: '10px 14px',
    borderRadius: 10,
    background: 'rgba(74, 222, 128, 0.12)',
    border: '1px solid rgba(74, 222, 128, 0.3)',
    maxWidth: '80%',
  },
  icon: { fontSize: 20, lineHeight: 1 },
  body: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  title: { fontWeight: 700, fontSize: 13, color: '#22c55e' },
  detail: { fontSize: 12, color: 'var(--text-muted, #888)', lineHeight: 1.4 },
};

/** Connection timeout before showing error state (ms). */
const CONNECTION_TIMEOUT_MS = 8_000;

export function ChatWidget({ tenantId, embed, pendingMessage, onPendingMessageConsumed }: ChatWidgetProps) {
  // ── Hydrate from localStorage on first mount ──────────
  const cached = useRef(loadChat(tenantId));

  const [messages, setMessages] = useState<Message[]>(() => (cached.current?.messages as Message[]) ?? []);
  const [input, setInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(() => cached.current?.sessionId ?? null);
  const [useWebSocket, setUseWebSocket] = useState(true);
  const [showIntakeForm, setShowIntakeForm] = useState(false);
  const [showEmailGate, setShowEmailGate] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [pendingGateMessage, setPendingGateMessage] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // ── Voice (Web Voice Mode) ────────────────────────────
  const { capabilities } = useCapabilities();
  const voiceEnabled = capabilities?.voiceWeb ?? false;
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(() => getAutoSpeak());

  // Ref-based send so the transcript callback always has the latest send logic
  const sendMessageRef = useRef<(text: string) => void>(() => {});

  const handleVoiceTranscript = useCallback((text: string) => {
    // Auto-send the transcript — seamless conversational flow
    sendMessageRef.current(text);
  }, []);

  const voice = useVoice({
    apiUrl: API_URL,
    onTranscript: handleVoiceTranscript,
    autoSpeak: autoSpeakEnabled,
  });

  const handleAutoSpeakToggle = useCallback(() => {
    setAutoSpeakEnabled((prev) => {
      const next = !prev;
      setAutoSpeak(next);
      return next;
    });
  }, []);

  /** Toggle conversation mode — activates/deactivates STT + TTS as one unit */
  const handleAgentToggle = useCallback(() => {
    if (voice.conversationMode) {
      // Exiting conversation mode → disable auto-speak
      setAutoSpeakEnabled(false);
      setAutoSpeak(false);
    } else {
      // Entering conversation mode → enable auto-speak
      setAutoSpeakEnabled(true);
      setAutoSpeak(true);
    }
    voice.toggleConversationMode();
  }, [voice]);

  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Ref to track current sessionId inside WS effect closure */
  const sessionIdRef = useRef<string | null>(sessionId);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // ── Auto-speak new assistant messages (Web Voice Mode) ──
  // We track the last message we spoke so we speak each final response exactly once.
  // IMPORTANT: We must NOT speak streaming messages (_streaming: true) — those only
  // contain partial tokens (often a single word). We wait for the 'response' event
  // which replaces the streaming message with the full post-processed text.
  const lastSpokenIdxRef = useRef(-1);
  useEffect(() => {
    if (!autoSpeakEnabled || !voiceEnabled) return;
    if (messages.length === 0) return;

    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];

    // Only speak finalized assistant messages we haven't spoken yet
    if (
      last?.role === 'assistant' &&
      !last._streaming &&       // ← wait for full response, not partial tokens
      last.content &&
      !last.content.startsWith('⚠️') &&
      lastIdx > lastSpokenIdxRef.current
    ) {
      lastSpokenIdxRef.current = lastIdx;
      voice.speak(last.content);
    }
  }, [messages, autoSpeakEnabled, voiceEnabled, voice.speak]);

  // ── Persist messages to localStorage (debounced) ──────
  useEffect(() => {
    if (!sessionId || messages.length === 0) return;
    saveChatDebounced(tenantId, sessionId, messages);
  }, [messages, sessionId, tenantId]);

  // ── Flush on page unload ──────────────────────────────
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (sessionId && messages.length > 0) {
        saveChat(tenantId, sessionId, messages);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [messages, sessionId, tenantId]);

  // ── Clear chat handler ────────────────────────────────
  const handleClearChat = useCallback(() => {
    clearChat(tenantId);
    setMessages([]);
    setSessionId(null);
    lastSpokenIdxRef.current = -1;
    // Force new WS connection with fresh session
    setRetryCount((c) => c + 1);
  }, [tenantId]);

  // ── Session resume: restore verified state from sessionStorage ──
  useEffect(() => {
    if (!sessionId) return;
    try {
      const key = `gomomo_verified_${sessionId}`;
      const stored = sessionStorage.getItem(key);
      if (stored === 'true') {
        setEmailVerified(true);
      }
    } catch { /* sessionStorage may be blocked */ }
  }, [sessionId]);

  // ── Retry handler — triggers reconnect by bumping retryCount ──
  const handleRetryConnection = useCallback(() => {
    setConnectionFailed(false);
    setRetryCount((c) => c + 1);
  }, []);

  // WebSocket connection
  useEffect(() => {
    if (!useWebSocket) return;

    setConnectionFailed(false);

    const socket = io(WS_URL, {
      path: '/ws',
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 3,
      timeout: CONNECTION_TIMEOUT_MS,
    });
    socketRef.current = socket;

    // Start a connection timeout — if we don't connect in time, show error
    timeoutRef.current = setTimeout(() => {
      if (!socket.connected) {
        setConnectionFailed(true);
        socket.disconnect();
      }
    }, CONNECTION_TIMEOUT_MS);

    socket.on('connect', () => {
      // Connection succeeded — clear timeout
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      setIsConnected(true);
      setConnectionFailed(false);
      // Reuse cached session_id (from localStorage hydration or previous join)
      const persistedSessionId = sessionIdRef.current ?? undefined;
      socket.emit('join', { tenant_id: tenantId, session_id: persistedSessionId });
    });

    socket.on('connect_error', () => {
      // Socket.IO will auto-retry up to reconnectionAttempts; after that
      // the timeout above will fire. No special handling needed here.
    });

    socket.on('joined', (data: { session_id: string }) => {
      setSessionId(data.session_id);
      sessionIdRef.current = data.session_id;
      // Persist session_id for reuse after page refresh (legacy key for compat)
      try {
        localStorage.setItem('gomomo_session_id', data.session_id);
      } catch { /* localStorage may be blocked */ }
    });

    // Streaming tokens — progressively render assistant response
    socket.on('token', (data: { token: string }) => {
      setIsTyping(false); // Hide typing indicator once tokens flow
      setStatusText(null);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last._streaming) {
          // Append to in-progress streaming message
          const updated = [...prev];
          updated[updated.length - 1] = { ...last, content: last.content + data.token };
          return updated;
        }
        // First token — create a new streaming message
        return [...prev, { role: 'assistant', content: data.token, _streaming: true }];
      });
    });

    socket.on('response', (data: { response: string; meta?: { tools_used?: string[]; has_async_job?: boolean; booking_data?: BookingData } }) => {
      setStatusText(null);
      setPendingGateMessage(null); // Clear — message was accepted
      // Replace the streaming message with the final post-processed version
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last._streaming) {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: data.response,
            bookingData: data.meta?.booking_data,
          };
          return updated;
        }
        // No streaming message existed — add normally (fallback)
        return [...prev, {
          role: 'assistant',
          content: data.response,
          bookingData: data.meta?.booking_data,
        }];
      });
      setIsTyping(false);

      if (data.meta?.has_async_job) {
        setStatusText('Scheduling follow-up in progress…');
        setTimeout(() => setStatusText(null), 3000);
      }
    });

    socket.on('status', (data: { phase: string; detail: string }) => {
      setStatusText(data.detail);
    });

    socket.on('typing', (data: { typing: boolean }) => {
      setIsTyping(data.typing);
      if (!data.typing) setStatusText(null);
    });

    socket.on('error', (data: { error: string }) => {
      setStatusText(null);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `⚠️ ${data.error}` },
      ]);
      setIsTyping(false);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    // Email gate: server requires email verification
    socket.on('email_gate_required', () => {
      setShowEmailGate(true);
      setIsTyping(false);
      setStatusText(null);
    });

    // Feature 3: Proactive push events
    socket.on('push', (data: any) => {
      const msg: Message = {
        role: 'assistant',
        content: data.payload?.message ?? 'New update from the agent.',
        pushType: data.type,
        pushSlots: data.payload?.slots,
        pushRef: data.payload?.reference_code,
      };
      setMessages((prev) => [...prev, msg]);
    });

    return () => {
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      socket.disconnect();
    };
  }, [tenantId, useWebSocket, retryCount]);

  // Fallback: REST-based send
  const sendViaRest = useCallback(
    async (message: string, extras?: Record<string, unknown>) => {
      // Reuse cached session_id (from persistence hydration or previous join)
      const sid = sessionId || sessionIdRef.current || `rest-${Date.now()}`;
      if (!sessionId) {
        setSessionId(sid);
        sessionIdRef.current = sid;
        try { localStorage.setItem('gomomo_session_id', sid); } catch { /* noop */ }
      }

      setIsTyping(true);
      setStatusText('Agent is working on it…');
      try {
        const res = await fetch(`${API_URL}/api/tenants/${tenantId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sid, message, ...extras }),
        });
        const data = await res.json();

        // Check for email gate response (403)
        if (data.email_gate_required) {
          setShowEmailGate(true);
          setIsTyping(false);
          setStatusText(null);
          return;
        }

        setStatusText(null);
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: data.response,
          bookingData: data.meta?.booking_data,
        }]);

        if (data.meta?.has_async_job) {
          setStatusText('Scheduling follow-up in progress…');
          setTimeout(() => setStatusText(null), 3000);
        }
      } catch {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: '⚠️ Connection error. Please try again.' },
        ]);
      } finally {
        setIsTyping(false);
      }
    },
    [tenantId, sessionId],
  );

  // ── External message injection (CEO test panel) ───────
  useEffect(() => {
    if (!pendingMessage) return;
    setMessages((prev) => [...prev, { role: 'user', content: pendingMessage }]);
    if (useWebSocket && socketRef.current?.connected) {
      socketRef.current.emit('message', { message: pendingMessage });
    } else {
      sendViaRest(pendingMessage);
    }
    onPendingMessageConsumed?.();
  }, [pendingMessage]);  // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Track as pending in case the email gate fires
    setPendingGateMessage(trimmed);

    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setInput('');

    if (useWebSocket && socketRef.current?.connected) {
      socketRef.current.emit('message', { message: trimmed });
    } else {
      sendViaRest(trimmed);
    }
  }, [input, useWebSocket, sendViaRest]);

  // ── Keep voice auto-send ref current ──────────────────
  useEffect(() => {
    sendMessageRef.current = (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setPendingGateMessage(trimmed);
      setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
      if (useWebSocket && socketRef.current?.connected) {
        socketRef.current.emit('message', { message: trimmed });
      } else {
        sendViaRest(trimmed);
      }
    };
  }, [useWebSocket, sendViaRest]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Intake form handlers ──────────────────────────────
  const handleIntakeSubmit = useCallback((message: string, recaptchaToken?: string | null) => {
    // Inject the structured BOOKING_REQUEST into chat
    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    const extras = recaptchaToken ? { recaptcha_token: recaptchaToken } : undefined;
    if (useWebSocket && socketRef.current?.connected) {
      socketRef.current.emit('message', { message, ...extras });
    } else {
      sendViaRest(message, extras);
    }
    setShowIntakeForm(false);
  }, [useWebSocket, sendViaRest]);

  const handleIntakeCancel = useCallback(() => {
    setShowIntakeForm(false);
  }, []);

  // ── Email gate: verified handler ──────────────────────
  const handleEmailVerified = useCallback((_email: string) => {
    setShowEmailGate(false);
    setEmailVerified(true);

    // Persist verified state so refresh / new tabs resume seamlessly
    if (sessionId) {
      try {
        sessionStorage.setItem(`gomomo_verified_${sessionId}`, 'true');
      } catch { /* sessionStorage may be blocked */ }
    }

    // Show subtle verified toast (auto-dismiss)
    setMessages((prev) => [
      ...prev,
      { role: 'system', content: '✅ Email verified — you\'re all set!' },
    ]);

    // Restore input focus
    setTimeout(() => inputRef.current?.focus(), 100);

    // Re-send the gated message that was blocked
    if (pendingGateMessage) {
      const msg = pendingGateMessage;
      setPendingGateMessage(null);
      setMessages((prev) => [...prev, { role: 'user', content: msg }]);
      if (useWebSocket && socketRef.current?.connected) {
        socketRef.current.emit('message', { message: msg });
      } else {
        sendViaRest(msg);
      }
    }
  }, [sessionId, pendingGateMessage, useWebSocket, sendViaRest]);

  const containerStyle = embed ? styles.containerEmbed : styles.container;

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerDot(isConnected, connectionFailed)} />
        <span style={styles.headerText}>
          {connectionFailed ? 'Offline' : isConnected ? 'Online' : 'Connecting…'}
        </span>
        <span style={{ flex: 1 }} />
        {messages.length > 0 && (
          <button
            onClick={handleClearChat}
            style={styles.clearBtn}
            title="Clear chat history"
            aria-label="Clear chat history"
          >
            🗑
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={styles.messages}>
        {/* Connection failure state */}
        {connectionFailed && (
          <div style={styles.connectionError}>
            <div style={styles.connectionErrorIcon}>⚡</div>
            <div style={styles.connectionErrorTitle}>Unable to connect</div>
            <div style={styles.connectionErrorDetail}>
              The agent service is currently unavailable. Please try again in a moment.
            </div>
            <button onClick={handleRetryConnection} style={styles.retryBtn}>
              Retry connection
            </button>
          </div>
        )}
        {!connectionFailed && messages.length === 0 && (
          <div style={styles.empty}>
            👋 Hi! I'm your AI agent. How can I help you today?
          </div>
        )}
        {messages.map((msg, i) => (
          <React.Fragment key={i}>
            {msg.role === 'assistant' ? (
              <div style={avatarStyles.row} className="chat-msg-enter">
                <img src={AGENT_AVATAR_URL} alt="Agent" style={avatarStyles.avatar} />
                <div style={{ ...styles.bubble, ...styles.assistantBubble }}>
                  {msg.content}
                </div>
              </div>
            ) : (
              <div
                className="chat-msg-enter"
                style={{
                  ...styles.bubble,
                  ...styles.userBubble,
                }}
              >
                {msg.content}
              </div>
            )}
            {msg.role === 'assistant' && msg.pushType === 'waitlist_match' && msg.pushSlots && (
              <div style={pushStyles.slots}>
                {msg.pushSlots.map((slot, j) => (
                  <button
                    key={j}
                    style={pushStyles.slotBtn}
                    onClick={() => {
                      const text = `I'd like to book the ${slot.display_time} slot${slot.service ? ` for ${slot.service}` : ''}`;
                      setMessages((prev) => [...prev, { role: 'user', content: text }]);
                      if (useWebSocket && socketRef.current?.connected) {
                        socketRef.current.emit('message', { message: text });
                      } else {
                        sendViaRest(text);
                      }
                    }}
                  >
                    📅 {slot.display_time}
                  </button>
                ))}
              </div>
            )}
            {msg.role === 'assistant' && msg.pushType === 'calendar_retry_success' && msg.pushRef && (
              <div style={pushStyles.ref}>Ref: <strong>{msg.pushRef}</strong></div>
            )}
            {msg.role === 'assistant' && isFollowupMessage(msg.content) && (
              <FollowupCardInline text={msg.content} />
            )}
            {msg.role === 'assistant' && msg.bookingData?.add_to_calendar_url && (
              <a
                href={msg.bookingData.add_to_calendar_url}
                download={`appointment-${msg.bookingData.reference_code}.ics`}
                style={calendarDownloadStyles.link}
                title="Download calendar event"
                aria-label="Add to calendar"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                <span>Add to Calendar</span>
              </a>
            )}
          </React.Fragment>
        ))}
        {/* Inline Intake Form */}
        {showIntakeForm && (
          <IntakeForm onSubmit={handleIntakeSubmit} onCancel={handleIntakeCancel} />
        )}
        {(isTyping || statusText) && (
          <div style={{ ...styles.bubble, ...styles.assistantBubble }}>
            {statusText ? (
              <span style={styles.statusChip}>
                <span>⚙️</span>
                <span>{statusText}</span>
                <span style={styles.typing}>●●●</span>
              </span>
            ) : (
              <span style={styles.typing}>●●●</span>
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Voice status bar — shows during conversation mode or active voice states */}
      {voiceEnabled && (voice.conversationMode || voice.state !== 'idle') && (
        <div style={voiceStyles.statusBar}>
          <span style={voiceStyles.statusDot(voice.state)} />
          <span style={voiceStyles.statusLabel}>
            {voice.state === 'recording' && '🎙️ Listening…'}
            {voice.state === 'transcribing' && '⏳ Processing…'}
            {voice.state === 'speaking' && '🔊 Speaking…'}
            {voice.state === 'idle' && voice.conversationMode && '⏸ Ready — speak to continue…'}
            {voice.state === 'error' && `⚠️ ${voice.errorMessage || 'Error'}`}
          </span>
          {voice.conversationMode && (
            <button onClick={handleAgentToggle} style={voiceStyles.bargeInBtn} title="End conversation">
              ✕
            </button>
          )}
        </div>
      )}

      {/* Input */}
      <div style={styles.inputRow}>
        <button
          onClick={() => setShowIntakeForm((v) => !v)}
          style={styles.bookBtn}
          title="Book an appointment"
          aria-label="Book an appointment"
          disabled={connectionFailed}
        >
          📋
        </button>

        {/* AI Agent button — avatar icon for conversation mode (STT + TTS) */}
        {voiceEnabled && voice.isSupported && (
          <button
            onClick={handleAgentToggle}
            style={{
              ...styles.bookBtn,
              ...(voice.conversationMode ? voiceStyles.agentActive : voiceStyles.agentIdle),
              padding: 0,
              overflow: 'hidden',
              position: 'relative' as const,
            }}
            title={voice.conversationMode ? 'End conversation' : 'Start conversation with AI'}
            aria-label={voice.conversationMode ? 'End conversation mode' : 'Start conversation mode'}
            disabled={connectionFailed || voice.state === 'transcribing'}
          >
            <img
              src={AGENT_AVATAR_URL}
              alt="AI Agent"
              style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' as const }}
            />
            {voice.conversationMode && (
              <span style={{
                position: 'absolute' as const,
                top: -2,
                right: -2,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#4ade80',
                border: '2px solid #fff',
                animation: 'pulse 1.5s ease-in-out infinite',
              }} />
            )}
          </button>
        )}

        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            connectionFailed
              ? 'Agent unavailable'
              : voice.conversationMode
                ? 'Conversation active — speak naturally…'
                : 'Type your message…'
          }
          style={styles.textarea}
          disabled={connectionFailed}
        />
        <button onClick={handleSend} disabled={!input.trim() || connectionFailed} style={styles.sendBtn}>
          ➤
        </button>
      </div>

      {/* Email Gate Modal */}
      {showEmailGate && sessionId && (
        <EmailGateModal
          sessionId={sessionId}
          tenantId={tenantId}
          onVerified={handleEmailVerified}
          onClose={() => { setShowEmailGate(false); setPendingGateMessage(null); }}
        />
      )}
    </div>
  );
}

/* ── Inline Styles ──────────────────────────────────────── */
const styles: Record<string, any> = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: 560,
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    background: 'var(--surface)',
    overflow: 'hidden',
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
  },
  /** Embed mode: fill parent, no border/shadow/radius (the parent handles chrome). */
  containerEmbed: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    background: 'var(--surface)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--primary)',
    color: '#fff',
  },
  headerDot: (connected: boolean, failed?: boolean) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: failed ? '#ef4444' : connected ? '#4ade80' : '#f59e0b',
  }),
  headerText: { fontSize: 14, fontWeight: 600 },
  clearBtn: {
    background: 'transparent',
    border: 'none',
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: 4,
    lineHeight: 1,
    transition: 'color 0.15s',
  },
  messages: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: 16,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  empty: {
    textAlign: 'center' as const,
    color: 'var(--text-muted)',
    marginTop: 40,
    fontSize: 15,
  },
  connectionError: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 40,
    padding: '24px 20px',
    textAlign: 'center' as const,
  },
  connectionErrorIcon: {
    fontSize: 36,
    lineHeight: 1,
  },
  connectionErrorTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text)',
  },
  connectionErrorDetail: {
    fontSize: 13,
    color: 'var(--text-muted)',
    maxWidth: 280,
    lineHeight: 1.5,
  },
  retryBtn: {
    marginTop: 8,
    padding: '8px 20px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--primary)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  bubble: {
    maxWidth: '80%',
    padding: '10px 14px',
    borderRadius: 'var(--radius)',
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
  },
  userBubble: {
    alignSelf: 'flex-end' as const,
    background: 'var(--primary)',
    color: '#fff',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    alignSelf: 'flex-start' as const,
    background: 'var(--primary-light)',
    color: 'var(--text)',
    borderBottomLeftRadius: 4,
  },
  typing: {
    animation: 'pulse 1s ease-in-out infinite',
    letterSpacing: 2,
  },
  statusChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    opacity: 0.85,
  },
  inputRow: {
    display: 'flex',
    gap: 8,
    padding: 12,
    borderTop: '1px solid var(--border)',
  },
  textarea: {
    flex: 1,
    resize: 'none' as const,
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    border: 'none',
    background: 'var(--primary)',
    color: '#fff',
    fontSize: 18,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bookBtn: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    border: '1px solid var(--border, #e2e8f0)',
    background: 'var(--surface, #fff)',
    fontSize: 18,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
};

/* ── Push Card Styles (Feature 3) ───────────────────────── */
const pushStyles: Record<string, React.CSSProperties> = {
  slots: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    marginTop: 8,
    maxWidth: '80%',
  },
  slotBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    background: '#f0fdf4',
    border: '1px solid #86efac',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    color: '#166534',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  ref: {
    marginTop: 6,
    fontSize: 12,
    color: '#6b7280',
    maxWidth: '80%',
  },
};

/* ── Calendar Download Styles ───────────────────────────── */
const calendarDownloadStyles: Record<string, React.CSSProperties> = {
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    padding: '8px 14px',
    background: '#eff6ff',
    border: '1px solid #93c5fd',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    color: '#1d4ed8',
    cursor: 'pointer',
    textDecoration: 'none',
    maxWidth: '80%',
    transition: 'background 0.15s',
  },
};

/* ── Agent Avatar Styles ────────────────────────────────── */
const avatarStyles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    maxWidth: '85%',
    alignSelf: 'flex-start' as const,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    flexShrink: 0,
    marginTop: 2,
    border: '1px solid var(--border, #e2e8f0)',
  },
};

/* ── Voice Styles (Web Voice Mode) ──────────────────────── */
const voiceStyles: Record<string, any> = {
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    borderTop: '1px solid var(--border)',
    background: 'var(--primary-light)',
    fontSize: 12,
    color: 'var(--text-muted)',
  },
  statusDot: (state: string) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: state === 'recording' ? '#ef4444'
      : state === 'transcribing' ? '#f59e0b'
      : state === 'speaking' ? '#4ade80'
      : '#94a3b8',
    animation: state === 'recording' ? 'pulse 1s ease-in-out infinite' : undefined,
  }),
  statusLabel: {
    flex: 1,
    fontSize: 12,
  },
  bargeInBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: 14,
    cursor: 'pointer',
    padding: '2px 6px',
  },
  micActive: {
    background: '#fef2f2',
    borderColor: '#ef4444',
    boxShadow: '0 0 0 2px rgba(239, 68, 68, 0.25)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  agentIdle: {
    opacity: 0.7,
    transition: 'all 0.2s ease',
    color: 'var(--text-muted, #64748b)',
  },
  agentActive: {
    background: '#f0fdf4',
    borderColor: '#4ade80',
    boxShadow: '0 0 0 3px rgba(74, 222, 128, 0.3)',
    color: '#16a34a',
    opacity: 1,
    transition: 'all 0.2s ease',
  },
  autoSpeakBtn: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: '1px solid var(--border, #e2e8f0)',
    background: 'var(--surface, #fff)',
    fontSize: 14,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    opacity: 0.6,
    transition: 'opacity 0.15s, background 0.15s',
  },
  autoSpeakActive: {
    opacity: 1,
    background: '#f0fdf4',
    borderColor: '#4ade80',
  },
};
