import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { DataDeletionContent } from '@/components/legal/DataDeletionContent';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Request Data Deletion — gomomo.ai',
  description: 'Request deletion of your personal data from gomomo.ai',
};

export default function DataDeletionPage() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-6 pt-32 pb-20">
        <h1 className="mb-6 text-3xl font-bold">Request Data Deletion</h1>
        <DataDeletionContent />
      </main>
      <Footer />
    </>
  );
}
