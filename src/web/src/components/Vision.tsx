export function Vision() {
  return (
    <section className="border-t border-[var(--border)] py-20 md:py-28">
      <div className="mx-auto max-w-3xl px-6 text-center">
        {/* Heading */}
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-[var(--text-dim)]">
          Our vision
        </h2>
        <h3 className="mb-6 text-2xl font-bold md:text-3xl">
          Beyond the screen
        </h3>

        {/* Paragraph */}
        <p className="text-lg leading-relaxed text-[var(--text-muted)]">
          Today, gomomo agents live in chat windows and phone lines. Tomorrow,
          they&apos;ll step into the physical world — AI-powered kiosks in
          lobbies, voice assistants at reception desks, and autonomous service
          agents that greet, guide, and help customers face-to-face. We&apos;re
          building the bridge from software agent to physical presence.
        </p>
      </div>
    </section>
  );
}
