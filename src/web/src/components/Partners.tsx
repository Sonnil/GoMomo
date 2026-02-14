const partnerTypes = [
  {
    icon: '📢',
    title: 'Advertise with us',
    description:
      'Reach thousands of service businesses actively looking for scheduling solutions. Premium placements available.',
    cta: 'Learn more →',
    href: 'mailto:partners@gomomo.ai?subject=Advertising%20inquiry',
  },
  {
    icon: '🔗',
    title: 'Integrate',
    description:
      'Build on top of gomomo. Our API lets you embed intelligent scheduling into your own product — POS, CRM, or marketplace.',
    cta: 'View API docs →',
    href: 'mailto:partners@gomomo.ai?subject=API%20integration%20inquiry',
  },
  {
    icon: '🤝',
    title: 'Resell',
    description:
      'White-label gomomo for your clients. Agencies, consultants, and SaaS builders earn recurring revenue per seat.',
    cta: 'Partner program →',
    href: 'mailto:partners@gomomo.ai?subject=Reseller%20program%20inquiry',
  },
];

export function Partners() {
  return (
    <section className="border-t border-[var(--border)] py-20 md:py-28">
      <div className="mx-auto max-w-5xl px-6">
        {/* Heading */}
        <div className="mb-14 text-center">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-dim)]">
            Partners
          </h2>
          <h3 className="mb-3 text-2xl font-bold md:text-3xl">
            Grow with gomomo
          </h3>
          <p className="text-[var(--text-muted)]">
            Whether you want to advertise, integrate, or resell — we&apos;re building an open ecosystem.
          </p>
        </div>

        {/* Cards */}
        <div className="grid gap-8 md:grid-cols-3">
          {partnerTypes.map((partner) => (
            <div
              key={partner.title}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] p-6 transition-colors hover:border-[var(--border-hover)]"
            >
              <div className="mb-4 text-3xl">{partner.icon}</div>
              <h4 className="mb-2 text-lg font-semibold">{partner.title}</h4>
              <p className="mb-4 text-sm leading-relaxed text-[var(--text-muted)]">
                {partner.description}
              </p>
              <a
                href={partner.href}
                className="text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]"
              >
                {partner.cta}
              </a>
            </div>
          ))}
        </div>

        {/* General contact CTA */}
        <div className="mt-14 text-center">
          <p className="mb-4 text-[var(--text-muted)]">
            Have something else in mind?
          </p>
          <a
            href="mailto:hello@gomomo.ai"
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--accent-hover)]"
          >
            Get in touch →
          </a>
        </div>
      </div>
    </section>
  );
}
