const problems = [
  { icon: '📞', text: 'Missed calls cost you $1,000+ per month in lost bookings' },
  { icon: '⏰', text: 'Staff spend hours on the phone instead of serving clients' },
  { icon: '😤', text: 'Customers abandon if they hit voicemail or wait on hold' },
  { icon: '📅', text: 'Double-bookings and no-shows wreck your schedule' },
];

const outcomes = [
  { icon: '✅', text: 'Every call answered, every chat replied — 24/7, instantly' },
  { icon: '🚀', text: 'Staff freed up to do what they were hired to do' },
  { icon: '💬', text: 'Customers book in under 60 seconds via chat or phone' },
  { icon: '🔒', text: 'Zero double-bookings, synced to your real calendar' },
];

export function ProblemOutcome() {
  return (
    <section className="border-t border-[var(--border)] py-20 md:py-28">
      <div className="mx-auto max-w-5xl px-6">
        <div className="grid gap-12 md:grid-cols-2 md:gap-16">
          {/* Problem */}
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-dim)]">
              The problem
            </h2>
            <h3 className="mb-8 text-2xl font-bold md:text-3xl">
              Your front desk can&apos;t keep up
            </h3>
            <ul className="space-y-5">
              {problems.map((item) => (
                <li key={item.text} className="flex items-start gap-3">
                  <span className="mt-0.5 text-lg">{item.icon}</span>
                  <span className="text-[var(--text-muted)]">{item.text}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Outcome */}
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--green)]">
              With gomomo
            </h2>
            <h3 className="mb-8 text-2xl font-bold md:text-3xl">
              An AI agent that never drops the ball
            </h3>
            <ul className="space-y-5">
              {outcomes.map((item) => (
                <li key={item.text} className="flex items-start gap-3">
                  <span className="mt-0.5 text-lg">{item.icon}</span>
                  <span className="text-[var(--text-muted)]">{item.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
