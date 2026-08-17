import { describe, expect, it } from 'vitest';
import { ORGANIZATION_NAME_MAX_LENGTH } from './names';
import {
  checkSlug,
  isReservedSlug,
  normalizeSlugInput,
  ORGANIZATION_SLUG_MAX_LENGTH,
  organizationSlugSchema,
  slugify,
  slugSchema,
  SLUG_MAX_LENGTH,
} from './slug';
import type { SlugProblem } from './slug';

describe('slugify', () => {
  it.each([
    ['My Company', 'my-company'],
    ['Backend API', 'backend-api'],
    ['  Trim  Me  ', 'trim-me'],
    ['already-a-slug', 'already-a-slug'],
    ['Dots.And.Dots', 'dots-and-dots'],
    ['multiple---hyphens', 'multiple-hyphens'],
    ['Café Münchén', 'cafe-munchen'],
  ])('slugifies %s to %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('truncates without leaving a trailing hyphen', () => {
    const out = slugify('a'.repeat(70));
    expect(out).toHaveLength(63);
    expect(out.endsWith('-')).toBe(false);

    const truncatedAtBoundary = slugify(`${'a'.repeat(62)} tail`);
    expect(truncatedAtBoundary.endsWith('-')).toBe(false);
  });

  it('always produces a schema-valid slug when it produces anything', () => {
    for (const input of ['My Company', 'Café Münchén', 'x'.repeat(80), 'a.b.c']) {
      const out = slugify(input);
      if (out !== '') expect(slugSchema.safeParse(out).success).toBe(true);
    }
  });
});

describe('slugSchema', () => {
  it.each(['my-company', 'api2', 'a'])('accepts %s', (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(true);
  });

  it.each([
    ['My-Company', 'uppercase'],
    ['-leading', 'leading hyphen'],
    ['trailing-', 'trailing hyphen'],
    ['double--hyphen', 'consecutive hyphens'],
    ['has space', 'space'],
    ['', 'empty'],
  ])('rejects %s (%s)', (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(false);
  });

  it('rejects slugs that would collide with application routes', () => {
    for (const slug of ['api', 'admin', 'settings', 'cli', 'xecret']) {
      expect(isReservedSlug(slug)).toBe(true);
      expect(slugSchema.safeParse(slug).success).toBe(false);
    }
  });
});

describe('checkSlug', () => {
  it.each(['acme', 'acme-corp', 'a1-b2-c3', 'x'])('accepts %s', (slug) => {
    expect(checkSlug(slug)).toEqual({ valid: true });
  });

  /**
   * Each hyphen rule reports itself rather than collapsing into "invalid
   * characters".
   *
   * `normalizeSlugInput` deliberately lets a trailing hyphen be typed, so a
   * slug field passes *through* these states on the way to a valid slug — and
   * "use lowercase letters, digits and single hyphens" is no help to somebody
   * who has just pressed a hyphen and can see that they did.
   */
  it.each<[string, SlugProblem]>([
    ['', 'empty'],
    ['acme-', 'trailingHyphen'],
    ['-acme', 'leadingHyphen'],
    ['acme--corp', 'doubleHyphen'],
    ['Acme', 'invalidCharacters'],
    ['acme corp', 'invalidCharacters'],
    ['acme_corp', 'invalidCharacters'],
    ['settings', 'reserved'],
  ])('reports %s as %s', (slug, problem) => {
    const check = checkSlug(slug);

    expect(check.valid).toBe(false);
    expect(check.valid === false && check.problem).toBe(problem);
  });

  it('applies whatever ceiling it is given', () => {
    const twentySix = 'a'.repeat(26);

    expect(checkSlug(twentySix, ORGANIZATION_SLUG_MAX_LENGTH).valid).toBe(false);
    expect(checkSlug(twentySix, SLUG_MAX_LENGTH).valid).toBe(true);
  });

  // The message goes straight under a form field, and this product does not
  // return user input in error messages.
  it('never echoes the value it rejected', () => {
    const check = checkSlug('Not A Slug At All');
    expect(check.valid === false && check.message).not.toContain('Not A Slug');
  });

  /**
   * The invariant the whole function exists for.
   *
   * `POST /api/orgs` validates with `organizationSlugSchema`, the create form
   * words a rejection with `describeSlugProblem`, and
   * `GET /api/orgs/availability` reports a category — and all three used to
   * derive the rules from `SLUG_PATTERN` themselves. A fourth rule added to one
   * of them left the availability endpoint answering `available: true` for a
   * slug the create endpoint was about to refuse. They now share this function,
   * and this is what says so out loud.
   */
  it('agrees with the schemas built from it, on every case either of them sees', () => {
    const corpus = [
      'acme',
      'acme-corp',
      'a1-b2-c3',
      '',
      'Acme',
      'acme corp',
      'acme_corp',
      '-acme',
      'acme-',
      'acme--corp',
      'settings',
      'availability',
      'a'.repeat(ORGANIZATION_SLUG_MAX_LENGTH),
      'a'.repeat(ORGANIZATION_SLUG_MAX_LENGTH + 1),
      'a'.repeat(SLUG_MAX_LENGTH + 1),
    ];

    for (const slug of corpus) {
      expect(organizationSlugSchema.safeParse(slug).success, slug).toBe(
        checkSlug(slug, ORGANIZATION_SLUG_MAX_LENGTH).valid,
      );
      expect(slugSchema.safeParse(slug).success, slug).toBe(
        checkSlug(slug, SLUG_MAX_LENGTH).valid,
      );
    }
  });

  // The schema is the function, so the sentence a caller reads is the one
  // written beside the rule rather than zod's description of a regex.
  it('carries its own wording into the schema’s issue', () => {
    const result = organizationSlugSchema.safeParse('acme-');

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'A slug cannot end with a hyphen. Add a letter or digit after it.',
    );
  });
});

