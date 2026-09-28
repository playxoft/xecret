/**
 * Custom role names: what an organisation may call one of its roles.
 *
 * A role's name is shown beside a person's built-in role on every member row,
 * in the menu that assigns it, and in the audit log — to everybody who can
 * read the roster, and in words the organisation chose. So it is held to more
 * than a length. The question every rule answers is the same: could this name
 * be *read* as something it is not — as a built-in role, as another custom
 * role, or as nothing at all?
 *
 *  - **One spelling.** Names are normalised before anything else: variation
 *    selectors are dropped (they only pick an emoji or glyph style, so a heart
 *    with VS16 after it is still a heart, and "Owner" with one is "Owner"),
 *    every run of spaces of any width — no-break, ideographic, doubled —
 *    becomes one ordinary space, the result is NFC, and the ends are trimmed.
 *    What is stored is that normal form.
 *  - **Nothing invisible, nothing that moves the text around.** Control and
 *    format characters (NUL, newlines, bidirectional overrides, zero-width
 *    spaces and joiners), the line and paragraph separators, everything
 *    Unicode marks as rendering as nothing (`Default_Ignorable_Code_Point`:
 *    the combining grapheme joiner, the Hangul fillers, tag characters) and
 *    the Braille blank, a symbol that draws nothing, are refused. A name that
 *    renders as "Owner" by reversing "renwO", or as nothing at all, is the
 *    shape of somebody passing one role off as another on a colleague's
 *    screen. NUL also cannot be stored in Postgres text at all.
 *  - **Something visible.** At least one letter, digit, punctuation mark or
 *    symbol — a name of spaces is no name.
 *  - **Not a built-in role, nor anything that looks like one.** `owner`,
 *    `admin`, `developer` and `viewer` are the product's own roles; a custom
 *    role called "Admin" would make "Admin · Admin" on a roster mean two
 *    different things. They are compared on the name's *skeleton* (below), so
 *    "ADMIN", "Admin" in full-width or mathematical bold letters, "ADMIN" with
 *    a Turkish dotted capital I, and "Owner" with a Cyrillic capital O are all
 *    refused as the built-in names they imitate.
 *  - **No mixing Latin with Cyrillic or Greek.** Those scripts share letters
 *    that are drawn identically, which is how a name borrows another's look
 *    one letter at a time. A name may be written in any of them, not in two.
 *
 * ── The skeleton ──
 * `customRoleNameSkeleton` is what two names are compared by: compatibility
 * forms folded (full-width and mathematical letters become plain ones), the
 * Cyrillic and Greek letters drawn like Latin ones folded to them, lowercased,
 * and the accents on Latin, Greek and Cyrillic letters dropped. Two names with
 * one skeleton are one name to a reader, and the repository refuses the
 * second: "Deployer", "deployer" and a full-width "Deployer" are one job
 * title. Accents are dropped only on those three scripts; elsewhere a mark is
 * part of the letter, not a decoration on it — two Devanagari words that
 * differ by a vowel sign are two words.
 *
 * Shared by the API, which refuses what this refuses, the repository, which
 * decides uniqueness on the skeleton under the organisation lock, and the
 * dashboard, which says so before the request is made.
 *
 * Every non-ASCII character the rules use is built from its code point, so
 * this file holds no lookalike or invisible character of its own and what the
 * code compares is what it says.
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
 * need every role, and the repository compares a new name with every other).
 * A hundred job titles is far past what four built-in roles are ever narrowed
 * into. Here rather than in the repository so the dashboard can stop offering
 * "New role" at the same number the server refuses at.
 */
export const CUSTOM_ROLES_PER_ORGANIZATION = 100;

/** The built-in role names, which no custom role may take or imitate. */
const RESERVED = new Set(['owner', 'admin', 'developer', 'viewer']);

/** Picks a glyph or emoji style and nothing else. Dropped by normalising. */
const VARIATION_SELECTORS = /\p{Variation_Selector}/gu;
/** Spaces of every width: one ordinary space, however many and whichever. */
const SPACE_RUNS = /\p{Zs}+/gu;

/**
 * Characters no name may hold. The Braille blank (U+2800) is a symbol, not a
 * format character, but it draws nothing — so it is listed on its own.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const BRAILLE_BLANK = String.fromCodePoint(0x2800);

const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC_OR_GREEK = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

const MARK = /\p{M}/u;
/** The bases whose accents a skeleton drops: see "The skeleton" above. */
const ACCENT_IS_DECORATION =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}]/u;

/**
 * Letters drawn like Latin ones, folded to them — each case to what *it*
 * looks like, since the Greek capital nu is an N and its lowercase a v.
 * A small table, not the Unicode confusables data: enough that no built-in
 * name can be spelled in lookalikes, and that two custom names cannot differ
 * only by one. Mixing scripts is refused outright; this covers a name written
 * wholly in one of them.
 */
