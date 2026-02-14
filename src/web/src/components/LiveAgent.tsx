'use client';

import Image from 'next/image';
import { useChatPopup } from './ChatPopupContext';

const screenshots = [
  {
    src: '/screenshots/screenshot-booking.svg',
    alt: 'gomomo agent booking an appointment in under 30 seconds',
    caption: 'Book in under 30 seconds',
  },
  {
    src: '/screenshots/screenshot-verification.svg',
    alt: 'Email verification protecting the booking flow',
    caption: 'Email-verified security',
  },
  {
    src: '/screenshots/screenshot-cancellation.svg',
    alt: 'Secure cancellation with identity verification',
    caption: 'Secure cancellation',
  },
];

export function LiveAgent() {
  const { open } = useChatPopup();

  return (
    <section id="try-it" className="border-t border-[var(--border)] py-20 md:py-28">
      <div className="mx-auto max-w-5xl px-6">
        {/* Heading */}
        <div className="mb-12 text-center">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--green)]">
            Live demo
          </h2>
          <h3 className="mb-3 text-2xl font-bold md:text-3xl">
            See gomomo in action
          </h3>
          <p className="mx-auto max-w-lg text-[var(--text-muted)]">
            Your customers book, verify, and manage appointments in a single
            chat — no phone tag, no waiting. Click below to try it yourself.
          </p>
        </div>

        {/* Screenshot gallery */}
        <div className="mx-auto mb-12 grid grid-cols-1 gap-6 sm:grid-cols-3 sm:gap-8">
          {screenshots.map((shot) => (
            <div key={shot.src} className="flex flex-col items-center">
              <div className="widget-frame overflow-hidden rounded-2xl">
                <Image
                  src={shot.src}
                  alt={shot.alt}
                  width={390}
                  height={560}
                  className="h-auto w-full"
                  loading="lazy"
                />
              </div>
              <p className="mt-3 text-center text-sm font-medium text-[var(--text-muted)]">
                {shot.caption}
              </p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="text-center">
          <button
            onClick={open}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-8 py-3.5 text-base font-semibold text-white shadow-lg shadow-[var(--accent)]/20 transition-all hover:bg-[var(--accent-hover)] hover:shadow-[var(--accent)]/30"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2z" />
            </svg>
            Launch live demo
          </button>
          <p className="mt-3 text-xs text-[var(--text-dim)]">
            Opens the real AI agent — not a recording.
          </p>
        </div>
      </div>
    </section>
  );
}
