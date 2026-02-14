'use client';

import Link from 'next/link';
import { useChatPopup } from './ChatPopupContext';
import { ThemeToggle } from './ThemeToggle';

const navLinks = [
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'Partners', href: '#partners' },
];

export function Header() {
  const { open } = useChatPopup();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur-lg">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        {/* Logo */}
        <Link href="/" className="text-lg font-bold tracking-tight text-[var(--text)]">
          gomomo<span className="text-[var(--accent)]">.ai</span>
        </Link>

        {/* Nav links — hidden on mobile, shown md+ */}
        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* CTA + Theme toggle */}
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <button
            onClick={open}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
          >
            Try it now
          </button>
        </div>
      </div>
    </header>
  );
}
