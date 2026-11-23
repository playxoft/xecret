import { afterEach, describe, expect, it, vi } from 'vitest';

import * as route from '@/app/.well-known/security.txt/route';
import { absoluteUrl } from '@/lib/site';
import {
  SECURITY_ADVISORY_URL,
  SECURITY_EMAIL,
  SECURITY_POLICY_URL,
  SECURITY_TXT_PATH,
  securityTxt,
  securityTxtExpiry,
} from './security-contact';

/**
 * `/.well-known/security.txt` against RFC 9116.
 *
 * The file is small enough to look right by eye and still be wrong in the two
 * ways that matter: an `Expires` that has drifted out of range — past, or more
 * than a year ahead — and a field a parser does not recognise. Both make
 * scanners treat the file as absent. Whether the addresses in it agree with
 * `SECURITY.md` is pinned in `marketing-pages.test.ts`, which is allowed to
 * read the repository.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The `name: value` fields of a security.txt body, comments and blanks skipped. */
function fields(body: string): Array<[string, string]> {
  return body
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf(': ');
      return [line.slice(0, at), line.slice(at + 2)];
    });
}

function values(body: string, name: string): string[] {
  return fields(body)
    .filter(([field]) => field === name)
    .map(([, value]) => value);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('security.txt', () => {
  const NOW = new Date('2026-11-23T15:42:10.000Z');
  const body = securityTxt(NOW);

  it('uses only fields RFC 9116 defines, one per line', () => {
    const known = new Set([
      'Acknowledgments',
      'Canonical',
      'Contact',
      'Encryption',
      'Expires',
      'Hiring',
      'Policy',
      'Preferred-Languages',
    ]);
    for (const [name, value] of fields(body)) {
      expect(known.has(name), `unknown field ${name}`).toBe(true);
      expect(value.trim(), `${name} has no value`).not.toBe('');
    }
  });

  it('names both private channels as contacts, email first', () => {
    expect(values(body, 'Contact')).toEqual([`mailto:${SECURITY_EMAIL}`, SECURITY_ADVISORY_URL]);
  });

  it('states Expires and Preferred-Languages exactly once each', () => {
    // The RFC forbids either appearing more than once.
    expect(values(body, 'Expires')).toHaveLength(1);
    expect(values(body, 'Preferred-Languages')).toEqual(['en']);
  });

  it('names its canonical URL and the disclosure policy', () => {
    expect(values(body, 'Canonical')).toEqual([absoluteUrl(SECURITY_TXT_PATH)]);
    expect(values(body, 'Policy')).toEqual([SECURITY_POLICY_URL]);
    expect(SECURITY_TXT_PATH).toBe('/.well-known/security.txt');
  });

  it('writes Expires as an RFC 3339 instant in UTC', () => {
    const [expires] = values(body, 'Expires');
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  });

  it.each([
    ['the first instant of a day', '2026-11-23T00:00:00.000Z'],
    ['the last instant of a day', '2026-11-23T23:59:59.999Z'],
    ['a leap day', '2028-02-29T12:00:00.000Z'],
    ['the last day of a year', '2026-12-31T23:30:00.000Z'],
  ])('keeps Expires in the future and under a year ahead at %s', (_, at) => {
    const now = new Date(at);
    const [expires] = values(securityTxt(now), 'Expires');
    const ahead = Date.parse(expires ?? '') - now.getTime();
    expect(ahead).toBeGreaterThan(300 * DAY_MS);
    expect(ahead).toBeLessThan(365 * DAY_MS);
  });

  it('serves the same body all day, so a cache can hold it', () => {
    expect(securityTxtExpiry(new Date('2026-11-23T00:00:01Z'))).toEqual(
      securityTxtExpiry(new Date('2026-11-23T23:59:59Z')),
    );
  });
});

describe('GET /.well-known/security.txt', () => {
  it('answers 200 with the file as UTF-8 plain text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T09:00:00.000Z'));
    const response = route.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe(securityTxt(new Date('2026-11-23T09:00:00.000Z')));
  });

  it('is rendered per request, so Expires is never the build date', () => {
    expect(route.dynamic).toBe('force-dynamic');
  });
});
