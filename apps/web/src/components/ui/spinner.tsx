import { cn } from '@/lib/cn';

export interface SpinnerProps {
  className?: string;
  /**
   * Announced to screen readers. Pass `null` when the spinner sits inside a
   * control that already announces its own busy state (a `<Button loading>`
   * sets `aria-busy`), so the change is not read out twice.
   */
  label?: string | null;
}

export function Spinner({ className, label = 'Loading' }: SpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      // `data-motion="essential"` exempts this from the reduced-motion kill
      // switch in globals.css. A spinner that has stopped spinning is telling
      // the user the app has hung; it slows to 2.4s instead.
      data-motion="essential"
      className={cn('animate-spin', className)}
      role={label === null ? 'presentation' : 'status'}
      aria-hidden={label === null ? true : undefined}
      aria-label={label ?? undefined}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
