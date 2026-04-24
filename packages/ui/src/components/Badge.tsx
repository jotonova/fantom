import * as React from 'react'
import { cn } from '../utils/cn'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'success' | 'warning' | 'neutral' | 'danger'
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'neutral', ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        {
          'border-emerald-800 bg-emerald-950 text-emerald-400': variant === 'success',
          'border-amber-800 bg-amber-950 text-amber-400': variant === 'warning',
          'border-fantom-steel-border bg-fantom-steel-lighter text-fantom-text-muted':
            variant === 'neutral',
          'border-red-800 bg-red-950 text-red-400': variant === 'danger',
        },
        className,
      )}
      {...props}
    />
  ),
)
Badge.displayName = 'Badge'
