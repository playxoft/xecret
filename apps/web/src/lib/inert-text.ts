/**
 * Text somebody else chose, made safe to put in front of a person who is about
 * to make a decision on the strength of it.
 *
 * React already escapes markup, so nothing here is about HTML. It is about the
 * characters that change what a reader *sees* without changing what the string
 * *is* — the tools of a spoofed name on a page that asks "is this you?"
 * (review round 2, the sign-in confirmation):
 *
 *  - **Direction overrides and isolates** (U+202A–U+202E, U+2066–U+2069) and
 *    the other invisible format characters — zero-width spaces and joiners, the
 *    byte-order mark, soft hyphens. RIGHT-TO-LEFT OVERRIDE followed by
 *    "moc.elpmaxe@ecila" renders as "alice@example.com"; an organisation
 *    called "Acme" and a ZERO WIDTH SPACE reads as "Acme". (Named here, never
 *    written: this file holds none of the characters it is about.)
 *  - **Control and separator characters** — C0, DEL, C1, and the line and
 *    paragraph separators that break a sentence where nobody typed a break.
 *  - **Unassigned, private-use and lone-surrogate code points**, which render as
 *    whatever the reader's font happens to put there.
 *  - **Stacked combining marks** — a base character with a tower of accents
 *    above and below it that overflows into the lines around it. Two marks per
 *    character is enough for every real script this product will meet.
 *  - **Length.** A name long enough to push the sentence that explains it off
 *    the screen is a name chosen for that purpose.
 *
 * Each of those is replaced by U+FFFD — visibly, rather than silently removed,
 * so a name that *had* one reads as odd, which is what it is. Other whitespace
 * becomes a plain space, runs of it one space. Callers still render the result
 * inside `<bdi>`, so whatever direction its letters have cannot reorder the
 * sentence around it.
 */

/** The replacement shown where a character was taken out. */
export const REPLACED = String.fromCodePoint(0xfffd);

// In `u` mode a lone surrogate is a code point of its own, `\p{Cs}`; a pair is
// one astral character and is left alone.
const INVISIBLE_OR_UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;
const WHITESPACE = /[\p{Zs}\t\n\v\f\r]+/gu;
const MAX_MARKS_PER_CHARACTER = 2;

/**
 * `value` with every character above made inert, cut to `maxCodePoints` (with
 * an ellipsis) — never longer, and never empty for a non-empty input.
 */
export function inertText(value: string, maxCodePoints: number): string {
  const cleaned = value
    // Whitespace first, so a tab or a newline becomes a space rather than a
    // replacement character; every other control after.
    .replace(WHITESPACE, ' ')
    .replace(INVISIBLE_OR_UNPRINTABLE, REPLACED)
    .trim();

  const kept: string[] = [];
  let marks = 0;
  for (const character of cleaned) {
    if (/\p{M}/u.test(character)) {
      marks += 1;
      if (marks > MAX_MARKS_PER_CHARACTER) continue;
    } else {
      marks = 0;
    }
    kept.push(character);
  }

  if (kept.length <= maxCodePoints) return kept.join('');
  return `${kept.slice(0, Math.max(1, maxCodePoints - 1)).join('')}…`;
}

/** Whether `value` has a character outside printable ASCII — worth a second look in an address. */
export function hasNonAsciiCharacters(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}
