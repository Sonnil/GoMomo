'use client';

import { useChatPopup } from './ChatPopupContext';
import { HeroTypewriter } from './HeroTypewriter';
import { PulseCtaButton } from './PulseCtaButton';

export function Hero() {
  const { open } = useChatPopup();

  return (
    <section className="relative overflow-hidden pt-32 pb-20 md:pt-44 md:pb-28">
      {/* Animated gradient mesh background */}
      <div className="hero-mesh" aria-hidden="true" />

      <div className="relative z-10 mx-auto max-w-3xl px-6 text-center">
        {/* Badge */}
        <div className="hero-enter-badge mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-1.5 text-[10px] font-semibold tracking-widest text-[var(--text-muted)] uppercase">
          <span className="badge-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--green)]" />
          Early Access
        </div>

        {/* Headline + Subhead — typed sequentially on load */}
        <HeroTypewriter />

        {/* CTAs */}
        <div className="hero-enter-cta mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <PulseCtaButton onClick={open}>
            Try it live
          </PulseCtaButton>
          <a
            href="#pricing"
            className="rounded-lg border border-[var(--border)] px-6 py-3 text-sm font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text)]"
          >
            View pricing
          </a>
        </div>
      </div>
    </section>
  );
}
