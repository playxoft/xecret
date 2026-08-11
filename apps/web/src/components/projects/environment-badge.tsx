import { Badge } from '@/components/ui';

/**
 * The marker that says "this is production".
 *
 * ── Why only production gets a badge ──
 * A badge on every environment is a badge on none: once `staging`, `qa` and
 * `dev` all carry a coloured chip, the eye stops reading them and production
 * stops standing out. The one thing this marker has to survive is a hurried
 * glance at 2am, so it is the only chip in the row.
 *
 * The `production` tone is the sole consumer of the `--production-*` tokens
 * anywhere in the application (see the reserved-colour block in `globals.css`).
 * It never relies on colour alone: the primitive adds uppercase letterforms and
 * the diagonal hazard hatching, so the distinction survives a greyscale
 * print-out, a failing external monitor, and every form of colour vision
 * deficiency.
 */
export function EnvironmentBadge({ isProduction }: { isProduction: boolean }) {
  if (!isProduction) return null;
  return <Badge tone="production">Production</Badge>;
}
