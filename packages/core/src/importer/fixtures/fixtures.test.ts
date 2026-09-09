import { describe, expect, it } from 'vitest';
import { buildFixtureFile } from './build';
import committed from './import-fixtures.json' with { type: 'json' };
import type { FixtureFile } from './build';

/**
 * The committed fixture file must be what this implementation produces.
 *
 * Without this the file is a snapshot nobody re-checks: a parser could change
 * behaviour, the Go suite would keep passing against the stale expectations, and
 * the two implementations would drift apart while both reported green. This test
 * is the half of the contract that keeps the file honest; `fixtures_test.go` is
 * the half that keeps the Go parsers honest against it.
 */

const file = committed as unknown as FixtureFile;

describe('the import fixtures', () => {
  it('match what the parsers produce today', () => {
    const rebuilt = buildFixtureFile({
      generatedAt: file.generatedAt,
      generator: file.generator,
    });

    // Compared whole rather than case by case: a case that disappeared from
    // `build.ts` but stayed in the file is exactly as much of a problem as one
    // whose expectations moved, and only a whole-file comparison catches it.
    expect(rebuilt).toEqual(file);
  });

  it('cover every format, so neither implementation can skip one', () => {
    const formats = new Set(file.cases.map((entry) => entry.format));
    expect([...formats].sort()).toEqual(['dotenv', 'json', 'shell', 'yaml']);
  });

  it('cover the planner, not only the parsers', () => {
    // The planner is where a source key becomes a secret name, and a
    // disagreement there imports a value under a name the user did not choose.
    expect(file.cases.filter((entry) => entry.plan !== undefined).length).toBeGreaterThan(3);
  });

  it('carry a case whose value is outside ASCII', () => {
    const nonAscii = file.cases.some((entry) =>
      entry.expected.entries.some((parsed) => /[^\x20-\x7e]/.test(parsed.value)),
    );
    expect(nonAscii, 'a byte-for-byte guarantee is untested without one').toBe(true);
  });

  it('carry cases that expect a rejection, not only a parse', () => {
    // A parser that returned "no entries, no warnings" for everything would pass
    // a suite of positive cases.
    const rejecting = file.cases.filter((entry) => entry.expected.warnings.length > 0);
    expect(rejecting.length).toBeGreaterThan(4);
  });

  it('use a null message only where the wording belongs to a library', () => {
    for (const entry of file.cases) {
      for (const warning of entry.expected.warnings) {
        if (warning.message !== null) continue;
        expect(
          entry.id,
          'a null message means "wording is the implementation\'s own", which is only true for library errors',
        ).toMatch(/^(json|yaml)\//);
      }
    }
  });

  /**
   * A null line is the weaker claim of the two, so it needs the tighter guard:
   * every position either implementation computes itself is contractual, and
   * only a YAML syntax error's is not.
   */
  it('use a null line only for a YAML syntax error', () => {
    for (const entry of file.cases) {
      for (const warning of entry.expected.warnings) {
        if (warning.line === null) expect(entry.id).toBe('yaml/malformed');
      }
    }

    const anyNullLine = file.cases.some((entry) =>
      entry.expected.warnings.some((warning) => warning.line === null),
    );
    expect(anyNullLine, 'the escape hatch is unused, so it should be removed').toBe(true);
  });
});
