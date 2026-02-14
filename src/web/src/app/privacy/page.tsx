import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { PrivacyContent } from '@/components/legal/PrivacyContent';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — gomomo.ai',
  description: 'Privacy policy for gomomo.ai',
};

export default function PrivacyPage() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-6 pt-32 pb-20">
        <h1 className="mb-6 text-3xl font-bold">Privacy Policy</h1>
        <PrivacyContent />
      </main>
      <Footer />
    </>
  );
}
