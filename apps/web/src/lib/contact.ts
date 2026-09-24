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
