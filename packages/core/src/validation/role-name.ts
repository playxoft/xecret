/**
 * Custom role names: what an organisation may call one of its roles.
 *
 * A role's name is shown beside a person's built-in role on every member row,
 * in the menu that assigns it, and in the audit log — to everybody who can
 * read the roster, and in words the organisation chose. So it is held to more
 * than a length:
 *
 *  - **Nothing invisible, nothing that moves the text around.** Control
 *    characters (`Cc`: NUL, newlines, tabs) and format characters (`Cf`: the
 *    bidirectional overrides, zero-width joiners and spaces, the BOM) are
 *    refused outright, as are the line and paragraph separators. A name that
 *    renders as "Owner" by reversing "renwO", or as nothing at all, is the
 *    shape of somebody passing one role off as another on a colleague's
 *    screen. The audit builder already strips these from what it stores; a
 *    name is refused them before it is stored anywhere. NUL also cannot be
 *    stored in Postgres text at all.
 *  - **One canonical spelling.** Names are normalised to NFC, so "é" typed
 *    precomposed and "é" typed as `e` plus a combining accent are one name,
 *    not two that look identical.
 *  - **Something visible.** At least one letter, digit, punctuation mark or
 *    symbol — a name of spaces is no name.
 *  - **Not a built-in role.** `owner`, `admin`, `developer` and `viewer`, in
 *    any case, are the product's own roles; a custom role called "Admin" would
 *    make "Admin · Admin" on a roster mean two different things.
 *
 * Uniqueness is decided by the repository, case-insensitively, under the
 * organisation lock — "Deployer" and "deployer" are one job title.
 *
 * Shared by the API, which refuses what this refuses, and the dashboard, which
 * says so before the request is made.
 */

/**
 * How long a custom role's name may be.
 *
 * A custom role is a job title — "Deployer", "Release manager", "Contractor
 * (read-only)" — and it is rendered beside the built-in role on every row of
 * the member list and in the menu that assigns it. Forty characters is room
 * for any title a person would actually use, and short enough that two of
 * them side by side in a badge stay tellable apart.
 */
export const CUSTOM_ROLE_NAME_MAX_LENGTH = 40;

/**
 * How many custom roles one organisation may define.
 *
 * Not a plan limit — custom roles are an Enterprise feature and Enterprise has
 * no ceilings — but a bound on a table a single caller can grow, so that the
 * listing can be read whole (the settings page and the assignment menu both
 * need every role). A hundred job titles is far past what four built-in roles
 * are ever narrowed into. Here rather than in the repository so the dashboard
 * can stop offering "New role" at the same number the server refuses at.
 */
export const CUSTOM_ROLES_PER_ORGANIZATION = 100;

/** The built-in role names, which no custom role may take in any case. */
const RESERVED = new Set(['owner', 'admin', 'developer', 'viewer']);

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** A name as it is compared and stored: trimmed and NFC-normalised. */
export function normalizeCustomRoleName(name: string): string {
  return name.normalize('NFC').trim();
}

/**
 * Why `name` — already normalised — cannot name a custom role, or `null` when
 * it can. The messages are fixed sentences about the rule, never an echo of
 * the name.
 */
export function customRoleNameProblem(name: string): string | null {
  if (name.length === 0) return 'A role needs a name.';
  if (name.length > CUSTOM_ROLE_NAME_MAX_LENGTH) {
    return `A role name must be at most ${CUSTOM_ROLE_NAME_MAX_LENGTH} characters.`;
  }
  if (INVISIBLE.test(name)) {
    return 'A role name cannot contain control or invisible formatting characters.';
  }
  if (!VISIBLE.test(name)) return 'A role name needs at least one visible character.';
  if (RESERVED.has(name.toLowerCase())) {
    return 'That is the name of a built-in role. Choose another.';
  }
  return null;
}
