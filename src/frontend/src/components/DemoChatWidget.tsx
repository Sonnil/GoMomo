import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import { useToasts, ToastContainer, detectEvents } from './ToastNotifications';

/* ── Types ──────────────────────────────────────────────── */
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  pushData?: PushEventData;  // Feature 3: proactive push payload
}

/** Push event data from the server (Feature 3). */
interface PushEventData {
  id: string;
  type: 'waitlist_match' | 'calendar_retry_success';
  payload: {
    type: string;
    message: string;
    slots?: Array<{ start: string; end: string; display_time: string; service: string | null }>;
    reference_code?: string;
    service?: string | null;
    start_time?: string;
    end_time?: string;
    display_time?: string;
  };
  created_at: string;
}

// Gomomo — seeded by src/db/seed.ts
const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

interface DemoChatWidgetProps {
  tenantId?: string;
  serverUrl?: string;
}

/* ── Simple Markdown Renderer ───────────────────────────── */
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listKey = 0;

  const flushList = () => {
    if (listItems.length > 0) {
      nodes.push(
        <ul key={`list-${listKey++}`} style={{ margin: '4px 0 4px 16px', padding: 0 }}>
          {listItems.map((item, i) => (
            <li key={i} style={{ marginBottom: 2 }}>{inlineFormat(item)}</li>
          ))}
        </ul>
      );
      listItems = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Bullet list items: - or • or *
    const bulletMatch = line.match(/^\s*[-•*]\s+(.+)/);
    if (bulletMatch) {
      listItems.push(bulletMatch[1]);
      continue;
    }

    flushList();

    // Empty line → spacer
    if (line.trim() === '') {
      nodes.push(<div key={`sp-${i}`} style={{ height: 6 }} />);
      continue;
    }

    // Bold-only line (heading-like)
    if (/^\*\*[^*]+\*\*$/.test(line.trim())) {
      nodes.push(
        <div key={`h-${i}`} style={{ fontWeight: 700, marginTop: 6, marginBottom: 2 }}>
          {line.trim().replace(/\*\*/g, '')}
        </div>
      );
      continue;
    }

    // Regular paragraph
    nodes.push(
      <div key={`p-${i}`} style={{ marginBottom: 1 }}>
        {inlineFormat(line)}
      </div>
    );
  }

  flushList();
  return nodes;
}

/** Inline formatting: **bold**, *italic*, `code` */
function inlineFormat(text: string): React.ReactNode {
  // Split on bold, italic, code patterns
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold: **text**
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Code: `text`
    const codeMatch = remaining.match(/`(.+?)`/);
    // Italic: *text* (single asterisk, not double)
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);

    // Find earliest match
    const matches = [
      boldMatch ? { type: 'bold' as const, match: boldMatch } : null,
      codeMatch ? { type: 'code' as const, match: codeMatch } : null,
      italicMatch ? { type: 'italic' as const, match: italicMatch } : null,
    ].filter(Boolean).sort((a, b) => a!.match.index! - b!.match.index!);

    if (matches.length === 0) {
      parts.push(remaining);
      break;
    }

    const first = matches[0]!;
    const idx = first.match.index!;

    // Text before match
    if (idx > 0) {
      parts.push(remaining.slice(0, idx));
    }

    const inner = first.match[1];
    if (first.type === 'bold') {
      parts.push(<strong key={key++}>{inner}</strong>);
    } else if (first.type === 'code') {
      parts.push(
        <code key={key++} style={{
          background: 'rgba(0,0,0,0.06)',
          padding: '1px 5px',
          borderRadius: 4,
          fontSize: '0.9em',
          fontFamily: "'SF Mono', Monaco, monospace",
        }}>{inner}</code>
      );
    } else {
      parts.push(<em key={key++}>{inner}</em>);
    }

    remaining = remaining.slice(idx + first.match[0].length);
  }

  return <>{parts}</>;
}

