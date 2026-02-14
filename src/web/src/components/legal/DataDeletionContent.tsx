/**
 * Data Deletion content — shared between the standalone /data-deletion page
 * and the modal overlay rendered from the homepage.
 */
export function DataDeletionContent() {
  return (
    <div className="space-y-4 text-[var(--text-muted)]">
      <p>
        You can request the deletion of all personal data associated with your
        email address at any time.
      </p>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">What gets deleted</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>Your email address and account information</li>
        <li>Chat transcripts from your AI agent conversations</li>
        <li>Booking history and appointment records</li>
        <li>Newsletter subscription preferences</li>
      </ul>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">How it works</h2>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          Send an email to{' '}
          <a
            href="mailto:privacy@gomomo.ai?subject=Data%20deletion%20request"
            className="text-[var(--accent)] underline hover:text-[var(--accent-hover)]"
          >
            privacy@gomomo.ai
          </a>{' '}
          with the subject line &quot;Data deletion request&quot;.
        </li>
        <li>
          Include the email address you used with gomomo.ai (so we can locate your data).
        </li>
        <li>
          We&apos;ll send you a confirmation email within 48 hours acknowledging
          receipt.
        </li>
        <li>
          Your data will be permanently deleted within 30 days of confirmation.
          You&apos;ll receive a final email once the process is complete.
        </li>
      </ol>

      <h2 className="pt-4 text-xl font-semibold text-[var(--text)]">Important notes</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Deletion is permanent and cannot be undone. Any active bookings will
          be cancelled.
        </li>
        <li>
          We may retain minimal records required by law (e.g. transaction
          records) even after deletion.
        </li>
        <li>
          If you only want to unsubscribe from our newsletter, you can use the
          unsubscribe link in any email instead — no need to delete your data.
        </li>
      </ul>

      <div className="pt-8">
        <a
          href="mailto:privacy@gomomo.ai?subject=Data%20deletion%20request"
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--accent-hover)]"
        >
          Request deletion via email →
        </a>
        <p className="mt-3 text-xs text-[var(--text-dim)]">
          We&apos;re working on an automated self-service form. For now, email is
          the fastest way to reach us.
        </p>
      </div>
    </div>
  );
}
