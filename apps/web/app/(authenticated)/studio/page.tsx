'use client'

import { useRouter } from 'next/navigation'

// ── Video-type card data ───────────────────────────────────────────────────────

interface VideoTypeCard {
  title: string
  description: string
  href: string | null
  icon: React.ReactNode
  available: boolean
}

function FilmIcon() {
  return (
    <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0118 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C6 8.496 6.504 9 7.125 9h9.75c.621 0 1.125-.504 1.125-1.125V5.625" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
    </svg>
  )
}

function GridIcon() {
  return (
    <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  )
}

// ── Studio landing page ────────────────────────────────────────────────────────

export default function StudioPage() {
  const router = useRouter()

  const cards: VideoTypeCard[] = [
    {
      title: 'Shorts',
      description: 'Vertical 9:16 · AI voiceover · Multi-modal clip generation',
      href: '/studio/shorts',
      icon: <FilmIcon />,
      available: true,
    },
    {
      title: 'Long-form',
      description: 'Full-length video production with chapter structure',
      href: null,
      icon: <PlayIcon />,
      available: false,
    },
    {
      title: 'Episodic',
      description: 'Serialized content with consistent branding across episodes',
      href: null,
      icon: <GridIcon />,
      available: false,
    },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-fantom-text">Fantom Studio</h1>
        <p className="mt-1 text-sm text-fantom-text-muted">Multi-modal AI video editor</p>
      </div>

      {/* Video type cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map((card) =>
          card.available ? (
            <button
              key={card.title}
              onClick={() => router.push(card.href!)}
              className="group flex flex-col gap-4 rounded-xl border border-fantom-steel-border bg-fantom-steel-lighter p-6 text-left transition-all hover:border-fantom-blue/50 hover:bg-fantom-steel hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-fantom-blue/10 text-fantom-blue transition-colors group-hover:bg-fantom-blue/20">
                {card.icon}
              </div>
              <div>
                <p className="font-semibold text-fantom-text">{card.title}</p>
                <p className="mt-1 text-sm text-fantom-text-muted">{card.description}</p>
              </div>
              <p className="mt-auto text-xs font-medium text-fantom-blue">
                Open →
              </p>
            </button>
          ) : (
            <div
              key={card.title}
              className="flex flex-col gap-4 rounded-xl border border-fantom-steel-border bg-fantom-steel-lighter/50 p-6 opacity-50"
              aria-disabled="true"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-fantom-steel text-fantom-text-muted">
                {card.icon}
              </div>
              <div>
                <p className="font-semibold text-fantom-text-muted">{card.title}</p>
                <p className="mt-1 text-sm text-fantom-text-muted">{card.description}</p>
              </div>
              <p className="mt-auto text-xs font-medium text-fantom-text-muted">Coming soon</p>
            </div>
          ),
        )}
      </div>
    </div>
  )
}