/* ── Time Formatter ─────────────────────────────────────── */
function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ── Follow-up Confirmation Card ────────────────────────── */
function isFollowupMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (lower.includes('follow-up') || lower.includes('follow up') || lower.includes('followup')) &&
    (lower.includes('scheduled') || lower.includes("i'll text") || lower.includes("i'll email") ||
     lower.includes("we'll text") || lower.includes("we'll email") || lower.includes('contact you shortly'))
  );
}

function FollowupCard({ text }: { text: string }) {
  const lower = text.toLowerCase();
  const method = lower.includes('text') || lower.includes('sms') ? 'SMS' : 'Email';
  return (
    <div className="demo-followup-card">
      <div className="demo-followup-card-icon">✅</div>
      <div className="demo-followup-card-body">
        <div className="demo-followup-card-title">Follow-up Scheduled</div>
        <div className="demo-followup-card-detail">
          Contact method: <strong>{method}</strong>
        </div>
        <div className="demo-followup-card-detail">
          Expected timeframe: <strong>shortly</strong>
        </div>
      </div>
    </div>
  );
}

/* ── Typing Indicator ───────────────────────────────────── */
function TypingIndicator() {
  return (
    <div className="demo-typing-indicator">
      <span className="demo-typing-dot" style={{ animationDelay: '0ms' }} />
      <span className="demo-typing-dot" style={{ animationDelay: '160ms' }} />
      <span className="demo-typing-dot" style={{ animationDelay: '320ms' }} />
    </div>
  );
}

/* ── Avatar ─────────────────────────────────────────────── */
function Avatar({ role }: { role: 'user' | 'assistant' }) {
  if (role === 'assistant') {
    return (
      <div className="demo-avatar demo-avatar-bot">
        <span role="img" aria-label="bot">🌸</span>
      </div>
    );
  }
  return (
    <div className="demo-avatar demo-avatar-user">
      <span role="img" aria-label="user">👤</span>
    </div>
  );
}

/* ── Push Slot Card (Feature 3: Proactive Push) ─────────── */
function PushSlotCard({
  pushData,
  onSlotClick,
}: {
  pushData: PushEventData;
  onSlotClick: (text: string) => void;
}) {
  const isWaitlist = pushData.type === 'waitlist_match';
  const isConfirmation = pushData.type === 'calendar_retry_success';

  return (
    <div className="demo-push-card">
      <div className="demo-push-card-header">
        <span className="demo-push-card-icon">{isWaitlist ? '🎉' : '✅'}</span>
        <span className="demo-push-card-title">
          {isWaitlist ? 'New Opening Found!' : 'Booking Confirmed'}
        </span>
      </div>
      <div className="demo-push-card-body">
        {pushData.payload.message}
      </div>
      {isWaitlist && pushData.payload.slots && pushData.payload.slots.length > 0 && (
        <div className="demo-push-card-slots">
          {pushData.payload.slots.map((slot, i) => (
            <button
              key={i}
              className="demo-push-slot-btn"
              onClick={() => onSlotClick(
                `I'd like to book the ${slot.display_time} slot${slot.service ? ` for ${slot.service}` : ''}`
              )}
              title={`Click to book: ${slot.display_time}`}
            >
              📅 {slot.display_time}
              {slot.service && <span className="demo-push-slot-service"> · {slot.service}</span>}
            </button>
          ))}
        </div>
      )}
      {isConfirmation && pushData.payload.reference_code && (
        <div className="demo-push-card-ref">
          Reference: <strong>{pushData.payload.reference_code}</strong>
        </div>
      )}
    </div>
  );
}

/* ── Main Widget ────────────────────────────────────────── */
let msgIdCounter = 0;
function nextMsgId() { return `msg-${++msgIdCounter}-${Date.now()}`; }

