/**
 * The contact form's field bounds, shared by the schema and the form.
 *
 * ── Why this is not in `server/schemas/contact.ts` with the schema ──
 * The form needs these for its `maxLength` attributes, and the form is a client
 * component. Importing them from the schema module would pull `zod/mini` into
 * the bundle of a public marketing page — the same class of mistake the pricing
 * page's header warns about with the `components/ui` barrel. Constants have no
 * dependencies; the schema that validates against them does.
 *
 * The bound is stated once and read twice: the browser stops typing past it, and
 * the server refuses a body that got past the browser. Neither is decoration —
 * `maxLength` is a courtesy that a `curl` ignores, and the schema is the rule.
 */
/**
 * Why somebody is writing, as a closed list.
 *
 * ── Why this is a select and not a free-text subject line ──
 * A subject line is written by the sender to be read by nobody: the reader is
 * already reading the message. What a reason is actually for is triage — a
 * channel where a security questionnaire and a bug report look identical until
 * somebody opens both is a channel where the urgent one waits behind the other.
 * Six options because a list somebody has to scroll is a list they pick the
 * first item from.
 *
 * `other` is last and exists on purpose. A closed list with no escape hatch
 * makes people choose the nearest wrong answer, which is worse than no answer
 * at all — the triage then runs on a category the sender did not mean.
 *
 * The `label` is what the form shows and what the Discord message says, so the
 * two cannot drift into different vocabularies for the same enquiry.
 */
export const CONTACT_REASONS = [
  { id: 'sales', label: 'Sales or an Enterprise agreement' },
  { id: 'support', label: 'Help with the product' },
  { id: 'security', label: 'A security review or questionnaire' },
  { id: 'migration', label: 'Migrating from something else' },
  { id: 'feature', label: 'A feature request' },
  { id: 'partnership', label: 'Partnership or press' },
  { id: 'other', label: 'Something else' },
] as const;

export type ContactReasonId = (typeof CONTACT_REASONS)[number]['id'];

/** The default: the card that sends most people here is the Enterprise one. */
export const DEFAULT_CONTACT_REASON: ContactReasonId = 'sales';

/** The label for a stored id, for the message a human reads. */
export function contactReasonLabel(id: string): string {
  return CONTACT_REASONS.find((reason) => reason.id === id)?.label ?? id;
}

export const CONTACT_LIMITS = {
  name: 100,
  /** RFC 5321's maximum for a forward path. Longer is not an address anywhere. */
  email: 254,
  company: 100,
  /**
   * Roughly two pages: more than any real enquiry, and little enough that a
   * thousand of them is not a denial of service against the channel a human
   * reads. `discord.ts` truncates well below this; see the note there on why the
   * two bounds do different jobs.
   */
  message: 4_000,
} as const;
