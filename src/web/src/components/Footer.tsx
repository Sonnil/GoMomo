'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const footerLinks = [
  { label: 'Privacy Policy', href: '/privacy', modal: 'privacy' },
  { label: 'Terms of Service', href: '/terms', modal: 'terms' },
  { label: 'Data Deletion', href: '/data-deletion', modal: 'data-deletion' },
];

export function Footer() {
  const year = new Date().getFullYear();
  const pathname = usePathname();

  // On legal standalone pages, link normally. Elsewhere, open as modal.
  const isLegalPage = ['/privacy', '/terms', '/data-deletion'].includes(pathname);

  return (
    <footer className="border-t border-[var(--border)] bg-[var(--bg)]">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 py-10 sm:flex-row sm:justify-between">
        {/* Brand */}
        <div className="text-sm text-[var(--text-dim)]">
          © {year} gomomo.ai — All rights reserved.
        </div>

        {/* Links */}
        <nav className="flex gap-6">
          {footerLinks.map((link) =>
            isLegalPage ? (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-[var(--text-dim)] transition-colors hover:text-[var(--text-muted)]"
              >
                {link.label}
              </Link>
            ) : (
              <Link
                key={link.href}
                href={`?modal=${link.modal}`}
                scroll={false}
                className="text-sm text-[var(--text-dim)] transition-colors hover:text-[var(--text-muted)]"
              >
                {link.label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </footer>
  );
}
