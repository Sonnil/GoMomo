/**
 * Unit tests for chat-persistence.ts
 *
 * Tests cover:
 *   1. Hydrate from localStorage
 *   2. Persist on save
 *   3. Clear removes key
 *   4. Schema version mismatch clears safely
 *   5. OTP sanitization
 *   6. Corrupted data handling
 *   7. Debounced save
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  SCHEMA_VERSION,
  storageKey,
  loadChat,
  saveChat,
  clearChat,
  sanitizeOtp,
  sanitizeMessages,
  saveChatDebounced,
  type PersistedChat,
  type PersistedMessage,
} from '../src/lib/chat-persistence';

/* ── Mock localStorage ──────────────────────────────────── */
const store: Record<string, string> = {};

const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, val: string) => { store[key] = val; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k]; }),
  get length() { return Object.keys(store).length; },
  key: vi.fn((_i: number) => null),
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

/* ── Helpers ────────────────────────────────────────────── */
const TENANT = 'test-tenant-123';
const SESSION = 'sess-abc';
const KEY = storageKey(TENANT);

function makeMessages(...contents: string[]): PersistedMessage[] {
  return contents.map((c) => ({ role: 'user' as const, content: c }));
}

function makeChatData(overrides: Partial<PersistedChat> = {}): PersistedChat {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: SESSION,
    messages: makeMessages('hello', 'world'),
    lastUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/* ── storageKey ─────────────────────────────────────────── */
describe('storageKey', () => {
  it('formats key with tenant ID', () => {
    expect(storageKey('abc')).toBe('gomomo_chat_v1:abc');
  });
});

/* ── loadChat ───────────────────────────────────────────── */
describe('loadChat', () => {
  it('returns null when nothing stored', () => {
    expect(loadChat(TENANT)).toBeNull();
  });

  it('hydrates valid cached data', () => {
    const data = makeChatData();
    store[KEY] = JSON.stringify(data);
    const result = loadChat(TENANT);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(SESSION);
    expect(result!.messages).toHaveLength(2);
    expect(result!.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('clears and returns null on schema version mismatch', () => {
    const data = makeChatData({ schemaVersion: 999 });
    store[KEY] = JSON.stringify(data);
    const result = loadChat(TENANT);
    expect(result).toBeNull();
    expect(store[KEY]).toBeUndefined();
  });

  it('clears and returns null on corrupted JSON', () => {
    store[KEY] = '{broken json!!!';
    const result = loadChat(TENANT);
    expect(result).toBeNull();
    expect(store[KEY]).toBeUndefined();
  });

  it('clears and returns null on missing required fields', () => {
    store[KEY] = JSON.stringify({ schemaVersion: SCHEMA_VERSION, sessionId: 'x' });
    // missing messages and lastUpdatedAt
    const result = loadChat(TENANT);
    expect(result).toBeNull();
  });

  it('clears and returns null on non-object value', () => {
    store[KEY] = '"just a string"';
    const result = loadChat(TENANT);
    expect(result).toBeNull();
  });
});

/* ── saveChat ───────────────────────────────────────────── */
describe('saveChat', () => {
  it('persists messages to localStorage', () => {
    const msgs = makeMessages('hi', 'there');
    saveChat(TENANT, SESSION, msgs);
    const raw = store[KEY];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.sessionId).toBe(SESSION);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.lastUpdatedAt).toBeTruthy();
  });

  it('sanitizes OTP codes before persisting', () => {
    const msgs: PersistedMessage[] = [
      { role: 'assistant', content: 'Your code is 123456' },
    ];
    saveChat(TENANT, SESSION, msgs);
    const parsed = JSON.parse(store[KEY]);
    expect(parsed.messages[0].content).toBe('Your code is ●●●●●●');
    expect(parsed.messages[0].content).not.toContain('123456');
  });

  it('overwrites previous data', () => {
    saveChat(TENANT, SESSION, makeMessages('first'));
    saveChat(TENANT, SESSION, makeMessages('first', 'second'));
    const parsed = JSON.parse(store[KEY]);
    expect(parsed.messages).toHaveLength(2);
  });
});

/* ── clearChat ──────────────────────────────────────────── */
describe('clearChat', () => {
  it('removes the chat key from localStorage', () => {
    store[KEY] = JSON.stringify(makeChatData());
    clearChat(TENANT);
    expect(store[KEY]).toBeUndefined();
  });

  it('also removes legacy gomomo_session_id key', () => {
    store['gomomo_session_id'] = 'old-session';
    store[KEY] = JSON.stringify(makeChatData());
    clearChat(TENANT);
    expect(store['gomomo_session_id']).toBeUndefined();
    expect(store[KEY]).toBeUndefined();
  });

  it('is safe to call when nothing exists', () => {
    expect(() => clearChat(TENANT)).not.toThrow();
  });
});

/* ── sanitizeOtp ────────────────────────────────────────── */
describe('sanitizeOtp', () => {
  it('redacts "code is 123456" pattern', () => {
    expect(sanitizeOtp('Your code is 123456')).toBe('Your code is ●●●●●●');
  });

  it('redacts "OTP: 1234" pattern', () => {
    expect(sanitizeOtp('OTP: 1234')).toBe('OTP: ●●●●');
  });

  it('redacts "verification code is 87654321"', () => {
    expect(sanitizeOtp('verification code is 87654321')).toBe('verification code is ●●●●●●●●');
  });

  it('redacts "pin 5678"', () => {
    expect(sanitizeOtp('Your pin 5678 expires soon')).toBe('Your pin ●●●● expires soon');
  });

  it('does NOT redact prices', () => {
    expect(sanitizeOtp('The price is $120/session')).toBe('The price is $120/session');
  });

  it('does NOT redact years', () => {
    expect(sanitizeOtp('Established in 2024')).toBe('Established in 2024');
  });

  it('preserves clean text unchanged', () => {
    const text = 'Hello, how can I help you today?';
    expect(sanitizeOtp(text)).toBe(text);
  });

  it('handles multiple OTP patterns in one message', () => {
    expect(sanitizeOtp('code is 1234 and OTP: 5678')).toBe('code is ●●●● and OTP: ●●●●');
  });
});

/* ── sanitizeMessages ───────────────────────────────────── */
describe('sanitizeMessages', () => {
  it('sanitizes OTP in message content', () => {
    const msgs: PersistedMessage[] = [
      { role: 'assistant', content: 'Your code is 999999' },
      { role: 'user', content: 'I got the code' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result[0].content).toBe('Your code is ●●●●●●');
    expect(result[1].content).toBe('I got the code');
  });

  it('keeps system verification messages', () => {
    const msgs: PersistedMessage[] = [
      { role: 'system', content: '✅ Email verified — you\'re all set!' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(1);
  });

  it('preserves pushType and pushRef fields', () => {
    const msgs: PersistedMessage[] = [
      { role: 'assistant', content: 'Slot available', pushType: 'waitlist_match', pushRef: 'REF-001' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result[0].pushType).toBe('waitlist_match');
    expect(result[0].pushRef).toBe('REF-001');
  });
});

/* ── saveChatDebounced ──────────────────────────────────── */
describe('saveChatDebounced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not save immediately', () => {
    saveChatDebounced(TENANT, SESSION, makeMessages('hi'), 100);
    expect(store[KEY]).toBeUndefined();
  });

  it('saves after the delay elapses', () => {
    saveChatDebounced(TENANT, SESSION, makeMessages('hi'), 100);
    vi.advanceTimersByTime(150);
    expect(store[KEY]).toBeDefined();
    const parsed = JSON.parse(store[KEY]);
    expect(parsed.messages[0].content).toBe('hi');
  });

  it('debounces: only the last call wins', () => {
    saveChatDebounced(TENANT, SESSION, makeMessages('first'), 100);
    saveChatDebounced(TENANT, SESSION, makeMessages('first', 'second'), 100);
    vi.advanceTimersByTime(150);
    const parsed = JSON.parse(store[KEY]);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1].content).toBe('second');
  });
});

/* ── Round-trip: save → load ────────────────────────────── */
describe('round-trip', () => {
  it('save then load returns equivalent data', () => {
    const msgs = makeMessages('one', 'two', 'three');
    saveChat(TENANT, SESSION, msgs);
    const loaded = loadChat(TENANT);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(SESSION);
    expect(loaded!.messages).toHaveLength(3);
    expect(loaded!.messages.map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('save → clear → load returns null', () => {
    saveChat(TENANT, SESSION, makeMessages('data'));
    clearChat(TENANT);
    expect(loadChat(TENANT)).toBeNull();
  });
});
