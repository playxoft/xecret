import { describe, expect, it } from 'vitest';

import { looksLikeAssignments, parsePastedSecrets } from './paste-secrets';

/**
 * The paste path into the table.
 *
 * These tests are about the *seam* — what the browser does with `parseDotenv`'s
 * output on its way to becoming editable rows. The parser itself is covered by
 * `packages/core/src/importer/importer.test.ts`; what matters here is that an
 * illegal source key becomes a legal, editable row rather than a silent drop,
 * because a dropped row is a credential the user believes they pasted.
 */

describe('looksLikeAssignments', () => {
  it('accepts anything a secret name could not be', () => {
    // A name matches ^[A-Za-z_][A-Za-z0-9_]*$, so neither character can appear
    // in a paste that was meant literally as a name.
    expect(looksLikeAssignments('A=1')).toBe(true);
    expect(looksLikeAssignments('A=1\nB=2')).toBe(true);
    expect(looksLikeAssignments('DATABASE_URL\nSTRIPE_KEY')).toBe(true);
  });

  it('leaves a plain name alone', () => {
    expect(looksLikeAssignments('DATABASE_URL')).toBe(false);
    expect(looksLikeAssignments('')).toBe(false);
  });
});

describe('parsePastedSecrets', () => {
  it('turns each assignment into a row', () => {
    const { seeds, warnings, renamed } = parsePastedSecrets('A=1\nB=2');

    expect(seeds).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
    expect(warnings).toEqual([]);
    expect(renamed).toEqual([]);
  });

  it('corrects a key that could not be an environment variable, and says so', () => {
    const { seeds, renamed } = parsePastedSecrets('database.url=postgres://x\nmy-api-key=abc');

    expect(seeds).toEqual([
      { name: 'DATABASE_URL', value: 'postgres://x' },
      { name: 'MY_API_KEY', value: 'abc' },
    ]);
    // Reported rather than applied silently: the user pasted `database.url` and
    // is entitled to know the stored name is not that.
    expect(renamed).toEqual([
      { from: 'database.url', to: 'DATABASE_URL' },
      { from: 'my-api-key', to: 'MY_API_KEY' },
    ]);
  });

  it('keeps a key it cannot fix, so the row can show the error', () => {
    // Nothing legal can be derived from `---`. Dropping the entry would lose a
    // value the user believes they pasted; keeping it puts the problem in front
    // of them in an editable field.
    const { seeds, renamed } = parsePastedSecrets('---=x');

    expect(seeds).toEqual([{ name: '---', value: 'x' }]);
    expect(renamed).toEqual([]);
  });

  it('keeps a reserved name rather than mangling it', () => {
    // `PATH` is a legal identifier and normalising it changes nothing, so there
    // is no correction to offer — the row surfaces "reserved" instead.
    const { seeds, renamed } = parsePastedSecrets('PATH=/usr/bin');

    expect(seeds).toEqual([{ name: 'PATH', value: '/usr/bin' }]);
    expect(renamed).toEqual([]);
  });

  it('reads a quoted multi-line value as one row', () => {
    const { seeds } = parsePastedSecrets('CERT="line1\nline2"\nAFTER=3');

    expect(seeds).toEqual([
      { name: 'CERT', value: 'line1\nline2' },
      { name: 'AFTER', value: '3' },
    ]);
  });

  it('reports a line it could not read without quoting it back', () => {
    const { seeds, warnings } = parsePastedSecrets('A=1\nnot an assignment\nB=2');

    expect(seeds).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.line).toBe(2);
    // The warning names a line, never its contents: warnings are rendered in
    // the browser and pasted into issue reports.
    expect(warnings[0]?.message).not.toContain('not an assignment');
  });

  it('finds nothing in an empty paste', () => {
    expect(parsePastedSecrets('').seeds).toEqual([]);
    expect(parsePastedSecrets('# just a comment\n\n').seeds).toEqual([]);
  });
});
