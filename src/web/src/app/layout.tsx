import type { Metadata, Viewport } from 'next';
import { ModalProvider } from '@/components/ModalProvider';
import { ChatPopupProvider } from '@/components/ChatPopupContext';
import { ChatPopup } from '@/components/ChatPopup';
import { FloatingActions } from '@/components/FloatingActions';
import { ThemeProvider } from '@/components/ThemeProvider';
import { THEME_SCRIPT } from '@/lib/theme-script';
import './globals.css';

export const viewport: Viewport = {
  themeColor: '#6366f1',
};

export const metadata: Metadata = {
  title: 'gomomo.ai — AI agents that run your front desk',
  description:
    'gomomo helps businesses book, respond, and serve customers — automatically. Intelligent scheduling powered by AI.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'gomomo.ai',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
  },
  openGraph: {
    title: 'gomomo.ai — AI agents that run your front desk',
    description:
      'gomomo helps businesses book, respond, and serve customers — automatically.',
    type: 'website',
    url: 'https://gomomo.ai',
    siteName: 'gomomo.ai',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'gomomo.ai — AI agents that run your front desk',
    description:
      'gomomo helps businesses book, respond, and serve customers — automatically.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Prevent flash-of-wrong-theme — runs before first paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased">
        {/* Ambient gradient orbs — fixed behind all content */}
        <div className="page-bg" aria-hidden="true" />
        {/* Diagonal shimmer sweep — subtle glass sheen effect */}
        <div className="page-shimmer" aria-hidden="true" />
        {/* Flowing organic blob shapes — remove this div to revert */}
        <div className="page-blobs" aria-hidden="true">
          <div className="page-blob page-blob--1" />
          <div className="page-blob page-blob--2" />
          <div className="page-blob page-blob--3" />
          <div className="page-blob page-blob--4" />
        </div>
        <ThemeProvider>
          <ChatPopupProvider>
            {children}
            <ChatPopup />
            <FloatingActions />
          </ChatPopupProvider>
        </ThemeProvider>
        <ModalProvider />
      </body>
    </html>
  );
}
