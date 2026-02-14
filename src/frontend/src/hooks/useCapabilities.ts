/**
 * useCapabilities — React hook that fetches the capability model from
 * GET /api/capabilities and caches the result for the lifetime of the
 * component tree.
 *
 * Usage:
 *   const { capabilities, loading, error } = useCapabilities();
 *   if (capabilities?.sms) { /* show SMS UI * / }
 */
import { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '';

export interface AppCapabilities {
  chat: boolean;
  booking: boolean;
  calendar: boolean;
  sms: boolean;
  voice: boolean;
  voiceWeb: boolean;
  emailGate: boolean;
  excel: boolean;
  autonomy: boolean;
}

interface UseCapabilitiesResult {
  capabilities: AppCapabilities | null;
  loading: boolean;
  error: string | null;
}

/** Module-level cache so we don't re-fetch on every mount. */
let cachedCapabilities: AppCapabilities | null = null;

export function useCapabilities(): UseCapabilitiesResult {
  const [capabilities, setCapabilities] = useState<AppCapabilities | null>(cachedCapabilities);
  const [loading, setLoading] = useState(!cachedCapabilities);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cachedCapabilities) return; // already fetched

    let cancelled = false;

    fetch(`${API_URL}/api/capabilities`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<AppCapabilities>;
      })
      .then((data) => {
        if (cancelled) return;
        cachedCapabilities = data;
        setCapabilities(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { capabilities, loading, error };
}
