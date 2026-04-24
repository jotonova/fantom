'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../src/lib/auth-store'
import type { HealthResponse } from '@fantom/shared'
import { Logo } from '@fantom/ui'
import { Badge } from '@fantom/ui'
import { Button } from '@fantom/ui'
import { Spinner } from '@fantom/ui'

// Health check runs client-side to avoid server→API coupling in F4
async function fetchApiHealth(): Promise<boolean> {
  const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
  try {
    const res = await fetch(`${apiUrl}/health`)
    if (!res.ok) return false
    const data = (await res.json()) as HealthResponse
    return data.status === 'ok'
  } catch {
    return false
  }
}

import { useState } from 'react'

export default function HomePage() {
  const { isAuthenticated, isLoading } = useAuth()
  const router = useRouter()
  const [healthy, setHealthy] = useState<boolean | null>(null)

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace('/dashboard')
    }
  }, [isAuthenticated, isLoading, router])

  useEffect(() => {
    fetchApiHealth().then(setHealthy)
  }, [])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-fantom-steel text-fantom-text">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-fantom-steel-border px-8 py-5">
        <Logo variant="wordmark" />
        <nav className="flex items-center gap-6">
          <a
            href="https://github.com/jotonova/fantom"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-fantom-text-muted transition-colors hover:text-fantom-text"
          >
            GitHub
          </a>
          <a
            href="/docs"
            className="text-sm text-fantom-text-muted transition-colors hover:text-fantom-text"
          >
            Docs
          </a>
          <Button size="sm" onClick={() => router.push('/login')}>
            Sign in
          </Button>
        </nav>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <div className="mx-auto max-w-3xl space-y-8">
          {/* API Status Badge */}
          <div className="flex justify-center">
            {healthy === null ? (
              <Spinner size="sm" />
            ) : (
              <Badge variant={healthy ? 'success' : 'danger'}>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${healthy ? 'bg-emerald-400' : 'bg-red-400'}`}
                  aria-hidden="true"
                />
                {healthy ? 'API healthy' : 'API unreachable'}
              </Badge>
            )}
          </div>

          {/* Headline */}
          <h1 className="text-6xl font-bold tracking-tight text-fantom-text md:text-7xl">
            Video at{' '}
            <span className="bg-fantom-brand-gradient bg-clip-text text-transparent">Scale</span>
          </h1>

          {/* Subline */}
          <p className="mx-auto max-w-xl text-xl text-fantom-text-muted">
            The multi-tenant video automation platform.
          </p>

          {/* CTAs */}
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Button size="lg" onClick={() => router.push('/login')}>
              Get started
            </Button>
            <a
              href="https://github.com/jotonova/fantom"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-12 items-center justify-center rounded-fantom border border-fantom-steel-border bg-fantom-steel-lighter px-6 text-base font-semibold text-fantom-text transition-colors hover:border-fantom-blue/40 hover:text-white"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-fantom-steel-border px-8 py-5 text-center">
        <p className="font-mono text-xs text-fantom-text-muted">F4 — authenticated shell</p>
      </footer>
    </div>
  )
}
