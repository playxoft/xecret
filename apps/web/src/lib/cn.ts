import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class names, with later Tailwind utilities winning over earlier
 * ones in the same group.
 *
 * `clsx` alone is not enough for a component library. `clsx('px-4', 'px-6')`
 * emits both classes and the winner is decided by their order in the compiled
 * stylesheet, not by the call site — so a caller passing `className="px-6"` to
 * override a component's `px-4` gets an unpredictable result. `twMerge` drops
 * the losing utility so the last one written always wins.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
