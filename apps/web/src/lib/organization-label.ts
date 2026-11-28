/**
 * Telling organisations apart when their names do not.
 *
 * An organisation's name is free text and not unique: two people may well both
 * call theirs "Acme", and one person may belong to both. Every picker that
 * lists organisations by name therefore needs something more beside the name
 * whenever the names collide, or choosing between them is a guess. Approving a
 * CLI device, switching the dashboard, opening one from the picker: a guess
 * there puts somebody's secrets in the wrong organisation.
 *
 * What goes beside the name is the end of the organisation's id, which is
 * what its addresses carry (`/app/{id}`) and what the settings page shows in
 * full. The *end*, not the start: an organisation's id is a UUIDv7, whose first
 * characters are its creation time, so two organisations made in the same
 * minute begin with the same eight characters. The last eight are random.
 */

/** How many characters of the id are shown beside a name. */
export const SHORT_ORG_ID_LENGTH = 8;

/** The end of an organisation's id, as it is shown beside its name. */
export function shortOrgId(id: string): string {
  return id.slice(-SHORT_ORG_ID_LENGTH);
}

/**
 * The names shared by more than one of these organisations, compared as a
 * person reads them: ignoring case and surrounding spaces, since "Acme" and
 * "acme " are no easier to tell apart than "Acme" and "Acme".
 */
export function sharedOrgNames(organizations: readonly { name: string }[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { name } of organizations) {
    const key = foldName(name);
    if (seen.has(key)) shared.add(key);
    seen.add(key);
  }
  return shared;
}

/** Whether this organisation's name is one of the `shared` ones. */
export function nameIsShared(name: string, shared: ReadonlySet<string>): boolean {
  return shared.has(foldName(name));
}

/**
 * Whether a search term finds this organisation: by its name, or by any part
 * of its id, so the id somebody copied from an address or a settings page
 * finds the one it belongs to.
 */
export function organizationMatches(
  organization: { id: string; name: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    organization.name.toLowerCase().includes(needle) ||
    organization.id.toLowerCase().includes(needle)
  );
}

function foldName(name: string): string {
  return name.trim().toLowerCase();
}
