'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { getAdminKey, clearAdminKey } from '@/lib/admin';

// ── Navigation links ─────────────────────────────────────

const navItems = [
  { label: 'Tenants', href: '/admin/tenants' },
];

// ── Layout component ─────────────────────────────────────

export default function AdminLayout({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const key = getAdminKey();
    if (key) {
      setAuthed(true);
    }
    setChecking(false);
  }, []);

  // If on login page, don't require auth
  if (pathname === '/admin/login') {
    return <>{children}</>;
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)]">
        <p className="text-[var(--text-muted)]">Loading…</p>
      </div>
    );
  }

  if (!authed) {
    // Redirect to login
    if (typeof window !== 'undefined') {
      router.replace('/admin/login');
    }
    return null;
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Top nav */}
      <header className="border-b border-[var(--border)] bg-[var(--bg-subtle)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/admin/tenants" className="text-lg font-bold tracking-tight text-[var(--text)]">
            gomomo<span className="text-[var(--accent)]">.ai</span>
            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">Admin</span>
          </Link>

          <nav className="flex items-center gap-6">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`text-sm transition-colors ${
                  pathname?.startsWith(item.href)
                    ? 'text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {item.label}
              </Link>
            ))}
            <button
              onClick={() => {
                clearAdminKey();
                router.replace('/admin/login');
              }}
              className="text-sm text-[var(--text-dim)] transition-colors hover:text-red-400"
            >
              Logout
            </button>
          </nav>
        </div>
      </header>

      {/* Page content */}
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
