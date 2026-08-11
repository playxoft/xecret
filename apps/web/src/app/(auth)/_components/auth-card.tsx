import type { ReactNode } from 'react';

import { Card } from '@/components/ui';

export interface AuthCardProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** A sign-up/sign-in cross-link, shown outside the card. */
  footer?: ReactNode;
}

export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    <div className="flex flex-col gap-5">
      <Card className="px-6 py-7 sm:px-7">
        <div className="mb-6">
          <h1 className="text-fg text-xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="text-fg-muted mt-1.5 text-sm leading-6">{description}</p>
          ) : null}
        </div>
        {children}
      </Card>
      {footer ? <div className="text-fg-muted text-center text-sm">{footer}</div> : null}
    </div>
  );
}
