import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { TermsContent } from '@/components/legal/TermsContent';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service — gomomo.ai',
  description: 'Terms of service for gomomo.ai',
};

export default function TermsPage() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-6 pt-32 pb-20">
        <h1 className="mb-6 text-3xl font-bold">Terms of Service</h1>
        <TermsContent />
      </main>
      <Footer />
    </>
  );
}
