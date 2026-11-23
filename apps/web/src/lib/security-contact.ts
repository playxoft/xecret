import { absoluteUrl, REPO_URL } from '@/lib/site';

/**
 * How to reach us about a vulnerability, in one place.
 *
 * Three surfaces state it: `SECURITY.md` at the repository root (the policy
 * itself), the `/security` page, and `/.well-known/security.txt`, which is what
 * a researcher's tooling reads before a human ever opens a page. A disclosure
 * address that differs between two of them is the one typo that sends a report
 * about a production credential store to nobody, so the page and the file read
 * these constants, and `marketing-pages.test.ts` fails when `SECURITY.md`
 * stops agreeing with them.
 */

/** The private mailbox for security reports. */
export const SECURITY_EMAIL = 'security@playxoft.com';

/** Opens a private GitHub security advisory on the repository. */
export const SECURITY_ADVISORY_URL = `${REPO_URL}/security/advisories/new`;

/** The disclosure policy, as published in the repository. */
export const SECURITY_POLICY_URL = `${REPO_URL}/blob/main/SECURITY.md`;

/** Where RFC 9116 says the file lives. */
export const SECURITY_TXT_PATH = '/.well-known/security.txt';

/**
 * What `SECURITY.md` commits to, row for row and word for word.
 *
 * The labels and values are the policy's own table cells, so the test can
 * look each row up in the file rather than trusting a paraphrase.
 */
export const DISCLOSURE_COMMITMENTS = [
  { label: 'Acknowledgement', value: 'within 48 hours' },
  { label: 'Initial assessment', value: 'within 5 working days' },
  { label: 'Fix or mitigation plan', value: 'within 30 days for high severity' },
  { label: 'Public disclosure', value: 'coordinated with you, after a fix ships' },
] as const;

/** A commitment's value, looked up by its label rather than by its position in the table. */
export function disclosureCommitment(
  label: (typeof DISCLOSURE_COMMITMENTS)[number]['label'],
): string {
  const row = DISCLOSURE_COMMITMENTS.find((commitment) => commitment.label === label);
  if (row === undefined) throw new Error(`No disclosure commitment labelled ${label}`);
  return row.value;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead `Expires` is set.
 *
 * RFC 9116 §2.5.5 asks for less than a year, so that an abandoned file goes
 * stale rather than pointing researchers at a mailbox nobody reads. Counted
 * from the start of the current UTC day, so the value is under a year ahead
 * at every moment of that day and the body is identical for the whole of it —
 * which is what lets a cache hold it.
 */
export const SECURITY_TXT_VALID_DAYS = 364;

/** The `Expires` instant for a file served at `now`. */
export function securityTxtExpiry(now: Date): Date {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(startOfDay + SECURITY_TXT_VALID_DAYS * DAY_MS);
}

/**
 * The body of `/.well-known/security.txt` (RFC 9116), as served at `now`.
 *
 * Computed per request rather than written into the repository: a literal
 * `Expires` date is correct on the day it is committed and wrong a year later,
 * with nothing in the build to notice. Contacts are listed in order of
 * preference, as the RFC reads them.
 */
export function securityTxt(now: Date): string {
  return [
    '# Security contact for xecret. Report a vulnerability privately to either',
    '# address below; please never in a public GitHub issue.',
    `Contact: mailto:${SECURITY_EMAIL}`,
    `Contact: ${SECURITY_ADVISORY_URL}`,
    `Expires: ${securityTxtExpiry(now).toISOString()}`,
    'Preferred-Languages: en',
    `Canonical: ${absoluteUrl(SECURITY_TXT_PATH)}`,
    `Policy: ${SECURITY_POLICY_URL}`,
    '',
  ].join('\n');
}
