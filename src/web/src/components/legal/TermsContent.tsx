/**
 * Terms of Service content — shared between the standalone /terms page
 * and the modal overlay rendered from the homepage.
 */
export function TermsContent() {
  return (
    <div className="space-y-4 text-[var(--text-muted)]">
      <p>
        <strong className="text-[var(--text)]">Effective date:</strong> February 10, 2026
      </p>
      <p>
        Welcome to gomomo.ai. By using our services, you agree to these terms.
        Please read them carefully.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Service description</h2>
      <p>
        gomomo.ai provides AI-powered scheduling and customer service agents
        for businesses. Our agents help book, reschedule, and manage appointments
        on behalf of your business.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Service provided &quot;as is&quot;</h2>
      <p>
        Our service is provided on an &quot;as is&quot; and &quot;as available&quot; basis without
        warranties of any kind, whether express or implied. We do not guarantee
        that the service will be uninterrupted, error-free, or available at all times.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Acceptable use</h2>
      <p>You agree not to:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Attempt to reverse-engineer, decompile, or extract the AI models.</li>
        <li>Use the platform for any illegal or harmful purpose.</li>
        <li>Send automated traffic designed to overload or disrupt the service.</li>
        <li>Impersonate another person or misrepresent your affiliation.</li>
      </ul>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Availability</h2>
      <p>
        We aim for high availability but do not guarantee uptime. Scheduled
        maintenance and unforeseen outages may occur. We are not liable for
        any losses resulting from service downtime.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, gomomo.ai and its team shall not
        be liable for any indirect, incidental, special, or consequential damages
        arising from your use of the service. Our total liability is limited to the
        amount you paid us in the 12 months preceding the claim, or $100, whichever is greater.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">AI limitations</h2>
      <p>
        Our AI agents are designed to assist with scheduling and customer interactions
        but may occasionally produce incorrect or unexpected responses. AI-generated
        outputs should not be treated as professional, legal, or medical advice.
        You are responsible for reviewing any bookings or actions taken on your behalf.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Changes to these terms</h2>
      <p>
        We may update these terms from time to time. When we do, we will revise the
        effective date at the top of this page. Continued use of the service after
        changes constitutes acceptance of the updated terms.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Contact</h2>
      <p>
        Questions about these terms? Reach us at{' '}
        <a href="mailto:legal@gomomo.ai" className="text-[var(--accent)] underline hover:text-[var(--accent-hover)]">
          legal@gomomo.ai
        </a>.
      </p>
    </div>
  );
}