export function DemoChatWidget({
  tenantId = DEFAULT_TENANT_ID,
  serverUrl,
}: DemoChatWidgetProps) {
  // In dev, Vite proxy forwards /api + /ws to the backend — use same origin.
  // In prod or with explicit env vars, use the configured URLs.
  const wsUrl = serverUrl || import.meta.env.VITE_WS_URL || '';
  const apiUrl = serverUrl || import.meta.env.VITE_API_URL || '';

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [handoffContext, setHandoffContext] = useState<Record<string, any> | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [autonomyEnabled, setAutonomyEnabled] = useState(false);
  const [workflowStats, setWorkflowStats] = useState<{
    waitlist?: number;
    pendingJobs?: number;
    scheduledReminders?: number;
  } | null>(null);

  // Toast notification system
  const { toasts, addToast, removeToast } = useToasts();

  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handoffProcessed = useRef(false);

  // ── Token Manager (refs — no re-render on mutation) ──────────
  const sessionTokenRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);     // tracks WS session, no deps
  const tokenExpiresRef = useRef<number>(0);             // epoch ms
  const tokenRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rejoinAttempted = useRef(false);                 // prevent infinite retry

  // ── Acquire / Refresh Session Token ──────────────────────────
  const acquireToken = useCallback(async (): Promise<boolean> => {
    console.log('[demo-auth] 🔄 Requesting token…', { apiUrl, tenantId });
    try {
      const res = await fetch(`${apiUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId }),
      });
      console.log(`[demo-auth] POST /api/auth/session → ${res.status}`);
      if (!res.ok) {
        console.error('[demo-auth] ❌ Token acquisition failed:', res.status, await res.text().catch(() => ''));
        return false;
      }
      const data = await res.json();
      if (!data.token) {
        console.error('[demo-auth] ❌ Response missing token field:', Object.keys(data));
        return false;
      }

      sessionTokenRef.current = data.token;
      sessionIdRef.current = data.session_id ?? sessionIdRef.current;
      setCurrentSessionId(data.session_id ?? null);

      // Parse expiry for proactive refresh
      const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : Date.now() + 4 * 60 * 60 * 1000;
      tokenExpiresRef.current = expiresAt;

      // Schedule proactive refresh at 80% of TTL
      const ttlMs = expiresAt - Date.now();
      const refreshIn = Math.max(ttlMs * 0.8, 30_000); // at least 30s
      if (tokenRefreshTimer.current) clearTimeout(tokenRefreshTimer.current);
      tokenRefreshTimer.current = setTimeout(() => {
        console.log('[demo-auth] ⏰ Proactive token refresh…');
        acquireToken().then(ok => {
          if (ok && socketRef.current?.connected) {
            // Re-join with fresh token (server updates its session state)
            socketRef.current.emit('join', {
              tenant_id: tenantId,
              session_id: sessionIdRef.current ?? undefined,
              token: sessionTokenRef.current ?? undefined,
            });
          }
        });
      }, refreshIn);

      console.log(
        `[demo-auth] ✅ Token acquired — tenant=${tenantId} session=${data.session_id?.slice(0, 8)}… ` +
        `TTL=${Math.round(ttlMs / 60_000)}min expires=${new Date(expiresAt).toLocaleTimeString()}`
      );
      return true;
    } catch (err) {
      console.error('[demo-auth] ❌ Token acquisition error:', err);
      return false;
    }
  }, [apiUrl, tenantId]);

  // ── Initial token acquisition on mount (retry until success) ─
  const [tokenReady, setTokenReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;

    async function tryAcquire() {
      while (!cancelled) {
        attempt++;
        console.log(`[demo-auth] Attempt #${attempt}…`);
        const ok = await acquireToken();
        if (ok && !cancelled) {
          console.log('[demo-auth] ✅ tokenReady=true');
          setTokenReady(true);
          return;
        }
        if (cancelled) return;
        // Retry with backoff: 1s, 2s, 4s, max 8s
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        console.warn(`[demo-auth] ⏳ Retry in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    tryAcquire();
    return () => {
      cancelled = true;
      if (tokenRefreshTimer.current) clearTimeout(tokenRefreshTimer.current);
    };
  }, [acquireToken]);

  // ── Fetch Demo Mode + Autonomy Status ────────────────────────
  useEffect(() => {
    fetch(`${apiUrl}/api/config`)
      .then(r => r.json())
      .then(data => {
        setIsDemoMode(!!data.demo_availability);
        setAutonomyEnabled(!!data.autonomy?.enabled);
      })
      .catch(() => {}); // ignore — banners just won't show
  }, [apiUrl]);

  // ── Poll Workflow Stats (every 10s when autonomy is on) ─────
  // NOTE: /api/autonomy/workflows requires admin key. In demo mode
  // we attempt the fetch but silently ignore 401s. Stats banner just
  // won't populate — the chat itself is unaffected.
  useEffect(() => {
    if (!autonomyEnabled) return;
    let cancelled = false;
    const fetchStats = () => {
      fetch(`${apiUrl}/api/autonomy/workflows?tenant_id=${tenantId}`)
        .then(r => {
          if (!r.ok) return null; // 401 in demo mode — expected
          return r.json();
        })
        .then(data => {
          if (!data || cancelled) return;
          setWorkflowStats({
            waitlist: data.waitlist?.waiting ?? 0,
            pendingJobs: (data.jobs?.pending ?? 0) + (data.jobs?.claimed ?? 0),
            scheduledReminders: 0,
          });
        })
        .catch(() => {});
    };
    fetchStats();
    const timer = setInterval(fetchStats, 30_000); // 30s, not 10s (reduce log noise)
    return () => { cancelled = true; clearInterval(timer); };
  }, [apiUrl, tenantId, autonomyEnabled]);

  // ── Handoff Token Detection ─────────────────────────────────
  // Check URL for ?handoff= parameter (from SMS link)
  useEffect(() => {
    if (handoffProcessed.current) return;
    const params = new URLSearchParams(window.location.search);
    const handoffToken = params.get('handoff');
    if (!handoffToken) return;

    handoffProcessed.current = true;

    // Clean URL (remove token from browser bar for security)
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);

    // Redeem the token
    fetch(`${apiUrl}/handoff/resume?token=${encodeURIComponent(handoffToken)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.context) {
          setHandoffContext(data.context);
          // Show a welcome-back message
          setMessages(prev => [
            ...prev,
            {
              id: nextMsgId(),
              role: 'assistant',
              content: `📱 ${data.context.resumeMessage ?? 'Continuing from your phone call. Let\'s pick up where we left off!'}`,
              timestamp: new Date(),
            },
          ]);
        } else {
          setMessages(prev => [
            ...prev,
            {
              id: nextMsgId(),
              role: 'assistant',
              content: '⚠️ This handoff link has expired or was already used. Please start a new conversation or call back for a fresh link.',
              timestamp: new Date(),
            },
          ]);
        }
      })
      .catch(() => {
        setMessages(prev => [
          ...prev,
          {
            id: nextMsgId(),
            role: 'assistant',
            content: '⚠️ Could not connect to the server. Please try again.',
            timestamp: new Date(),
          },
        ]);
      });
  }, [apiUrl]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping, statusText]);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, []);

  // WebSocket connection — waits until token acquisition attempt completes
  useEffect(() => {
    if (!tokenReady) return; // Don't connect until token fetch succeeds

    // Guard: token MUST be present (tokenReady only set on success now)
    if (!sessionTokenRef.current) {
      console.error('[demo-ws] ⛔ tokenReady=true but no token in ref — skipping WS connect');
      return;
    }

    rejoinAttempted.current = false; // reset on fresh connection

    console.log('[demo-ws] 🔌 Creating Socket.IO connection…', { wsUrl });
    const socket = io(wsUrl, {
      path: '/ws',
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    /** Emit join with current token + session (used on connect and re-auth) */
    const emitJoin = () => {
      const joinTenant = handoffContext?.tenantId || tenantId;
      const joinSession = handoffContext?.sessionId || sessionIdRef.current || undefined;
      const joinToken = sessionTokenRef.current ?? undefined;

      if (!joinToken) {
        console.error('[demo-ws] ⛔ emitJoin called but no token — skipping');
        return;
      }

      socket.emit('join', {
        tenant_id: joinTenant,
        session_id: joinSession,
        token: joinToken,
      });
      console.log(
        `[demo-ws] 📡 join emitted — tenant=${joinTenant} session=${String(joinSession)?.slice(0, 8)}… ` +
        `token=${joinToken.slice(0, 12)}…`
      );
    };

    socket.on('connect', () => {
      console.log(`[demo-ws] ✅ Socket connected — id=${socket.id}`);
      setIsConnected(true);
      emitJoin();
    });

    socket.on('joined', (data: { session_id?: string }) => {
      // Session established — update refs + display state (no WS reconnect)
      if (data?.session_id) {
        sessionIdRef.current = data.session_id;
        setCurrentSessionId(data.session_id);
      }
      rejoinAttempted.current = false; // successful join resets retry flag
      console.log(`[demo-ws] ✅ Joined — session=${data?.session_id?.slice(0, 8)}… (server confirmed)`);
    });

    socket.on('response', (data: { response: string; meta?: { tools_used?: string[]; has_async_job?: boolean } }) => {
      setStatusText(null);
      setMessages(prev => [
        ...prev,
        {
          id: nextMsgId(),
          role: 'assistant',
          content: data.response,
          timestamp: new Date(),
        },
      ]);
      setIsTyping(false);

      // Brief async-job status chip (auto-clears after 3s)
      if (data.meta?.has_async_job) {
        setStatusText('Scheduling follow-up in progress…');
        setTimeout(() => setStatusText(null), 3000);
      }

      // Fire toast notifications for booking events
      detectEvents(data.response, addToast);
    });

    socket.on('status', (data: { phase: string; detail: string }) => {
      setStatusText(data.detail);
    });

    socket.on('typing', (data: { typing: boolean }) => {
      setIsTyping(data.typing);
      if (!data.typing) setStatusText(null);
    });

    socket.on('error', (data: { error: string }) => {
      const isTokenError = /invalid|expired|session token required/i.test(data.error);
      const isJoinError = /must join/i.test(data.error);

      console.warn(`[demo-ws] ⚠️ Server error: "${data.error}" (tokenErr=${isTokenError} joinErr=${isJoinError} retried=${rejoinAttempted.current})`);

      // ── Auto-recovery: re-mint token and rejoin once ──────
      if ((isTokenError || isJoinError) && !rejoinAttempted.current) {
        rejoinAttempted.current = true;
        console.log('[demo-ws] 🔄 Auto-recovery: re-minting token…');
        setStatusText('Session expired — reconnecting…');

        acquireToken().then(ok => {
          console.log(`[demo-ws] 🔄 Re-mint result: ok=${ok} connected=${socket.connected}`);
          if (ok && socket.connected) {
            emitJoin();
            // Clear the status after a brief moment
            setTimeout(() => setStatusText(null), 1500);
          } else {
            console.error('[demo-ws] ❌ Recovery failed — token ok:', ok, 'connected:', socket.connected);
            setStatusText(null);
            setMessages(prev => [
              ...prev,
              {
                id: nextMsgId(),
                role: 'assistant',
                content: '⚠️ Could not reconnect. Please refresh the page.',
                timestamp: new Date(),
              },
            ]);
          }
        });
        return; // don't show raw error to user
      }

      // ── Regular error (non-auth) — show to user ───────────
      setStatusText(null);
      setIsTyping(false);
      const errorText = `⚠️ ${data.error}`;
      setMessages(prev => [
        ...prev,
        {
          id: nextMsgId(),
          role: 'assistant',
          content: errorText,
          timestamp: new Date(),
        },
      ]);

      // Fire error toast
      detectEvents(errorText, addToast);
    });

    socket.on('disconnect', (reason: string) => {
      console.warn(`[demo-ws] 🔌 Disconnected — reason=${reason}`);
      setIsConnected(false);
      addToast('warning', 'Disconnected', 'Connection to server lost. Attempting to reconnect…');
    });

    // Feature 3: Proactive push events (waitlist matches, calendar confirmations)
    socket.on('push', (data: PushEventData) => {
      setMessages(prev => [
        ...prev,
        {
          id: `push-${data.id ?? nextMsgId()}`,
          role: 'assistant',
          content: data.payload?.message ?? 'New update from the agent.',
          timestamp: new Date(data.created_at ?? Date.now()),
          pushData: data,
        },
      ]);

      // Toast notification for push events
      if (data.type === 'waitlist_match') {
        addToast('success', 'Slot Available!', 'A new opening was found from your waitlist.');
      } else if (data.type === 'calendar_retry_success') {
        addToast('success', 'Booking Confirmed', 'Your booking has been synced successfully.');
      }
    });

    return () => { console.log('[demo-ws] 🧹 Cleanup — disconnecting socket'); socket.disconnect(); };
  }, [tenantId, wsUrl, handoffContext, addToast, tokenReady, acquireToken]);

  // Send message
  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || !socketRef.current?.connected) return;

    setMessages(prev => [
      ...prev,
      {
        id: nextMsgId(),
        role: 'user',
        content: trimmed,
        timestamp: new Date(),
      },
    ]);
    setInput('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    socketRef.current.emit('message', { message: trimmed });
  }, [input]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Quick action chips
  const quickActions = useMemo(() => [
    '📅 Book an appointment',
    '🔄 Reschedule',
    '❌ Cancel booking',
    '🕐 Opening hours',
    '💆 View services',
    '📝 Join waitlist',
    '📩 Contact me later',
  ], []);

  const handleQuickAction = useCallback((action: string) => {
    // Strip emoji prefix for cleaner message
    const text = action.replace(/^[^\w]+/, '').trim();
    if (!socketRef.current?.connected) return;
    setMessages(prev => [
      ...prev,
      { id: nextMsgId(), role: 'user', content: text, timestamp: new Date() },
    ]);
    socketRef.current.emit('message', { message: text });
  }, []);

  // Feature 3: Handle click on a pushed slot button — send booking request
  const handlePushSlotClick = useCallback((text: string) => {
    if (!socketRef.current?.connected) return;
    setMessages(prev => [
      ...prev,
      { id: nextMsgId(), role: 'user', content: text, timestamp: new Date() },
    ]);
    socketRef.current.emit('message', { message: text });
  }, []);

  const showQuickActions = messages.length <= 1; // Show after auto-greet only

  return (
    <>
    {/* ── Toast Notifications (fixed top-right) ── */}
    <ToastContainer toasts={toasts} onDismiss={removeToast} />

    <div className="demo-widget">
      {/* ── Session Info Banner (test mode) ───── */}
      <div className="demo-session-banner">
        <span className={`demo-session-dot ${isConnected ? 'live' : ''}`} />
        <span>Tenant: <strong>Gomomo</strong></span>
        <span className="demo-session-sep">·</span>
        <span>Session: <code>{currentSessionId ? currentSessionId.slice(0, 12) + '…' : '—'}</code></span>
        <span className="demo-session-sep">·</span>
        <span style={{ color: isConnected ? '#4ade80' : '#f59e0b' }}>
          {isConnected ? 'Live' : 'Connecting'}
        </span>
        {isDemoMode && (
          <>
            <span className="demo-session-sep">·</span>
            <span style={{ color: '#a78bfa' }} title="Mon–Fri 9 AM – 5 PM ET · Set DEMO_AVAILABILITY=false to disable">
              🧪 Demo Availability
            </span>
          </>
        )}
        <span className="demo-session-sep">·</span>
        <span
          style={{ color: autonomyEnabled ? '#4ade80' : '#94a3b8' }}
          title={autonomyEnabled
            ? 'Autonomous agent runtime is active — policy-gated jobs running'
            : 'Autonomy OFF — events logged but jobs not executed. Set AUTONOMY_ENABLED=true to activate.'}
        >
          {autonomyEnabled ? '🤖 Autonomy: ON' : '🤖 Autonomy: OFF'}
        </span>
        {autonomyEnabled && workflowStats && (
          <>
            <span className="demo-session-sep">·</span>
            <span style={{ color: '#fbbf24', fontSize: '0.72rem' }} title="Active workflow metrics">
              📋 {workflowStats.waitlist ?? 0} waitlist
              {' · '}
              ⏳ {workflowStats.pendingJobs ?? 0} jobs
            </span>
          </>
        )}
      </div>

      {/* ── Header ─────────────────────────────── */}
      <div className="demo-header">
        <div className="demo-header-left">
          <div className="demo-header-avatar">�</div>
          <div className="demo-header-info">
            <div className="demo-header-name">Gomomo</div>
            <div className="demo-header-status">
              <span className={`demo-status-dot ${isConnected ? 'online' : 'offline'}`} />
              {isConnected ? 'Online — Typically replies instantly' : 'Connecting…'}
            </div>
          </div>
        </div>
        <div className="demo-header-badge">AI</div>
      </div>

      {/* ── Messages ───────────────────────────── */}
      <div className="demo-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`demo-msg-row ${msg.role}`}>
            {msg.role === 'assistant' && <Avatar role="assistant" />}
            <div className={`demo-msg-col ${msg.role}`}>
              <div className={`demo-bubble ${msg.role}${msg.pushData ? ' push-bubble' : ''}`}>
                {msg.role === 'assistant' ? renderMarkdown(msg.content) : msg.content}
              </div>
              {msg.role === 'assistant' && msg.pushData && (
                <PushSlotCard pushData={msg.pushData} onSlotClick={handlePushSlotClick} />
              )}
              {msg.role === 'assistant' && isFollowupMessage(msg.content) && (
                <FollowupCard text={msg.content} />
              )}
              <div className={`demo-timestamp ${msg.role}`}>
                {formatTime(msg.timestamp)}
              </div>
            </div>
            {msg.role === 'user' && <Avatar role="user" />}
          </div>
        ))}

        {/* Typing indicator + status chip */}
        {(isTyping || statusText) && (
          <div className="demo-msg-row assistant">
            <Avatar role="assistant" />
            <div className="demo-msg-col assistant">
              <div className="demo-bubble assistant typing-bubble">
                {statusText ? (
                  <div className="demo-status-chip">
                    <span className="demo-status-chip-icon">⚙️</span>
                    <span className="demo-status-chip-text">{statusText}</span>
                    <TypingIndicator />
                  </div>
                ) : (
                  <TypingIndicator />
                )}
              </div>
            </div>
          </div>
        )}

        {/* Quick action chips */}
        {showQuickActions && !isTyping && messages.length > 0 && (
          <div className="demo-quick-actions">
            {quickActions.map((action) => (
              <button
                key={action}
                className="demo-chip"
                onClick={() => handleQuickAction(action)}
              >
                {action}
              </button>
            ))}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input Bar ──────────────────────────── */}
      <div className="demo-input-bar">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message…"
          className="demo-input"
          disabled={!isConnected}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || !isConnected}
          className="demo-send-btn"
          aria-label="Send message"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      {/* ── Footer Badge ──────────────────────── */}
      <div className="demo-footer">
        Powered by <strong>gomomo.ai</strong> · Demo Mode
      </div>
    </div>
    </>
  );
}
