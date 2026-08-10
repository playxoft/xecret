import { describe, expect, it } from 'vitest';
import { isReservedSlug, slugify, slugSchema } from './slug';

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
