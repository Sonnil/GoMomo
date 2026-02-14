import dynamic from 'next/dynamic';
import { Header } from '@/components/Header';
import { Hero } from '@/components/Hero';
import { LazySection } from '@/components/LazySection';

/* ── Below-the-fold sections: code-split via next/dynamic ── */
const LiveAgent = dynamic(
  () => import('@/components/LiveAgent').then((m) => m.LiveAgent),
);
const ProblemOutcome = dynamic(
  () => import('@/components/ProblemOutcome').then((m) => m.ProblemOutcome),
);
const HowItWorks = dynamic(
  () => import('@/components/HowItWorks').then((m) => m.HowItWorks),
);
const Pricing = dynamic(
  () => import('@/components/Pricing').then((m) => m.Pricing),
);
const Partners = dynamic(
  () => import('@/components/Partners').then((m) => m.Partners),
);
const Vision = dynamic(
  () => import('@/components/Vision').then((m) => m.Vision),
);
const Footer = dynamic(
  () => import('@/components/Footer').then((m) => m.Footer),
);

export default function HomePage() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <LazySection minHeight={600}>
          <LiveAgent />
        </LazySection>
        <LazySection minHeight={400}>
          <ProblemOutcome />
        </LazySection>
        <LazySection minHeight={400} id="how-it-works" className="scroll-mt-24">
          <HowItWorks />
        </LazySection>
        <LazySection minHeight={500} id="pricing" className="scroll-mt-24">
          <Pricing />
        </LazySection>
        <LazySection minHeight={400} id="partners" className="scroll-mt-24">
          <Partners />
        </LazySection>
        <LazySection minHeight={250}>
          <Vision />
        </LazySection>
      </main>
      <LazySection minHeight={80}>
        <Footer />
      </LazySection>
    </>
  );
}
