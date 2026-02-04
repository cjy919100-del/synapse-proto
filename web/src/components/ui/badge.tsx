import * as React from 'react';

import { cn } from '../../lib/utils';

type BadgeVariant = 'default' | 'secondary' | 'accent' | 'destructive' | 'outline';

const variantClass: Record<BadgeVariant, string> = {
  default: 'bg-primary text-primary-foreground border-transparent',
  secondary: 'bg-secondary text-secondary-foreground border-transparent',
  accent: 'bg-accent text-accent-foreground border-transparent',
  destructive: 'bg-destructive text-destructive-foreground border-transparent',
  outline: 'bg-transparent text-foreground border-border',
};

export type BadgeProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: BadgeVariant;
};

export function Badge({ className, variant = 'outline', ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold font-mono tracking-tight',
        'shadow-sm bg-card/40',
        variantClass[variant],
        className,
      )}
      {...props}
    />
  );
}
