import { describe, expect, it } from 'vitest';

import {
  CLI_HEADLINE_HEADER,
  CLI_LATEST_HEADER,
  CLI_LATEST_HEADLINE,
  CLI_LATEST_VERSION,
  isCliUserAgent,
} from './cli-release';

describe('the advertised CLI release', () => {
  it('is plain dotted numbers with no v prefix', () => {
    // The CLI compares it with `compareVersions`, which reads three numeric
    // fields. A `v` prefix or a build-metadata suffix would compare as older
    // than every real version and nag every user for ever.
    expect(CLI_LATEST_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  /**
   * An HTTP header value is a byte string. `Headers.set` encodes it as
   * ISO-8859-1, so a character outside that range — an em dash, a curly
   * apostrophe, any of the punctuation this codebase's prose uses everywhere
   * else — is mangled or rejected at the edge rather than here.
   *
   * ASCII rather than Latin-1 because the failure is silent and remote: it
   * would not appear in a test, or in `next dev`, but in a user's terminal as
   * a header that never arrived.
   */
  it('carries a headline that survives an HTTP header', () => {
    expect(CLI_LATEST_HEADLINE).toMatch(/^[\x20-\x7E]*$/);
    expect(CLI_LATEST_HEADLINE.length).toBeGreaterThan(0);
  });

  it('keeps the headline to one readable line', () => {
    // Rendered inside a three-line notice that has to stay smaller than the
    // output it follows. The CLI wraps it, but wrapping a paragraph still
    // produces a paragraph.
    expect(CLI_LATEST_HEADLINE.length).toBeLessThanOrEqual(160);
    expect(CLI_LATEST_HEADLINE).not.toContain('\n');
  });

  it('round-trips through a real Headers object unchanged', () => {
    const headers = new Headers();
    headers.set(CLI_LATEST_HEADER, CLI_LATEST_VERSION);
    headers.set(CLI_HEADLINE_HEADER, CLI_LATEST_HEADLINE);

    expect(headers.get(CLI_LATEST_HEADER)).toBe(CLI_LATEST_VERSION);
    expect(headers.get(CLI_HEADLINE_HEADER)).toBe(CLI_LATEST_HEADLINE);
  });
});

describe('isCliUserAgent', () => {
  it('recognises the CLI', () => {
    // The shape `cli/cmd/xecret/app.go` builds.
    expect(isCliUserAgent('xecret-cli/0.1.2 (windows/amd64)')).toBe(true);
    expect(isCliUserAgent('xecret-cli/dev (linux/arm64)')).toBe(true);
  });

  it('does not spend the headers on anything else', () => {
    expect(isCliUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    expect(isCliUserAgent('curl/8.4.0')).toBe(false);
    expect(isCliUserAgent(null)).toBe(false);
    // Near misses, so the prefix test is not accidentally a substring test.
    expect(isCliUserAgent('my-xecret-cli/1.0')).toBe(false);
    expect(isCliUserAgent('xecret/0.1.2')).toBe(false);
  });
});
