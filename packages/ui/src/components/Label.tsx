import * as React from 'react'
import { cn } from '../utils/cn'

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn('block text-sm font-medium text-fantom-text-muted', className)}
    {...props}
  />
))
Label.displayName = 'Label'
