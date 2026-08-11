import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { AlertCircleIcon, AlertTriangleIcon, CheckCircleIcon, InfoIcon } from './icons';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<AlertTone, { box: string; icon: string; Icon: typeof InfoIcon }> = {
  info: { box: 'border-line bg-canvas-inset', icon: 'text-fg-muted', Icon: InfoIcon },
  success: {
    box: 'border-success-line bg-success-tint',
    icon: 'text-success-text',
    Icon: CheckCircleIcon,
  },
  warning: {
    box: 'border-warning-line bg-warning-tint',
    icon: 'text-warning-text',
    Icon: AlertTriangleIcon,
  },
  danger: {
    box: 'border-danger-line bg-danger-tint',
    icon: 'text-danger-text',
    Icon: AlertCircleIcon,
  },
};

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
}

/**
 * An inline message attached to the content it concerns.
 *
 * `role="alert"` is reserved for the danger tone. It interrupts whatever a
 * screen reader is currently saying, which is right for "this action failed"
 * and wrong for "your changes are saved" — overusing it trains people to
 * ignore it. Everything else uses the polite `role="status"`.
 *
 * Each tone also carries its own icon, so the four are distinguishable without
 * relying on the border colour.
 */
export function Alert({ className, tone = 'info', title, children, ...props }: AlertProps) {
  const { box, icon, Icon } = TONES[tone];

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-3.5 py-3 text-sm', box, className)}
      {...props}
    >
      <Icon className={cn('mt-px size-[1.15em] shrink-0', icon)} />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="text-fg leading-5 font-medium">{title}</p> : null}
        {children ? <div className="text-fg-muted leading-5">{children}</div> : null}
      </div>
    </div>
  );
}
