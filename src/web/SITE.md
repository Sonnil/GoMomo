# gomomo.ai Marketing Site

## Tech Stack

| Layer      | Tool                    |
|------------|-------------------------|
| Framework  | Next.js 15 (App Router) |
| React      | 19                      |
| CSS        | Tailwind CSS 4          |
| TypeScript | 5.7                     |
| Dev port   | 3001                    |

## Route Map

| Route      | File                            | Purpose                   | Render |
|------------|---------------------------------|---------------------------|--------|
| `/`        | `src/app/page.tsx`              | Landing page (all sections) | Static |
| `/privacy` | `src/app/privacy/page.tsx`      | Privacy policy              | Static |
| `/terms`   | `src/app/terms/page.tsx`        | Terms of service            | Static |

## Section Composition (`page.tsx`)

```
Header        — Fixed nav, logo, CTA
Hero          — Headline, subhead, dual CTAs
ProblemOutcome — 4 problems vs 4 outcomes
HowItWorks   — 3-step connect → embed → book
LiveAgent     — Embedded chat widget (iframe)
Pricing       — 4 tiers (Free / Professional / Business / Enterprise)
Partners      — 3 tracks (Advertise / Integrate / Resell)
Vision        — Physical AI future
Footer        — Copyright, Privacy, Terms
```

## Anchor Links

| ID              | Target Section  |
|-----------------|-----------------|
| `#how-it-works` | HowItWorks      |
| `#try-it`       | LiveAgent       |
| `#pricing`      | Pricing         |
| `#partners`     | Partners        |

## SEO Metadata (`layout.tsx`)

| Field            | Value |
|------------------|-------|
| `title`          | gomomo.ai — AI agents that run your front desk |
| `description`    | gomomo helps service businesses book, respond, and serve customers — automatically. Web chat, SMS, voice, and Google Calendar in one agent. |
| `og:title`       | gomomo.ai — AI agents that run your front desk |
| `og:description` | AI agents that book, respond, and serve — so your team doesn't have to. |
| `og:type`        | website |
| `og:url`         | https://gomomo.ai |
| `twitter:card`   | summary_large_image |

## Environment Variables

| Variable                  | Default                  | Purpose                |
|---------------------------|--------------------------|------------------------|
| `NEXT_PUBLIC_WIDGET_URL`  | `http://localhost:5173`  | Chat widget iframe src |

## Design System (CSS Variables — `globals.css`)

```
--bg:           #09090b     (zinc-950)
--bg-card:      #18181b     (zinc-900)
--bg-subtle:    #1c1c20
--accent:       #6366f1     (indigo-500)
--accent-hover: #818cf8     (indigo-400)
--accent-muted: rgba(99,102,241,0.15)
--green:        #22c55e     (green-500)
--text:         #fafafa
--text-muted:   #a1a1aa     (zinc-400)
--text-dim:     #52525b     (zinc-600)
--border:       #27272a     (zinc-800)
--border-hover: #3f3f46     (zinc-700)
```

## Manual Test Checklist

### Smoke (every deploy)
- [ ] `npm run build` succeeds with zero errors
- [ ] `/` renders — all 9 sections visible on scroll
- [ ] `/privacy` and `/terms` render without 404
- [ ] Header logo links to `/`
- [ ] "Try it now →" CTA scrolls to `#try-it`
- [ ] "See pricing" CTA scrolls to `#pricing`
- [ ] Nav links scroll to correct sections
- [ ] Pricing "Most popular" badge appears on Professional tier

### Live Agent
- [ ] Widget iframe loads when backend + frontend are running
- [ ] Chat interaction works inside the embedded widget
- [ ] `NEXT_PUBLIC_WIDGET_URL` override works

### Responsive (check at 375px, 768px, 1280px)
- [ ] Hero text doesn't overflow at 375px
- [ ] Pricing cards stack 1-col on mobile, 2-col on tablet, 4-col on desktop
- [ ] Partner cards stack 1-col on mobile, 3-col on desktop
- [ ] HowItWorks steps stack vertically on mobile
- [ ] Header nav hidden on mobile (md: breakpoint)
- [ ] Footer wraps to column layout on small screens

### SEO
- [ ] `<title>` tag matches metadata
- [ ] OG tags present in page source
- [ ] `<html lang="en">` is set
- [ ] Dark theme class applied to `<html>`

### Accessibility
- [ ] All sections have heading hierarchy (h2 → h3)
- [ ] Iframe has `title` attribute
- [ ] Links have visible focus states
- [ ] Color contrast passes on text-muted over bg (WCAG AA)