const CONFUSABLES = new Map<string, string>(
  (
    [
      // Cyrillic capitals
      [0x0405, 'S'],
      [0x0406, 'I'],
      [0x0408, 'J'],
      [0x0410, 'A'],
      [0x0412, 'B'],
      [0x0415, 'E'],
      [0x041a, 'K'],
      [0x041c, 'M'],
      [0x041d, 'H'],
      [0x041e, 'O'],
      [0x0420, 'P'],
      [0x0421, 'C'],
      [0x0422, 'T'],
      [0x0423, 'Y'],
      [0x0425, 'X'],
      [0x04ae, 'Y'],
      [0x04c0, 'I'],
      [0x0500, 'D'],
      [0x051a, 'Q'],
      [0x051c, 'W'],
      // Cyrillic small letters
      [0x0430, 'a'],
      [0x0435, 'e'],
      [0x043e, 'o'],
      [0x0440, 'p'],
      [0x0441, 'c'],
      [0x0443, 'y'],
      [0x0445, 'x'],
      [0x0455, 's'],
      [0x0456, 'i'],
      [0x0458, 'j'],
      [0x04af, 'y'],
      [0x04bb, 'h'],
      [0x04cf, 'l'],
      [0x0501, 'd'],
      [0x051b, 'q'],
      [0x051d, 'w'],
      // Greek capitals
      [0x0391, 'A'],
      [0x0392, 'B'],
      [0x0395, 'E'],
      [0x0396, 'Z'],
      [0x0397, 'H'],
      [0x0399, 'I'],
      [0x039a, 'K'],
      [0x039c, 'M'],
      [0x039d, 'N'],
      [0x039f, 'O'],
      [0x03a1, 'P'],
      [0x03a4, 'T'],
      [0x03a5, 'Y'],
      [0x03a7, 'X'],
      // Greek small letters
      [0x03b1, 'a'],
      [0x03b3, 'y'],
      [0x03b7, 'n'],
      [0x03b9, 'i'],
      [0x03ba, 'k'],
      [0x03bd, 'v'],
      [0x03bf, 'o'],
      [0x03c1, 'p'],
      [0x03c5, 'u'],
      [0x03c7, 'x'],
      [0x03c9, 'w'],
      // Latin letters drawn like others: dotless i and j, single-storey a and g
      [0x0131, 'i'],
      [0x0237, 'j'],
      [0x0251, 'a'],
      [0x0261, 'g'],
      // Hyphens and apostrophes that render as the ASCII ones
      [0x2010, '-'],
      [0x2011, '-'],
      [0x2012, '-'],
      [0x2212, '-'],
      [0x2018, "'"],
      [0x2019, "'"],
      [0x02bc, "'"],
    ] as const
  ).map(([point, latin]) => [String.fromCodePoint(point), latin]),
);

const fold = (char: string): string => CONFUSABLES.get(char) ?? char;

/**
 * A name as it is compared and stored: variation selectors dropped, spaces
 * collapsed, NFC, trimmed. See "One spelling" above.
 */
export function normalizeCustomRoleName(name: string): string {
  return name.replace(VARIATION_SELECTORS, '').replace(SPACE_RUNS, ' ').normalize('NFC').trim();
}

/**
 * What two names are compared by — one skeleton is one name to a reader. See
 * "The skeleton" above. Normalises first, so any spelling of a name may be
 * passed.
 */
export function customRoleNameSkeleton(name: string): string {
  const lowered = Array.from(normalizeCustomRoleName(name).normalize('NFKD'), fold)
    .join('')
    .toLowerCase()
    // Lowercasing can decompose again: the dotted capital I becomes "i" and
    // a combining dot above.
    .normalize('NFKD');

  let skeleton = '';
  let dropMarks = false;
  for (const char of lowered) {
    if (MARK.test(char)) {
      if (!dropMarks) skeleton += char;
      continue;
    }
    // Folded again after lowercasing, for a capital whose lowercase is a
    // lookalike the table knows only in that case.
    const letter = fold(char);
    dropMarks = ACCENT_IS_DECORATION.test(letter);
    skeleton += letter;
  }
  return skeleton.replace(SPACE_RUNS, ' ').normalize('NFC');
}

/**
 * Why `name` — already normalised — cannot name a custom role, or `null` when
 * it can. The messages are fixed sentences about the rule, never an echo of
 * the name.
 *
 * Whether another of the organisation's roles already has the name is not
 * answered here: that needs the other names, and is the repository's, on
 * `customRoleNameSkeleton`, under the organisation lock.
 */
export function customRoleNameProblem(name: string): string | null {
  if (name.length === 0) return 'A role needs a name.';
  if (name.length > CUSTOM_ROLE_NAME_MAX_LENGTH) {
    return `A role name must be at most ${CUSTOM_ROLE_NAME_MAX_LENGTH} characters.`;
  }
  if (INVISIBLE.test(name) || name.includes(BRAILLE_BLANK)) {
    return 'A role name cannot contain control, formatting or invisible characters.';
  }
  if (!VISIBLE.test(name)) return 'A role name needs at least one visible character.';
  if (RESERVED.has(customRoleNameSkeleton(name))) {
    return 'That is, or looks like, the name of a built-in role. Choose another.';
  }
  const letters = name.normalize('NFKC');
  if (LATIN.test(letters) && CYRILLIC_OR_GREEK.test(letters)) {
    return 'A role name cannot mix Latin letters with Cyrillic or Greek ones.';
  }
  return null;
}
