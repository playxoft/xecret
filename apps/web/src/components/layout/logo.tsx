import { cn } from '@/lib/cn';

/**
 * The xecret mark.
 *
 * A rounded chip carrying an "x" whose anti-diagonal is cut away — the letter
 * is there, part of it is withheld. It reads at 16px, it survives a favicon,
 * and it is drawn in tokens so it flips with the theme without a second asset.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('size-6', className)}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="22" height="22" rx="6.5" fill="var(--accent)" />
      <path
        d="M7.6 7.6 16.4 16.4"
        stroke="var(--accent-fg)"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
      <path
        d="M16.4 7.6 13.7 10.3"
        stroke="var(--accent-fg)"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
      <path
        d="M10.3 13.7 7.6 16.4"
        stroke="var(--accent-fg)"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark className="size-6 shrink-0" />
      <span className="text-fg text-[0.9375rem] font-semibold tracking-tight">xecret</span>
    </span>
  );
}

/**
 * The attribution mark. Deliberately quiet: it belongs in a footer or the base
 * of a sign-in card, not competing with the product name.
 */
export function PlayxoftMark({ className }: { className?: string }) {
  return (
    <span className={cn('text-fg-subtle inline-flex items-center gap-1.5 text-xs', className)}>
      <span
        aria-hidden="true"
        className="bg-fg-subtle/40 inline-block h-3 w-px shrink-0 rotate-12 rounded-full"
      />
      Powered by <span className="text-fg-muted font-medium">Playxoft</span>
    </span>
  );
}
