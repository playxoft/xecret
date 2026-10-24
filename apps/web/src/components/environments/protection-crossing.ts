import { isApiError } from '@/lib/api';
import { reasonPrefixOf, withoutReasonPrefix } from '@/components/plans/plan-copy';

/**
 * A production environment being linked to one that is not (P19 §1, review
 * round 1): made to inherit from it, or given a template that reads from it.
 *
 * ── Why the dashboard asks the server first ──
 * Such a link is a write path onto production for everybody who can write the
 * source — and who that is depends on roles, per-environment grants and write
 * tokens this screen does not hold. So every write is sent without the
 * confirmation first; a link that crosses is answered 409
 * `link_crosses_protection:`, in a sentence that names the source and the
 * people who could then change production's values, and that sentence is the
 * warning the person confirms against. Only then is the same write sent again
 * with `confirmCrossesProtection: true`.
 *
 * A link that does not cross never sees any of this: the first request is the
 * only one.
 */

/** The reason prefix the server marks the refusal with. Stable; clients branch on it. */
export const PROTECTION_CROSSING_REASON = 'link_crosses_protection';

/**
 * The consequence warning a refusal carries — the server's sentence, without
 * its prefix — or `null` when the error is anything else.
 */
export function protectionCrossingWarning(error: unknown): string | null {
  if (!isApiError(error) || error.code !== 'conflict') return null;
  if (reasonPrefixOf(error.message) !== PROTECTION_CROSSING_REASON) return null;
  return withoutReasonPrefix(error.message);
}
