/**
 * Privacy Policy content — shared between the standalone /privacy page
 * and the modal overlay rendered from the homepage.
 */
export function PrivacyContent() {
  return (
    <div className="space-y-4 text-[var(--text-muted)]">
      <p>
        <strong className="text-[var(--text)]">Effective date:</strong> February 10, 2026
      </p>
      <p>
        gomomo.ai (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) is committed to protecting your privacy.
        This policy explains what data we collect, why, and how you can control it.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">What we collect</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li><strong className="text-[var(--text)]">Email address</strong> — provided when you sign in, subscribe to our newsletter, or request a booking confirmation.</li>
        <li><strong className="text-[var(--text)]">Chat content</strong> — messages you exchange with our AI agent during a session.</li>
        <li><strong className="text-[var(--text)]">Booking details</strong> — appointment dates, times, and service preferences.</li>
        <li><strong className="text-[var(--text)]">Usage analytics</strong> — anonymous page-view and interaction data to help us improve the product (no third-party ad trackers).</li>
      </ul>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Why we collect it</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>To send booking confirmations, reminders, and updates.</li>
        <li>To improve the quality and accuracy of our AI agents.</li>
        <li>To send our newsletter — only if you opt in (see below).</li>
      </ul>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Data retention</h2>
      <p>
        We retain chat transcripts and booking data for up to <strong className="text-[var(--text)]">12 months</strong> after your last interaction,
        then automatically delete them. Account information (email) is kept until you request deletion.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Newsletter</h2>
      <p>
        If you opt in to our newsletter, we&apos;ll send occasional product updates and tips.
        Every email includes a one-click unsubscribe link. You can also email us at any time to opt out.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Requesting data deletion</h2>
      <p>
        You can request deletion of all data associated with your email at any time.
        Visit our{' '}
        <a href="/data-deletion" className="text-[var(--accent)] underline hover:text-[var(--accent-hover)]">
          data deletion page
        </a>{' '}
        or email{' '}
        <a href="mailto:privacy@gomomo.ai" className="text-[var(--accent)] underline hover:text-[var(--accent-hover)]">
          privacy@gomomo.ai
        </a>.
        We will process your request within 30 days.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Contact</h2>
      <p>
        General inquiries:{' '}
        <a href="mailto:hello@gomomo.ai" className="text-[var(--accent)] underline hover:text-[var(--accent-hover)]">
          hello@gomomo.ai
        </a>
      </p>
      <p>
        Privacy-specific questions:{' '}
        <a href="mailto:privacy@gomomo.ai" className="text-[var(--accent)] underline hover:text-[var(--accent-hover)]">
          privacy@gomomo.ai
        </a>
      </p>
    </div>
  );
}
