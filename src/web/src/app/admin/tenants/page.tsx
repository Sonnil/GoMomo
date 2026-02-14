'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/admin';

interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  is_active: boolean;
  created_at: string;
}

export default function TenantsListPage() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTimezone, setNewTimezone] = useState('America/New_York');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const loadTenants = useCallback(async () => {
    try {
      // Use the existing GET /api/tenants endpoint — but we need admin listAll
      // The existing tenant routes don't have a list endpoint, so we'll fetch
      // via a custom approach: the backend has tenantRepo.listAll()
      // For now, we'll call the admin endpoint that returns all tenants
      // Since the existing routes only have GET /:id and POST /, we'll need
      // to handle this. Let's use the tenants POST/GET that exist.
      //
      // Actually, looking at the code, there's no GET /api/tenants (list all).
      // We need to add one. For now, let's use a workaround with the
      // known demo tenant, or add the endpoint.
      //
      // UPDATE: Let me check — the tenant.routes.ts has GET /api/tenants/:id
      // but no list. We added it in admin-onboarding routes? No. Let me add
      // a list endpoint.
      const res = await adminFetch('/api/admin/tenants');
      if (res.ok) {
        const data = await res.json();
        setTenants(Array.isArray(data) ? data : []);
      } else {
        setError('Failed to load tenants.');
      }
    } catch {
      setError('Backend unreachable. Is the server running?');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTenants();
  }, [loadTenants]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError('');

    try {
      const res = await adminFetch('/api/admin/tenants', {
        method: 'POST',
        body: JSON.stringify({
          name: newName,
          timezone: newTimezone,
          business_hours: {
            monday: { start: '09:00', end: '17:00' },
            tuesday: { start: '09:00', end: '17:00' },
            wednesday: { start: '09:00', end: '17:00' },
            thursday: { start: '09:00', end: '17:00' },
            friday: { start: '09:00', end: '17:00' },
            saturday: null,
            sunday: null,
          },
        }),
      });

      if (res.ok) {
        setNewName('');
        setShowCreate(false);
        loadTenants();
      } else {
        const data = await res.json().catch(() => ({}));
        setCreateError(data.error || 'Failed to create tenant.');
      }
    } catch {
      setCreateError('Network error.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text)]">Tenants</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Manage your business accounts.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
        >
          {showCreate ? 'Cancel' : '+ New Tenant'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Create Tenant</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                Business Name *
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Bella's Hair Studio"
                required
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--text-dim)] outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                Timezone
              </label>
              <select
                id="timezone"
                aria-label="Timezone"
                value={newTimezone}
                onChange={(e) => setNewTimezone(e.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
              >
                <option value="America/New_York">Eastern (America/New_York)</option>
                <option value="America/Chicago">Central (America/Chicago)</option>
                <option value="America/Denver">Mountain (America/Denver)</option>
                <option value="America/Los_Angeles">Pacific (America/Los_Angeles)</option>
                <option value="America/Anchorage">Alaska (America/Anchorage)</option>
                <option value="Pacific/Honolulu">Hawaii (Pacific/Honolulu)</option>
                <option value="Europe/London">London (Europe/London)</option>
                <option value="Europe/Paris">Paris (Europe/Paris)</option>
                <option value="Europe/Berlin">Berlin (Europe/Berlin)</option>
                <option value="Asia/Tokyo">Tokyo (Asia/Tokyo)</option>
                <option value="Asia/Shanghai">Shanghai (Asia/Shanghai)</option>
                <option value="Australia/Sydney">Sydney (Australia/Sydney)</option>
              </select>
            </div>
            {createError && <p className="text-sm text-red-400">{createError}</p>}
            <button
              type="submit"
              disabled={creating || !newName}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create Tenant'}
            </button>
          </form>
        </div>
      )}

      {/* Tenant list */}
      {loading ? (
        <p className="text-[var(--text-muted)]">Loading…</p>
      ) : error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : tenants.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
          <p className="text-[var(--text-muted)]">No tenants yet. Create your first business!</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tenants.map((t) => (
            <Link
              key={t.id}
              href={`/admin/tenants/${t.id}`}
              className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 transition-colors hover:border-[var(--border-hover)]"
            >
              <div>
                <h3 className="font-medium text-[var(--text)]">{t.name}</h3>
                <p className="text-xs text-[var(--text-muted)]">
                  {t.slug} · {t.timezone}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${t.is_active ? 'bg-[var(--green)]' : 'bg-[var(--text-dim)]'}`}
                />
                <span className="text-sm text-[var(--text-dim)]">→</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
