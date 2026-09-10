'use client';

import type { AccessLevel } from '@xecret/core/authz';
import { cn } from '@/lib/cn';
import { ACCESS_LEVEL_LABELS } from './types';

/**
 * One scope's access level, as a single segmented capsule.
 *
 * The one control every screen that hands out access uses — the member access
 * panel, the project members dialog, and the invite dialog. Three of them, so
 * it lives here rather than beside whichever one happened to need it first: a
 * capsule in one place and a row of checkboxes in another are two different
 * vocabularies for the same decision, and the second one is always the one
 * somebody misreads.
 *
 * Three segments in one bubble, because the levels are one choice rather than
 * three switches. Every segment the level contains is lit — Admin lights all
 * three — and every segment stays clickable:
 *
 *  - clicking a different segment moves the level there (up or down), and
 *  - clicking the segment that *is* the level turns everything off at once.
 *    Un-choosing Admin never strands a leftover Read & write.
 *
 * `aria-pressed` on each segment says what is lit; the group carries the
 * scope's name so sixty rows of "Read" stay tellable apart.
 */

export const GRANTABLE_LEVELS: readonly AccessLevel[] = ['read', 'write', 'admin'];

/**
 * The levels a service token can hold, narrowest first.
 *
 * `admin` is deliberately absent: the authorization engine's service-token
 * allowlist tops out at `write`, so an admin token would carry a level nothing
 * can spend. See `serviceAccessSchema`. Here rather than beside either screen
 * that draws it, because the token list and the mint dialog disagreeing about
 * what a token may hold is exactly the drift one definition prevents.
 */
export const SERVICE_TOKEN_LEVELS: readonly AccessLevel[] = ['read', 'write'];

/** Cumulative order, for implication: everything below a level is contained in it. */
export const LEVEL_RANK: Readonly<Record<AccessLevel, number>> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

/** The segment styling, shared by the interactive capsule and the static one. */
function segmentClass(lit: boolean, size: 'sm' | 'md'): string {
  return cn(
    'border-line font-medium transition-colors [&:not(:first-child)]:border-l',
    size === 'sm' ? 'px-2.5 py-1 text-sm' : 'px-3.5 py-1.5 text-sm',
    lit ? 'bg-accent-tint text-accent-text' : 'bg-canvas-inset text-fg-muted',
  );
}

export interface LevelToggleProps {
  level: AccessLevel;
  disabled: boolean;
  /** Names the scope in the group label — "Acme Production", say. */
  scopeLabel: string;
  onSelect: (next: AccessLevel) => void;
  /** `sm` shrinks the capsule for dense rows; the hit targets stay tappable. */
  size?: 'sm' | 'md';
  /**
   * The levels this capsule offers, narrowest first.
   *
   * Defaults to all three. A service token passes `['read', 'write']`, because
   * `admin` is not a level a token can hold — the authorization engine's
   * service-token allowlist tops out at `write`, so an admin token would carry
   * a level nothing can spend. Offering a segment the server refuses is
   * showing a control that is really an error message.
   */
  levels?: readonly AccessLevel[];
  /**
   * Whether clicking the lit level clears the capsule back to `none`.
   *
   * Defaults to true — that is the control's clearing gesture everywhere a
   * level is optional. A caller for whom `none` is not a value passes `false`:
   * a service token with no level is not a credential, and a gesture whose
   * result the caller silently drops is a control that looks broken.
   */
  clearable?: boolean;
  className?: string;
}

export function LevelToggle({
  level,
  disabled,
  scopeLabel,
  onSelect,
  size = 'md',
  levels = GRANTABLE_LEVELS,
  clearable = true,
  className,
}: LevelToggleProps) {
  return (
    <span
      role="group"
      aria-label={`Access to ${scopeLabel}`}
      className={cn(
        'border-line inline-flex overflow-hidden rounded-full border',
        disabled && 'opacity-70',
        className,
      )}
    >
      {levels.map((segment) => {
        const lit = LEVEL_RANK[level] >= LEVEL_RANK[segment];
        // The lit segment is the clearing gesture, so where clearing is not
        // offered it is the one segment with nothing left to do.
        const inert = disabled || (segment === level && !clearable);

        return (
          <button
            key={segment}
            type="button"
            aria-pressed={lit}
            aria-label={`${ACCESS_LEVEL_LABELS[segment]} access to ${scopeLabel}`}
            disabled={inert}
            // The one rule of the control: clicking the current level clears
            // everything; clicking anything else *is* the new level.
            onClick={() => onSelect(segment === level && clearable ? 'none' : segment)}
            className={cn(
              segmentClass(lit, size),
              !inert && 'cursor-pointer',
              !inert && (lit ? 'hover:bg-accent-tint/70' : 'hover:bg-surface-hover hover:text-fg'),
            )}
          >
            {ACCESS_LEVEL_LABELS[segment]}
          </button>
        );
      })}
    </span>
  );
}

/**
 * The same capsule, read-only.
 *
 * For a level that is a *fact* rather than a setting — a service token's
 * scope, which is fixed at mint time and cannot be widened afterwards by
 * design. Rendered as spans rather than disabled buttons, because a disabled
 * button says "you could change this, but not now", and here there is nothing
 * to change: replacing a token's level means minting a new token.
 */
export function LevelPills({
  level,
  label,
  levels = GRANTABLE_LEVELS,
  size = 'sm',
  className,
}: {
  level: AccessLevel;
  /** Names what the level belongs to, for the group's accessible name. */
  label: string;
  levels?: readonly AccessLevel[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      role="group"
      aria-label={`${label}: ${ACCESS_LEVEL_LABELS[level]}`}
      className={cn('border-line inline-flex overflow-hidden rounded-full border', className)}
    >
      {levels.map((segment) => (
        <span
          key={segment}
          aria-hidden="true"
          className={segmentClass(LEVEL_RANK[level] >= LEVEL_RANK[segment], size)}
        >
          {ACCESS_LEVEL_LABELS[segment]}
        </span>
      ))}
    </span>
  );
}
