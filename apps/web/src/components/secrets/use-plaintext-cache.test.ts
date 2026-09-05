import { describe, expect, it } from 'vitest';

import { entryKeyFor, readEntry } from './use-plaintext-cache';

/**
 * The two rules that decide whether a decrypted credential may be handed back.
 *
 * Both failures are silent and both are serious: serving an entry whose version
 * has moved on puts a superseded secret on the clipboard and seeds the next
 * edit from it, which writes it back over what was just saved; serving one
 * filed under a different environment shows production's value under
 * development's heading.
 */

describe('readEntry', () => {
  const entry = { version: 3, value: 'postgres://old' };

  it('returns the value when the version still matches', () => {
    expect(readEntry(entry, 3)).toBe('postgres://old');
  });

  it('misses rather than serving a superseded value', () => {
    // Written at v3, asked for at v4: the secret has been rotated since, and
    // this copy describes the credential that was replaced.
    expect(readEntry(entry, 4)).toBeUndefined();
  });

  it('misses on an older version too, not only a newer one', () => {
    expect(readEntry(entry, 2)).toBeUndefined();
  });

  it('misses when there is no entry at all', () => {
    expect(readEntry(undefined, 3)).toBeUndefined();
  });

  it('serves an empty value, which is a value and not an absence', () => {
    expect(readEntry({ version: 1, value: '' }, 1)).toBe('');
  });
});

describe('entryKeyFor', () => {
  it('files the same name under different environments separately', () => {
    expect(entryKeyFor('acme/api/production', 'DATABASE_URL')).not.toBe(
      entryKeyFor('acme/api/development', 'DATABASE_URL'),
    );
  });

  it('files different names under one environment separately', () => {
    expect(entryKeyFor('acme/api/production', 'DATABASE_URL')).not.toBe(
      entryKeyFor('acme/api/production', 'REDIS_URL'),
    );
  });

  it('is stable, so a write and a read agree', () => {
    expect(entryKeyFor('acme/api/production', 'DATABASE_URL')).toBe(
      entryKeyFor('acme/api/production', 'DATABASE_URL'),
    );
  });

  it('cannot be forged by a name that spells another environment', () => {
    // The separator is NUL precisely because neither half can contain one:
    // environment keys are slugs and secret names are `[A-Za-z0-9_]`. Were it a
    // printable character, a name could impersonate a boundary and read another
    // environment's plaintext.
    const separator = String.fromCharCode(0);
    expect(entryKeyFor('acme/api/development', 'DATABASE_URL')).not.toBe(
      entryKeyFor('acme/api', `development${separator}DATABASE_URL`.replace(separator, '/')),
    );
    expect(entryKeyFor('a', 'b')).toContain(separator);
  });
});
