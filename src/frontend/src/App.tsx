import React, { useState, useCallback } from 'react';
import { ChatWidget } from './components/ChatWidget';
import { CeoTestPanel } from './components/CeoTestPanel';

// ── Default tenant ID ───────────────────────────────────
// Gomomo — seeded by src/db/seed.ts
const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';

// CEO test panel is visible ONLY when explicitly enabled via env var.
// It does NOT show in normal dev mode by default.
const showCeoPanel =
  import.meta.env.VITE_CEO_TEST_MODE === 'true' ||
  import.meta.env.VITE_CEO_TEST_MODE === '1';

interface AppProps {
  /** When true, hide header/branding and fill the iframe completely. */
  embed?: boolean;
}

export function App({ embed = false }: AppProps) {
  // In production, tenant ID would come from embed script or URL.
  // Locally, defaults to the Gomomo seed tenant.
  const tenantId = import.meta.env.VITE_TENANT_ID || DEFAULT_TENANT_ID;

  // ── CEO test panel → chat injection ─────────────────
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const handleInjectMessage = useCallback((msg: string) => {
    setPendingMessage(msg);
  }, []);
  const handleMessageConsumed = useCallback(() => {
    setPendingMessage(null);
  }, []);

  // ── Embed mode: full-height, no header, no padding ──
  if (embed) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <ChatWidget
          tenantId={tenantId}
          embed
          pendingMessage={pendingMessage}
          onPendingMessageConsumed={handleMessageConsumed}
        />
      </div>
    );
  }

  return (
    <div style={{ width: '100%', maxWidth: 480, padding: 16 }}>
      <h1 style={{ textAlign: 'center', marginBottom: 8, fontSize: 22 }}>
        🚀 gomomo.ai
      </h1>
      <p style={{ textAlign: 'center', marginBottom: 24, color: 'var(--text-muted)', fontSize: 14 }}>
        Intelligent scheduling, powered by AI
      </p>
      <ChatWidget
        tenantId={tenantId}
        pendingMessage={pendingMessage}
        onPendingMessageConsumed={handleMessageConsumed}
      />
      {showCeoPanel && (
        <CeoTestPanel onInjectMessage={handleInjectMessage} />
      )}
    </div>
  );
}
