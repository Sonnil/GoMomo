'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

interface LazySectionProps {
  /** Content rendered once the section enters the viewport */
  children: ReactNode;
  /** Lightweight placeholder shown before the section is visible.
   *  Defaults to an empty div matching `minHeight`. */
  fallback?: ReactNode;
  /** Minimum height of the placeholder to prevent layout shift (default: 200px) */
  minHeight?: number;
  /** IntersectionObserver rootMargin — load slightly before visible (default: 200px) */
  rootMargin?: string;
  /** Extra className on the wrapper div */
  className?: string;
  /** HTML id — always present in the DOM so hash anchors work before content loads */
  id?: string;
}

/**
 * Viewport-gated section wrapper.
 *
 * Renders a lightweight placeholder until the section scrolls into
 * (or near) the viewport, then mounts the real children. Once mounted
 * the children stay mounted permanently — no unmounting on scroll-away.
 *
 * SSR: always renders the placeholder on the server. Hydration is safe
 * because the IntersectionObserver fires only on the client.
 *
 * prefers-reduced-motion: no animations involved — this is purely a
 * mount-timing optimisation.
 */
export function LazySection({
  children,
  fallback,
  minHeight = 200,
  rootMargin = '200px',
  className,
  id,
}: LazySectionProps) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // If IntersectionObserver isn't available (old browsers), mount immediately
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  if (visible) {
    return <div id={id} className={className}>{children}</div>;
  }

  return (
    <div ref={ref} id={id} className={className} style={{ minHeight }}>
      {fallback ?? null}
    </div>
  );
}
