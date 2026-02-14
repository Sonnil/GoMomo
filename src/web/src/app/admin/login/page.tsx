'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setAdminKey, adminFetch } from '../layout';

export default function AdminLoginPage() {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Verify the key by hitting a protected endpoint
      setAdminKey(key);
      const res = await adminFetch('/api/tenants/00000000-0000-4000-a000-000000000001');

      if (res.ok || res.status === 404) {
        // Key is valid (or auth not enforced in dev) — redirect
        router.replace('/admin/tenants');
      } else if (res.status === 401 || res.status === 403) {
        setError('Invalid admin key. Please try again.');
        setAdminKey('');
      } else {
        // Unexpected — but key might still be fine (backend down, etc.)
        router.replace('/admin/tenants');
      }
    } catch {
      // Network error — assume backend is down, let them through
      // (pages will show errors if backend is unreachable)
      router.replace('/admin/tenants');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)]">
      <div className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8">
        <h1 className="mb-1 text-xl font-bold text-[var(--text)]">
          gomomo<span className="text-[var(--accent)]">.ai</span> Admin
        </h1>
        <p className="mb-6 text-sm text-[var(--text-muted)]">
          Enter your admin API key to continue.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="admin-key" className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
              Admin Key
            </label>
            <input
              id="admin-key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Enter admin API key…"
              required
              autoFocus
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--text-dim)] outline-none transition-colors focus:border-[var(--accent)]"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !key}
            className="w-full rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {loading ? 'Verifying…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-xs text-[var(--text-dim)]">
          In development mode (SDK_AUTH_REQUIRED=false), any key will work.
        </p>
      </div>
    </div>
  );
}
