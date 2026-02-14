'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { adminFetch, API_BASE } from '@/lib/admin';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  slot_duration: number;
  business_hours: Record<string, { start: string; end: string } | null>;
  services: Array<{ name: string; duration: number; description?: string }>;
  service_description: string;
  google_calendar_id: string | null;
  is_active: boolean;
}

interface OnboardingStatus {
  ready_to_go_live: boolean;
  fully_configured: boolean;
  steps: Array<{ key: string; label: string; completed: boolean; required: boolean }>;
}

interface WidgetSnippet {
  booking_url: string;
  iframe_snippet: string;
  script_snippet: string;
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABELS: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney',
];

export default function TenantDetailPage() {
  const params = useParams();
  const router = useRouter();
  const tenantId = params?.id as string;

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [snippet, setSnippet] = useState<WidgetSnippet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Form state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [timezone, setTimezone] = useState('');
  const [slotDuration, setSlotDuration] = useState(30);
  const [serviceDescription, setServiceDescription] = useState('');
  const [businessHours, setBusinessHours] = useState<Record<string, { start: string; end: string } | null>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Snippet copy state
  const [copied, setCopied] = useState('');

  const loadTenant = useCallback(async () => {
    try {
      const [tenantRes, statusRes, snippetRes] = await Promise.all([
        adminFetch(`/api/admin/tenants/${tenantId}`),
        adminFetch(`/api/admin/tenants/${tenantId}/onboarding-status`),
        adminFetch(`/api/admin/tenants/${tenantId}/widget-snippet`),
      ]);

      if (!tenantRes.ok) {
        setError('Tenant not found.');
        return;
      }

      const t: Tenant = await tenantRes.json();
      setTenant(t);
      setName(t.name);
      setSlug(t.slug);
      setTimezone(t.timezone);
      setSlotDuration(t.slot_duration);
      setServiceDescription(t.service_description || '');
      setBusinessHours(t.business_hours || {});

      if (statusRes.ok) setStatus(await statusRes.json());
      if (snippetRes.ok) setSnippet(await snippetRes.json());
    } catch {
      setError('Failed to load tenant data.');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    loadTenant();
  }, [loadTenant]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg('');

    try {
      const res = await adminFetch(`/api/admin/tenants/${tenantId}/settings`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          slug,
          timezone,
          slot_duration: slotDuration,
          service_description: serviceDescription,
          business_hours: businessHours,
        }),
      });

      if (res.ok) {
        setSaveMsg('Settings saved!');
        loadTenant(); // Refresh onboarding status
        setTimeout(() => setSaveMsg(''), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveMsg(`Error: ${data.error || 'Failed to save.'}`);
      }
    } catch {
      setSaveMsg('Network error.');
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(day: string) {
    setBusinessHours((prev) => ({
      ...prev,
      [day]: prev[day] ? null : { start: '09:00', end: '17:00' },
    }));
  }

  function updateHours(day: string, field: 'start' | 'end', value: string) {
    setBusinessHours((prev) => ({
      ...prev,
      [day]: prev[day] ? { ...prev[day]!, [field]: value } : { start: '09:00', end: '17:00' },
    }));
  }

  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      // Fallback
      setCopied('');
    }
  }

  if (loading) {
    return <p className="text-[var(--text-muted)]">Loading…</p>;
  }

  if (error || !tenant) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
        <p className="text-sm text-red-400">{error || 'Tenant not found.'}</p>
        <Link href="/admin/tenants" className="mt-2 inline-block text-sm text-[var(--accent)]">
          ← Back to tenants
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link href="/admin/tenants" className="mb-1 inline-block text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
            ← Back
          </Link>
          <h1 className="text-2xl font-bold text-[var(--text)]">{tenant.name}</h1>
          <p className="text-sm text-[var(--text-muted)]">ID: {tenant.id}</p>
        </div>
      </div>

      {/* Onboarding checklist */}
      {status && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Setup Checklist</h2>
          <div className="space-y-2">
            {status.steps.map((step) => (
              <div key={step.key} className="flex items-center gap-3">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                  step.completed
                    ? 'bg-[var(--green-muted)] text-[var(--green)]'
                    : 'bg-[var(--bg-subtle)] text-[var(--text-dim)]'
                }`}>
                  {step.completed ? '✓' : '○'}
                </span>
                <span className={`text-sm ${step.completed ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
                  {step.label}
                  {!step.required && <span className="ml-1 text-xs text-[var(--text-dim)]">(optional)</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-[var(--border)] pt-4">
            {status.ready_to_go_live ? (
              <p className="text-sm font-medium text-[var(--green)]">
                ✅ Ready to go live! Share your booking link below.
              </p>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                Complete the required steps above to go live.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Settings form */}
      <form onSubmit={handleSave} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
        <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Business Settings</h2>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Name */}
          <div>
            <label htmlFor="name" className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
              Business Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </div>

          {/* Slug */}
          <div>
            <label htmlFor="slug" className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
              URL Slug
            </label>
            <input
              id="slug"
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </div>

          {/* Timezone */}
          <div>
            <label htmlFor="tz" className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
              Timezone
            </label>
            <select
              id="tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>

          {/* Duration */}
          <div>
            <label htmlFor="duration" className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
              Default Duration (minutes)
            </label>
            <input
              id="duration"
              type="number"
              min={5}
              max={480}
              value={slotDuration}
              onChange={(e) => setSlotDuration(Number(e.target.value))}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>

        {/* Service description */}
        <div className="mt-4">
          <label htmlFor="svc-desc" className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Service Description
          </label>
          <textarea
            id="svc-desc"
            value={serviceDescription}
            onChange={(e) => setServiceDescription(e.target.value)}
            rows={3}
            placeholder="Describe your business and the services you offer…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--text-dim)] outline-none focus:border-[var(--accent)]"
          />
        </div>

        {/* Business hours */}
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-medium text-[var(--text-muted)]">Operating Hours</h3>
          <div className="space-y-2">
            {DAYS.map((day) => {
              const hours = businessHours[day];
              const isOpen = hours !== null && hours !== undefined;
              return (
                <div key={day} className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => toggleDay(day)}
                    className={`w-10 shrink-0 text-xs font-medium ${isOpen ? 'text-[var(--accent)]' : 'text-[var(--text-dim)]'}`}
                  >
                    {DAY_LABELS[day]}
                  </button>
                  {isOpen ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        aria-label={`${DAY_LABELS[day]} open`}
                        value={hours?.start ?? '09:00'}
                        onChange={(e) => updateHours(day, 'start', e.target.value)}
                        className="rounded border border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                      />
                      <span className="text-xs text-[var(--text-dim)]">to</span>
                      <input
                        type="time"
                        aria-label={`${DAY_LABELS[day]} close`}
                        value={hours?.end ?? '17:00'}
                        onChange={(e) => updateHours(day, 'end', e.target.value)}
                        className="rounded border border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--text-dim)]">Closed</span>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleDay(day)}
                    className="text-xs text-[var(--text-dim)] hover:text-[var(--text)]"
                  >
                    {isOpen ? 'Close' : 'Open'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-6 flex items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          {saveMsg && (
            <span className={`text-sm ${saveMsg.startsWith('Error') ? 'text-red-400' : 'text-[var(--green)]'}`}>
              {saveMsg}
            </span>
          )}
        </div>
      </form>

      {/* Calendar connect */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
        <h2 className="mb-2 text-lg font-semibold text-[var(--text)]">Google Calendar</h2>
        {tenant.google_calendar_id ? (
          <div>
            <p className="text-sm text-[var(--green)]">✅ Connected</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Calendar ID: {tenant.google_calendar_id}
            </p>
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm text-[var(--text-muted)]">
              Connect your Google Calendar to enable real-time availability and sync appointments.
              Without it, the system uses built-in scheduling (database-only mode).
            </p>
            <button
              onClick={async () => {
                try {
                  const res = await adminFetch(`/api/tenants/${tenantId}/oauth/google`);
                  if (res.ok) {
                    const data = await res.json();
                    if (data.authorization_url && data.calendar_mode === 'real') {
                      window.open(data.authorization_url, '_blank');
                    } else {
                      setSaveMsg('Calendar is in mock mode. Set CALENDAR_MODE=real and configure Google OAuth to connect.');
                    }
                  } else {
                    setSaveMsg('Failed to get authorization URL. Check Google OAuth env vars.');
                  }
                } catch {
                  setSaveMsg('Network error reaching backend.');
                }
              }}
              className="rounded-lg border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-muted)]"
            >
              Connect Google Calendar
            </button>
            <p className="mt-2 text-xs text-[var(--text-dim)]">
              Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and CALENDAR_MODE=real in .env
            </p>
          </div>
        )}
      </div>

      {/* Widget snippet / Go Live */}
      {snippet && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <h2 className="mb-4 text-lg font-semibold text-[var(--text)]">Go Live — Booking Widget</h2>

          {/* Booking URL */}
          <div className="mb-4">
            <h3 className="mb-1 text-xs font-medium text-[var(--text-muted)]">Direct Booking URL</h3>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg bg-[var(--bg-subtle)] px-3 py-2 text-xs text-[var(--accent)]">
                {snippet.booking_url}
              </code>
              <button
                onClick={() => copyToClipboard(snippet.booking_url, 'url')}
                className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)] hover:border-[var(--border-hover)] hover:text-[var(--text)]"
              >
                {copied === 'url' ? '✓ Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Iframe embed */}
          <div className="mb-4">
            <h3 className="mb-1 text-xs font-medium text-[var(--text-muted)]">Embed (iframe)</h3>
            <pre className="overflow-x-auto rounded-lg bg-[var(--bg-subtle)] p-3 text-xs text-[var(--text-muted)]">
              {snippet.iframe_snippet}
            </pre>
            <button
              onClick={() => copyToClipboard(snippet.iframe_snippet, 'iframe')}
              className="mt-2 rounded-lg border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-muted)] hover:border-[var(--border-hover)] hover:text-[var(--text)]"
            >
              {copied === 'iframe' ? '✓ Copied!' : 'Copy Snippet'}
            </button>
          </div>

          {/* Script embed */}
          <div>
            <h3 className="mb-1 text-xs font-medium text-[var(--text-muted)]">
              Embed (script tag)
              <span className="ml-1 text-[var(--text-dim)]">— coming soon</span>
            </h3>
            <pre className="overflow-x-auto rounded-lg bg-[var(--bg-subtle)] p-3 text-xs text-[var(--text-muted)]">
              {snippet.script_snippet}
            </pre>
            <button
              onClick={() => copyToClipboard(snippet.script_snippet, 'script')}
              className="mt-2 rounded-lg border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-muted)] hover:border-[var(--border-hover)] hover:text-[var(--text)]"
            >
              {copied === 'script' ? '✓ Copied!' : 'Copy Snippet'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
