const tiers = [
  {
    name: 'Free',
    price: '$0',
    period: '/mo',
    description: 'For solo operators getting started',
    features: [
      'Web chat agent',
      '50 conversations / month',
      '1 calendar connection',
      'gomomo.ai branding',
    ],
    cta: 'Start free',
    featured: false,
  },
  {
    name: 'Professional',
    price: '$49',
    period: '/mo',
    description: 'For growing businesses',
    features: [
      'Unlimited conversations',
      '3 calendar connections',
      'SMS & voice add-ons',
      'Remove branding',
      'Priority support',
    ],
    cta: 'Start trial',
    featured: true,
  },
  {
    name: 'Business',
    price: '$149',
    period: '/mo',
    description: 'For multi-location teams',
    features: [
      'Everything in Professional',
      'Unlimited calendars',
      'Multi-tenant dashboard',
      'Custom integrations',
      'Dedicated account manager',
    ],
    cta: 'Start trial',
    featured: false,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'For organizations with specific needs',
    features: [
      'Everything in Business',
      'On-premise deployment',
      'SLA guarantee',
      'HIPAA-ready config',
      'White-label options',
    ],
    cta: 'Contact sales',
    featured: false,
  },
];

export function Pricing() {
  return (
    <section className="border-t border-[var(--border)] py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        {/* Heading */}
        <div className="mb-14 text-center">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-dim)]">
            Pricing
          </h2>
          <h3 className="mb-3 text-2xl font-bold md:text-3xl">
            Simple, transparent pricing
          </h3>
          <p className="text-[var(--text-muted)]">
            Start free. Upgrade when you&apos;re ready.
          </p>
        </div>

        {/* Cards */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`pricing-card flex flex-col rounded-xl border bg-[var(--bg-card)] p-6 ${
                tier.featured
                  ? 'featured'
                  : 'border-[var(--border)]'
              }`}
            >
              {tier.featured && (
                <div className="mb-4 inline-flex self-start rounded-full bg-[var(--accent-muted)] px-3 py-1 text-xs font-medium text-[var(--accent-hover)]">
                  Most popular
                </div>
              )}
              <h4 className="text-lg font-semibold">{tier.name}</h4>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-bold">{tier.price}</span>
                {tier.period && (
                  <span className="text-sm text-[var(--text-dim)]">{tier.period}</span>
                )}
              </div>
              <p className="mt-2 text-sm text-[var(--text-muted)]">
                {tier.description}
              </p>
              <ul className="mt-6 flex-1 space-y-3">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-[var(--text-muted)]">
                    <span className="mt-0.5 text-[var(--green)]">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <button
                className={`mt-6 w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
                  tier.featured
                    ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                    : 'border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-hover)] hover:text-[var(--text)]'
                }`}
              >
                {tier.cta}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
