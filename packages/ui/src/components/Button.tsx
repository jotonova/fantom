import * as React from 'react'
import { cn } from '../utils/cn'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center font-semibold rounded-fantom transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fantom-blue focus-visible:ring-offset-2 focus-visible:ring-offset-fantom-steel disabled:pointer-events-none disabled:opacity-40',
          {
            'bg-fantom-brand-gradient text-white shadow-sm hover:opacity-90 active:opacity-80':
              variant === 'primary',
            'bg-fantom-steel-lighter border border-fantom-steel-border text-fantom-text hover:border-fantom-blue/40 hover:text-white':
              variant === 'secondary',
            'text-fantom-text-muted hover:text-fantom-text hover:bg-fantom-steel-lighter':
              variant === 'ghost',
            'bg-red-600 text-white hover:bg-red-500 active:bg-red-700':
              variant === 'danger',
          },
          {
            'h-8 px-3 text-xs gap-1.5': size === 'sm',
            'h-10 px-4 text-sm gap-2': size === 'md',
            'h-12 px-6 text-base gap-2.5': size === 'lg',
          },
          className,
        )}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'
