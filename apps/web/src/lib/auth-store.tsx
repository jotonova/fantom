'use client'

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { apiFetch, clearTokens, setTokens, getAccessToken } from './api-client'

interface User {
  id: string
  email: string
  name: string | null
}

interface Tenant {
  id: string
  slug: string
  name: string
  role: string
}

interface AuthState {
  user: User | null
  tenant: Tenant | null
  isLoading: boolean
  isAuthenticated: boolean
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: User
  tenant: Tenant
}

interface MeResponse {
  user: User
  tenant: Tenant & { role: string }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    tenant: null,
    isLoading: true,
    isAuthenticated: false,
  })

  // On mount, try to restore session from a stored access token.
  useEffect(() => {
    const token = getAccessToken()
    if (!token) {
      setState((s) => ({ ...s, isLoading: false }))
      return
    }

    apiFetch<MeResponse>('/me')
      .then(({ user, tenant }) => {
        setState({ user, tenant, isLoading: false, isAuthenticated: true })
      })
      .catch(() => {
        clearTokens()
        setState({ user: null, tenant: null, isLoading: false, isAuthenticated: false })
      })
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    setTokens(data.accessToken, data.refreshToken)
    setState({ user: data.user, tenant: data.tenant, isLoading: false, isAuthenticated: true })
  }, [])

  const logout = useCallback(async () => {
    const { getRefreshToken } = await import('./api-client')
    const refreshToken = getRefreshToken()
    if (refreshToken) {
      try {
        await apiFetch('/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        })
      } catch {
        // proceed with local cleanup even if the API call fails
      }
    }
    clearTokens()
    setState({ user: null, tenant: null, isLoading: false, isAuthenticated: false })
  }, [])

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return ctx
}
