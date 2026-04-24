'use client'

import { useAuth } from '../../../src/lib/auth-store'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@fantom/ui'
import { Badge } from '@fantom/ui'

export default function DashboardPage() {
  const { user, tenant } = useAuth()

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-semibold text-fantom-text">Dashboard</h1>
        <p className="mt-1 text-sm text-fantom-text-muted">
          Welcome back{user?.name ? `, ${user.name}` : ''}.
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Workspace</CardDescription>
            <CardTitle>{tenant?.name ?? '—'}</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="success">Active</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Jobs</CardDescription>
            <CardTitle>0</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-fantom-text-muted">No jobs yet</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Assets</CardDescription>
            <CardTitle>0</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-fantom-text-muted">No assets yet</p>
          </CardContent>
        </Card>
      </div>

      {/* Phase note */}
      <Card>
        <CardHeader>
          <CardTitle>F4 — Authenticated Shell</CardTitle>
          <CardDescription>
            Brand kit, @fantom/ui component library, and protected routes are live.
            Jobs and asset upload arrive in F5.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Badge variant="success">Auth</Badge>
            <Badge variant="success">Multi-tenant</Badge>
            <Badge variant="success">RLS</Badge>
            <Badge variant="neutral">Jobs (F5)</Badge>
            <Badge variant="neutral">Assets (F5)</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
