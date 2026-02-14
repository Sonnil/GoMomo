'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback, Suspense } from 'react';
import { ModalOverlay } from './ModalOverlay';
import { PrivacyContent } from './legal/PrivacyContent';
import { TermsContent } from './legal/TermsContent';
import { DataDeletionContent } from './legal/DataDeletionContent';

// ── Modal registry ──────────────────────────────────────────
type ModalKey = 'privacy' | 'terms' | 'data-deletion';

const LEGAL_MODALS: Record<string, { title: string; content: React.ReactNode }> = {
  privacy: { title: 'Privacy Policy', content: <PrivacyContent /> },
  terms: { title: 'Terms of Service', content: <TermsContent /> },
  'data-deletion': { title: 'Request Data Deletion', content: <DataDeletionContent /> },
};

// ── Inner component (uses useSearchParams) ──────────────────
function ModalContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const modal = searchParams.get('modal') as ModalKey | null;

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('modal');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, router, pathname]);

  if (!modal) return null;

  // ── Legal modals ──────────────────────────────────────────
  const legalEntry = LEGAL_MODALS[modal];
  if (legalEntry) {
    return (
      <ModalOverlay title={legalEntry.title} onClose={close}>
        {legalEntry.content}
      </ModalOverlay>
    );
  }

  // Unknown modal key — ignore
  return null;
}

// ── Exported provider (Suspense boundary for useSearchParams) ─
export function ModalProvider() {
  return (
    <Suspense fallback={null}>
      <ModalContent />
    </Suspense>
  );
}
