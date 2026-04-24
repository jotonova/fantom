import * as React from 'react'
import { cn } from '../utils/cn'

export interface LogoProps {
  variant?: 'wordmark' | 'mark'
  className?: string
}

export function Logo({ variant = 'wordmark', className }: LogoProps) {
  if (variant === 'mark') {
    return (
      <svg
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Fantom"
        className={cn('h-8 w-8', className)}
      >
        <rect width="32" height="32" rx="8" fill="url(#logo-gradient)" />
        <path
          d="M8 10h10v3H11v3h6v3h-6v6H8V10z"
          fill="white"
        />
        <path
          d="M20 10h4v15h-4V10z"
          fill="white"
          opacity="0.5"
        />
        <defs>
          <linearGradient id="logo-gradient" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop stopColor="#1E3A5F" />
            <stop offset="1" stopColor="#0D1B2A" />
          </linearGradient>
        </defs>
      </svg>
    )
  }

  return (
    <span
      className={cn(
        'font-mono text-sm font-bold tracking-[0.25em] text-fantom-text',
        className,
      )}
      aria-label="Fantom"
    >
      FANTOM
    </span>
  )
}
