const steps = [
  {
    number: '01',
    title: 'Connect your calendar',
    description:
      'Link your Google Calendar in one click. gomomo reads your availability in real time — no manual sync needed.',
  },
  {
    number: '02',
    title: 'Embed the agent',
    description:
      'Drop a single script tag on your website. Your AI agent goes live instantly — chat, book, reschedule, cancel.',
  },
  {
    number: '03',
    title: 'Customers book themselves',
    description:
      'Visitors chat with your agent naturally. It checks availability, avoids conflicts, and confirms — in seconds.',
  },
];

export function HowItWorks() {
  return (
    <section className="border-t border-[var(--border)] py-20 md:py-28">
      <div className="mx-auto max-w-5xl px-6">
        {/* Heading */}
        <div className="mb-14 text-center">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-dim)]">
            How it works
          </h2>
          <h3 className="text-2xl font-bold md:text-3xl">
            Live in three steps
          </h3>
        </div>

        {/* Steps */}
        <div className="grid gap-8 md:grid-cols-3">
          {steps.map((step) => (
            <div
              key={step.number}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] p-6"
            >
              <div className="mb-4 text-3xl font-bold text-[var(--accent)]">
                {step.number}
              </div>
              <h4 className="mb-2 text-lg font-semibold">{step.title}</h4>
              <p className="text-sm leading-relaxed text-[var(--text-muted)]">
                {step.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
