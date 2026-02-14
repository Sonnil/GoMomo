// ============================================================
// Agent Screen — gomomo chat UI
//
// Connects to the backend via Socket.IO, sends/receives messages,
// shows typing indicator, and handles the email gate flow.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { chatClient, type ChatResponse, type EmailGateEvent, type TrialLimitEvent, type BookingData } from '../../lib/chat';
import { acquireSession, type SessionData } from '../../lib/session';
import { TENANT_ID } from '../../lib/config';
import { EmailGateModal } from '../../components/EmailGateModal';
import { BookingConfirmationCard } from '../../components/BookingConfirmationCard';
import { BookingFailureBanner, isCalendarFailure, isBookingError } from '../../components/BookingFailureBanner';

// ── Types ──────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Attached when the assistant confirms a booking. */
  bookingData?: BookingData;
  /** True when the assistant message describes a calendar/booking failure. */
  isBookingFailure?: boolean;
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

// ── Component ──────────────────────────────────────────────

export default function AgentScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [isTyping, setIsTyping] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [showEmailGate, setShowEmailGate] = useState(false);
  const [pendingGateMessage, setPendingGateMessage] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [trialLimitReached, setTrialLimitReached] = useState(false);

  const flatListRef = useRef<FlatList<ChatMessage>>(null);
  const msgIdCounter = useRef(0);

  const nextId = () => {
    msgIdCounter.current += 1;
    return `msg-${msgIdCounter.current}`;
  };

  // ── Connect on mount ──────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setConnectionState('connecting');
      setErrorBanner(null);

      try {
        const session = await acquireSession();
        if (cancelled) return;
        setSessionData(session);

        await chatClient.connect(session);
        if (cancelled) return;
        setConnectionState('connected');
      } catch (err: unknown) {
        if (cancelled) return;
        setConnectionState('error');
        const message = err instanceof Error ? err.message : 'Failed to connect.';
        setErrorBanner(message);
      }
    }

    init();

    // ── Wire up event listeners ──────────────────────────

    const onResponse = (data: ChatResponse) => {
      setStatusText(null);
      setPendingGateMessage(null);

      // Determine if the response carries booking data or signals a failure
      const hasBooking = data.meta?.booking_data != null;
      const failureDetected =
        !hasBooking && (isCalendarFailure(data.response) || isBookingError(data.response));

      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}-resp`,
          role: 'assistant',
          content: data.response,
          bookingData: data.meta?.booking_data ?? undefined,
          isBookingFailure: failureDetected || undefined,
        },
      ]);
      setIsTyping(false);

      if (data.meta?.has_async_job) {
        setStatusText('Scheduling follow-up…');
        setTimeout(() => setStatusText(null), 3000);
      }
    };

    const onTyping = (data: { typing: boolean }) => {
      setIsTyping(data.typing);
      if (!data.typing) setStatusText(null);
    };

    const onStatus = (data: { phase: string; detail: string }) => {
      setStatusText(data.detail);
    };

    const onGate = (_data: EmailGateEvent) => {
      setShowEmailGate(true);
      setIsTyping(false);
      setStatusText(null);
    };

    const onTrialLimit = (data: TrialLimitEvent) => {
      setTrialLimitReached(true);
      setIsTyping(false);
      setStatusText(null);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}-limit`,
          role: 'system',
          content: data.message || 'You have reached the trial message limit.',
        },
      ]);
    };

    const onError = (data: { error: string }) => {
      setStatusText(null);
      setMessages((prev) => [
        ...prev,
        { id: `msg-${Date.now()}-err`, role: 'assistant', content: `⚠️ ${data.error}` },
      ]);
      setIsTyping(false);
    };

    const onDisconnected = () => {
      setConnectionState('error');
      setErrorBanner('Connection lost. Tap to reconnect.');
    };

    chatClient.on('response', onResponse);
    chatClient.on('typing', onTyping);
    chatClient.on('status', onStatus);
    chatClient.on('email_gate_required', onGate);
    chatClient.on('trial_limit_reached', onTrialLimit);
    chatClient.on('error', onError);
    chatClient.on('disconnected', onDisconnected);

    return () => {
      cancelled = true;
      chatClient.off('response', onResponse);
      chatClient.off('typing', onTyping);
      chatClient.off('status', onStatus);
      chatClient.off('email_gate_required', onGate);
      chatClient.off('trial_limit_reached', onTrialLimit);
      chatClient.off('error', onError);
      chatClient.off('disconnected', onDisconnected);
      chatClient.disconnect();
    };
  }, []);

  // ── Auto-scroll ───────────────────────────────────────

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages, isTyping]);

  // ── Reconnect handler ─────────────────────────────────

  const handleReconnect = useCallback(async () => {
    setConnectionState('connecting');
    setErrorBanner(null);

    try {
      const session = await acquireSession();
      setSessionData(session);
      await chatClient.connect(session);
      setConnectionState('connected');
    } catch (err: unknown) {
      setConnectionState('error');
      const message = err instanceof Error ? err.message : 'Failed to reconnect.';
      setErrorBanner(message);
    }
  }, []);

  // ── Send message ──────────────────────────────────────

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || connectionState !== 'connected' || trialLimitReached) return;

    setPendingGateMessage(trimmed);
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: trimmed }]);
    setInput('');
    Keyboard.dismiss();

    try {
      chatClient.send(trimmed);
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: '⚠️ Failed to send. Please try again.' },
      ]);
    }
  }, [input, connectionState]);

  // ── Email gate verified ───────────────────────────────

  const handleEmailVerified = useCallback(
    (_verifiedEmail: string) => {
      setShowEmailGate(false);
      setEmailVerified(true);

      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'system', content: '✅ Email verified — you\'re all set!' },
      ]);

      // Re-send the gated message
      if (pendingGateMessage) {
        const msg = pendingGateMessage;
        setPendingGateMessage(null);
        setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: msg }]);
        try {
          chatClient.send(msg);
        } catch {
          // ignore — error listener will fire
        }
      }
    },
    [pendingGateMessage],
  );

  // ── Render helpers ────────────────────────────────────

  const renderMessage = useCallback(({ item }: { item: ChatMessage }) => {
    const isUser = item.role === 'user';
    const isSystem = item.role === 'system';

    if (isSystem) {
      return (
        <View style={styles.systemRow}>
          <Text style={styles.systemText}>{item.content}</Text>
        </View>
      );
    }

    // Booking confirmation card — shown instead of a plain bubble
    if (!isUser && item.bookingData) {
      return (
        <View style={styles.bubbleRow}>
          <View style={{ maxWidth: '88%' }}>
            <View style={[styles.bubble, styles.bubbleAssistant, { marginBottom: 6 }]}>
              <Text style={styles.bubbleText}>{item.content}</Text>
            </View>
            <BookingConfirmationCard booking={item.bookingData} />
          </View>
        </View>
      );
    }

    // Booking/calendar failure banner — friendly wrapper
    if (!isUser && item.isBookingFailure) {
      return (
        <View style={styles.bubbleRow}>
          <BookingFailureBanner message={item.content} />
        </View>
      );
    }

    return (
      <View style={[styles.bubbleRow, isUser && styles.bubbleRowUser]}>
        <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
          <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
            {item.content}
          </Text>
        </View>
      </View>
    );
  }, []);

  // ── Main render ───────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <StatusBar style="light" />

      {/* Error banner */}
      {errorBanner && (
        <Pressable style={styles.errorBanner} onPress={handleReconnect}>
          <Text style={styles.errorBannerText}>{errorBanner}</Text>
        </Pressable>
      )}

      {/* Connecting state */}
      {connectionState === 'connecting' && (
        <View style={styles.connectingBar}>
          <ActivityIndicator size="small" color="#6366f1" />
          <Text style={styles.connectingText}>Connecting to agent…</Text>
        </View>
      )}

      {/* Status chip */}
      {statusText && (
        <View style={styles.statusChip}>
          <Text style={styles.statusChipText}>{statusText}</Text>
        </View>
      )}

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messageList}
        ListEmptyComponent={
          connectionState === 'connected' ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>💬</Text>
              <Text style={styles.emptyTitle}>gomomo</Text>
              <Text style={styles.emptySubtitle}>
                Send a message to get started.
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          isTyping ? (
            <View style={styles.typingRow}>
              <View style={styles.typingDots}>
                <Text style={styles.typingText}>Agent is typing…</Text>
              </View>
            </View>
          ) : null
        }
      />

      {/* Trial Limit Banner */}
      {trialLimitReached && (
        <View style={styles.trialLimitBanner}>
          <Text style={styles.trialLimitText}>🚫 Trial limit reached. This demo session has ended.</Text>
        </View>
      )}

      {/* Input bar */}
      <View style={styles.inputBar}>
        <TextInput
          style={styles.textInput}
          placeholder={
            trialLimitReached
              ? 'Trial limit reached'
              : connectionState === 'connected'
                ? 'Type a message…'
                : 'Connecting…'
          }
          placeholderTextColor="#71717a"
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          editable={connectionState === 'connected' && !trialLimitReached}
          returnKeyType="send"
          multiline={false}
        />
        <Pressable
          style={[
            styles.sendBtn,
            (!input.trim() || connectionState !== 'connected' || trialLimitReached) && styles.sendBtnDisabled,
          ]}
          onPress={handleSend}
          disabled={!input.trim() || connectionState !== 'connected' || trialLimitReached}
        >
          <Text style={styles.sendBtnText}>↑</Text>
        </Pressable>
      </View>

      {/* Email gate modal */}
      {sessionData && (
        <EmailGateModal
          visible={showEmailGate}
          sessionId={sessionData.session_id}
          tenantId={TENANT_ID}
          onVerified={handleEmailVerified}
          onClose={() => setShowEmailGate(false)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

// ── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b',
  },

  // Error banner
  errorBanner: {
    backgroundColor: 'rgba(239,68,68,0.15)',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  errorBannerText: {
    color: '#ef4444',
    fontSize: 13,
    textAlign: 'center',
  },

  // Connecting
  connectingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 8,
  },
  connectingText: {
    color: '#71717a',
    fontSize: 13,
  },

  // Status chip
  statusChip: {
    alignSelf: 'center',
    backgroundColor: '#18181b',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginVertical: 4,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  statusChipText: {
    color: '#a1a1aa',
    fontSize: 12,
  },

  // Message list
  messageList: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexGrow: 1,
  },

  // Empty state
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fafafa',
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#71717a',
  },

  // Bubbles
  bubbleRow: {
    flexDirection: 'row',
    marginVertical: 3,
  },
  bubbleRowUser: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  bubbleUser: {
    backgroundColor: '#6366f1',
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: '#18181b',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  bubbleText: {
    color: '#e4e4e7',
    fontSize: 15,
    lineHeight: 21,
  },
  bubbleTextUser: {
    color: '#ffffff',
  },

  // System messages
  systemRow: {
    alignItems: 'center',
    marginVertical: 8,
  },
  systemText: {
    color: '#71717a',
    fontSize: 13,
    fontStyle: 'italic',
  },

  // Typing indicator
  typingRow: {
    flexDirection: 'row',
    marginVertical: 4,
  },
  typingDots: {
    backgroundColor: '#18181b',
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  typingText: {
    color: '#71717a',
    fontSize: 13,
    fontStyle: 'italic',
  },

  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#27272a',
    backgroundColor: '#09090b',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#18181b',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#fafafa',
    borderWidth: 1,
    borderColor: '#27272a',
    marginRight: 8,
  },
  sendBtn: {
    backgroundColor: '#6366f1',
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  sendBtnText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  trialLimitBanner: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(239, 68, 68, 0.25)',
  },
  trialLimitText: {
    color: '#fca5a5',
    fontSize: 13,
    textAlign: 'center' as const,
  },
});
