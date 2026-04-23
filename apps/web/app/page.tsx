import type { HealthResponse } from '@fantom/shared'

async function getApiHealth(): Promise<{ healthy: boolean }> {
  const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
  try {
    const res = await fetch(`${apiUrl}/health`, {
      next: { revalidate: 30 },
    })
    if (!res.ok) return { healthy: false }
    const data = (await res.json()) as HealthResponse
    return { healthy: data.status === 'ok' }
  } catch {
    return { healthy: false }
  }
}

export default async function HomePage() {
  const { healthy } = await getApiHealth()

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-50">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-8 py-5">
        <span className="font-mono text-sm font-bold tracking-[0.25em] text-zinc-100">
          FANTOM
        </span>
        <nav className="flex items-center gap-6">
          <a
            href="https://github.com/jotonova/fantom"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
          >
            GitHub
          </a>
          <a href="/docs" className="text-sm text-zinc-400 transition-colors hover:text-zinc-100">
            Docs
          </a>
        </nav>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <div className="mx-auto max-w-3xl space-y-8">
          {/* API Status Badge */}
          <div className="flex justify-center">
            <div
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs font-medium ${
                healthy
                  ? 'border-emerald-800 bg-emerald-950 text-emerald-400'
                  : 'border-red-800 bg-red-950 text-red-400'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${healthy ? 'bg-emerald-400' : 'bg-red-400'}`}
                aria-hidden="true"
              />
              {healthy ? 'API healthy' : 'API unreachable'}
            </div>
          </div>

          {/* Headline */}
          <h1 className="text-6xl font-bold tracking-tight text-zinc-50 md:text-7xl">
            Video at{' '}
            <span className="bg-gradient-to-r from-violet-400 to-purple-600 bg-clip-text text-transparent">
              Scale
            </span>
          </h1>

          {/* Subline */}
          <p className="mx-auto max-w-xl text-xl text-zinc-400">
            The multi-tenant video automation platform.
          </p>

          {/* CTA */}
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <a
              href="https://github.com/jotonova/fantom"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-violet-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-500"
            >
              View on GitHub
            </a>
            <a
              href="/docs"
              className="rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
            >
              Read the docs
            </a>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 px-8 py-5 text-center">
        <p className="font-mono text-xs text-zinc-600">F1 — scaffold complete</p>
      </footer>
    </div>
  )
}
