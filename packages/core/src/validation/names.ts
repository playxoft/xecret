/**
 * Bounds on the display names of the things a slug identifies.
 *
 * Distinct from `SLUG_MAX_LENGTH`, which bounds the machine-readable half. A
 * name is what a person reads; a slug is what a URL carries, and the two are
 * limited for different reasons — the slug by what fits a DNS-shaped label, the
 * name by what fits the place it is rendered.
 */

/**
 * How long an organisation name may be.
 *
 * Deliberately far shorter than the 100 characters a project or environment
 * name may run to, because an organisation name is rendered where there is
 * least room for it: the switcher in a 240px sidebar, above the viewer's role,
 * and again at the head of every breadcrumb trail. A name that only fits by
 * truncating is a name nobody can tell apart from the other truncated one —
 * which, in a product where picking the wrong tenant means writing a secret
 * into the wrong company's vault, is a legibility problem with teeth.
 *
 * Lives in `@xecret/core` rather than beside the route schemas because both
 * sides need it and they must not disagree: the browser uses it to cap the
 * input and count what is left, and the API uses it to decide what it will
 * store. A client limit the server does not share is a suggestion; a server
 * limit the client does not share is a form that submits rejected requests.
 */
export const ORGANIZATION_NAME_MAX_LENGTH = 25;

/**
 * Shortens a name to fit, cutting at a word boundary where there is one.
 *
 * Used only where the product *invents* a name rather than being given one —
 * the organisation created at first sign-in, which is named after the display
 * name the identity provider supplied. Those arrive at whatever length the
 * provider felt like, and a sign-up that failed because somebody's Google
 * profile is long would be an unrecoverable first impression.
 *
 * Never used on a name a person typed. Silently shortening that would store
 * something other than what they asked for; the form refuses instead, which
 * they can see and act on.
 */
export function truncateName(name: string, maxLength: number): string {
  const trimmed = name.trim();
  if (trimmed.length <= maxLength) return trimmed;

  const cut = trimmed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');

  // Only honour a word boundary that leaves something substantial behind —
  // otherwise "Extraordinarily Long" would become "E", which is worse than a
  // mid-word cut.
  if (lastSpace >= Math.floor(maxLength / 2)) return cut.slice(0, lastSpace).trimEnd();
  return cut.trimEnd();
}