describe('normalizeSlugInput', () => {
  /**
   * The regression this function exists for.
   *
   * The slug field used `slugify`, which strips trailing hyphens — so pressing
   * `-` after `acme` did nothing at all, and the only way to get a hyphen was to
   * move the caret left and type it between two letters.
   */
  it('keeps a trailing hyphen, so a hyphenated slug can be typed left to right', () => {
    expect(normalizeSlugInput('acme-')).toBe('acme-');
    // …and the value at every keystroke of `acme-corp` is what was typed.
    let typed = '';
    for (const key of 'acme-corp') {
      typed = normalizeSlugInput(typed + key);
    }
    expect(typed).toBe('acme-corp');
  });

  it('keeps a leading hyphen and a doubled one, reporting rather than repairing', () => {
    expect(normalizeSlugInput('-acme')).toBe('-acme');
    expect(normalizeSlugInput('a--b')).toBe('a--b');
    // Each is invalid, which is the form's job to say — not this function's to
    // silently undo.
    expect(slugSchema.safeParse('-acme').success).toBe(false);
    expect(slugSchema.safeParse('a--b').success).toBe(false);
  });

  it('substitutes rather than deletes, so the caret never moves', () => {
    for (const input of ['acme-', 'Acme Corp', 'acme  corp', 'a--b', '-acme', 'ACME_EU', '???']) {
      expect(normalizeSlugInput(input), input).toHaveLength(input.length);
    }
  });

  it('still lowercases and maps separators to hyphens', () => {
    expect(normalizeSlugInput('Acme Corp')).toBe('acme-corp');
    expect(normalizeSlugInput('ACME_EU')).toBe('acme-eu');
    // Accent folding is the one length-changing case, and is worth it: without
    // it "Café" would normalise to `caf-`.
    expect(normalizeSlugInput('Café')).toBe('cafe');
  });

  /** Anything already valid must survive untouched, or typing would fight itself. */
  it('is a no-op on a slug that is already valid', () => {
    for (const slug of ['acme', 'acme-corp', 'a1-b2-c3', 'x']) {
      expect(normalizeSlugInput(slug), slug).toBe(slug);
    }
  });
});

describe('organizationSlugSchema', () => {
  /**
   * The invariant that makes the create form coherent.
   *
   * The form derives the slug from the name, and `slugify` maps each run of
   * separators to a single hyphen — so a derived slug is never longer than the
   * name it came from. If this ceiling dropped below the name's, the form would
   * generate a slug and then refuse it, blaming a field the user never touched.
   *
   * So raising `ORGANIZATION_NAME_MAX_LENGTH` without raising this one fails
   * here, rather than shipping that form.
   */
  it('is never shorter than the name a slug is derived from', () => {
    expect(ORGANIZATION_SLUG_MAX_LENGTH).toBeGreaterThanOrEqual(ORGANIZATION_NAME_MAX_LENGTH);

    const longestName = 'a b '
      .repeat(ORGANIZATION_NAME_MAX_LENGTH)
      .slice(0, ORGANIZATION_NAME_MAX_LENGTH);
    expect(organizationSlugSchema.safeParse(slugify(longestName)).success).toBe(true);
  });

  it('is tighter than the general ceiling, which stays at the DNS label limit', () => {
    expect(ORGANIZATION_SLUG_MAX_LENGTH).toBeLessThan(SLUG_MAX_LENGTH);
    expect(SLUG_MAX_LENGTH).toBe(63);

    const overLong = 'a'.repeat(ORGANIZATION_SLUG_MAX_LENGTH + 1);
    expect(organizationSlugSchema.safeParse(overLong).success).toBe(false);
    // The same string is still a valid project or environment slug.
    expect(slugSchema.safeParse(overLong).success).toBe(true);
  });

  it('inherits every other rule from slugSchema', () => {
    for (const slug of ['My-Company', '-leading', 'trailing-', 'double--hyphen', 'settings', '']) {
      expect(organizationSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
    expect(organizationSlugSchema.safeParse('acme-eu').success).toBe(true);
  });
});
