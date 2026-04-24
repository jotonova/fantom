'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '../../src/lib/auth-store'
import { Logo } from '@fantom/ui'
import { Avatar } from '@fantom/ui'
import { Spinner } from '@fantom/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@fantom/ui'

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Library', href: '/library' },
  { label: 'Voices', href: '/voices' },
]

export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const { user, tenant, isAuthenticated, isLoading, logout } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/login')
    }
  }, [isAuthenticated, isLoading, router])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-fantom-steel">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return null
  }

  async function handleLogout() {
    await logout()
    router.replace('/login')
  }

  const displayName = user?.name ?? user?.email ?? 'User'
  const tenantName = tenant?.name ?? tenant?.slug ?? 'Workspace'

  return (
    <div className="flex min-h-screen bg-fantom-steel">
      {/* Sidebar */}
      <aside className="flex w-56 flex-col border-r border-fantom-steel-border bg-fantom-steel-lighter">
        {/* Logo area */}
        <div className="flex h-14 items-center border-b border-fantom-steel-border px-5">
          <Logo variant="wordmark" />
        </div>

        {/* Tenant badge */}
        <div className="px-4 py-3">
          <p className="truncate text-xs font-medium text-fantom-text-muted">{tenantName}</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-0.5 px-2 py-2" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <a
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center rounded-[6px] px-3 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-fantom-steel text-fantom-text'
                    : 'text-fantom-text-muted hover:bg-fantom-steel hover:text-fantom-text'
                }`}
              >
                {item.label}
              </a>
            )
          })}
        </nav>
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <header className="flex h-14 items-center justify-end border-b border-fantom-steel-border px-6">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2.5 rounded-fantom p-1 transition-colors hover:bg-fantom-steel-lighter focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue"
                aria-label="User menu"
              >
                <Avatar fallback={displayName} size="sm" />
                <span className="max-w-[140px] truncate text-sm text-fantom-text-muted">
                  {displayName}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{displayName}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleLogout}
                className="text-red-400 hover:text-red-300 focus:text-red-300"
              >
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-8">{children}</main>
      </div>
    </div>
  )
}
