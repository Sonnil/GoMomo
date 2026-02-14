'use client';

/**
 * PulseCtaButton — premium play-icon CTA inspired by the Appku "Watch Promo"
 * pattern: circular icon chip with expanding pulse ring + pill label.
 *
 * Usage:
 *   <PulseCtaButton onClick={open}>Try it live</PulseCtaButton>
 */

import type { ReactNode, ButtonHTMLAttributes } from 'react';

interface PulseCtaButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

export function PulseCtaButton({
  children,
  className = '',
  ...rest
}: PulseCtaButtonProps) {
  return (
    <button
      className={`pulse-cta ${className}`}
      {...rest}
    >
      {/* Icon chip with pulse ring */}
      <span className="pulse-cta__chip" aria-hidden="true">
        {/* Expanding ring (behind the chip) */}
        <span className="pulse-cta__ring" />

        {/* Play triangle */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="pulse-cta__icon"
        >
          <path
            d="M3.5 1.75L11.5 7L3.5 12.25V1.75Z"
            fill="currentColor"
          />
        </svg>
      </span>

      {/* Label */}
      <span className="pulse-cta__label">{children}</span>

      {/* Subtle trailing arrow */}
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="pulse-cta__arrow"
        aria-hidden="true"
      >
        <path
          d="M6 4L10 8L6 12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
