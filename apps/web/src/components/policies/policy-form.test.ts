import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SECRET_POLICY,
  DEFAULT_TOKEN_POLICY,
  MAX_TOKEN_LIFETIME_DAYS,
} from '@xecret/core/policy';
import type { SecretPolicy, TokenPolicy } from '@xecret/core/policy';
import { parseWith } from '@/server/http';
import { orgPoliciesPatchSchema } from '@/server/schemas/policies';
import { secretPolicyChangeNeedsPlan as serverNeedsPlan } from '@/server/policies-service';
import {
  expiryAfterDays,
  fieldProblemsUnder,
  IP_ALLOWLIST_MAX_ENTRIES,
  outsidePolicySentence,
  parseIpAllowlist,
  parseList,
  parseSecretPolicyDraft,
  parseTokenPolicyDraft,
  parseTokenScope,
  secretPolicyBlocked,
  secretPolicyChangeNeedsPlan,
  secretPolicyDraftOf,
  storedSecretPolicyProblem,
  tokenPolicyBlocked,
  tokenPolicyDraftOf,
  tokenPolicyGaps,
  tokenScopeDraftFor,
  withDefaultRules,
} from './policy-form';

/**
 * The policy forms' decisions, without rendering anything.
 *
 * Two kinds of assertion. The round trips — form to policy and back — are run
 * through the server's own `orgPoliciesPatchSchema`, the way the env-key tests
 * pin their bodies: a form that builds a policy the PATCH route refuses would
 * pass every test that only looked at the form. And the plan rules are compared
 * against the server's function directly, because "Save is disabled" and "the
 * server refuses" have to be the same answer or the card lies in one direction.
 */

const NOW = new Date('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;
const ENTITLED = { enabled: true, upgradeTo: null };
const LOCKED = { enabled: false, upgradeTo: 'team' };

const ON: SecretPolicy = { ...DEFAULT_SECRET_POLICY, enabled: true };

describe('the token policy form', () => {
  it('round-trips a stored policy into a body the PATCH route accepts', () => {
    const stored: TokenPolicy = { requireIpAllowlist: true, maxLifetimeDays: 30 };
    const parsed = parseTokenPolicyDraft(tokenPolicyDraftOf(stored));
    expect(parsed).toEqual({ ok: true, policy: stored });
    if (!parsed.ok) return;
    expect(parseWith(orgPoliciesPatchSchema, { tokens: parsed.policy }).tokens).toEqual(stored);
  });

  it('keeps no cap as null, and offers a starting value for one', () => {
    const draft = tokenPolicyDraftOf(DEFAULT_TOKEN_POLICY);
    expect(draft.capLifetime).toBe(false);
    expect(draft.maxLifetimeDays).toBe('90');
    expect(parseTokenPolicyDraft(draft)).toEqual({
      ok: true,
      policy: { requireIpAllowlist: false, maxLifetimeDays: null },
    });
  });

  it.each(['0', '-3', '1.5', 'ten', '', String(MAX_TOKEN_LIFETIME_DAYS + 1)])(
    'refuses a cap of %j under its own field',
    (typed) => {
      const parsed = parseTokenPolicyDraft({
        requireIpAllowlist: false,
        capLifetime: true,
        maxLifetimeDays: typed,
      });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.field).toBe('maxLifetimeDays');
    },
  );

  it('locks only a tightening, and only without the feature', () => {
    const stored: TokenPolicy = { requireIpAllowlist: true, maxLifetimeDays: 30 };
    // Loosening: switching the allowlist off, raising or removing the cap.
    expect(tokenPolicyBlocked(stored, { ...stored, requireIpAllowlist: false }, LOCKED)).toBe(
      false,
    );
    expect(tokenPolicyBlocked(stored, { ...stored, maxLifetimeDays: 90 }, LOCKED)).toBe(false);
    expect(tokenPolicyBlocked(stored, { ...stored, maxLifetimeDays: null }, LOCKED)).toBe(false);
    // Tightening.
    expect(tokenPolicyBlocked(stored, { ...stored, maxLifetimeDays: 7 }, LOCKED)).toBe(true);
    expect(
      tokenPolicyBlocked(
        DEFAULT_TOKEN_POLICY,
        { ...DEFAULT_TOKEN_POLICY, requireIpAllowlist: true },
        LOCKED,
      ),
    ).toBe(true);
    // And never with the feature.
    expect(tokenPolicyBlocked(stored, { ...stored, maxLifetimeDays: 7 }, ENTITLED)).toBe(false);
  });
});

describe('the secret policy form', () => {
  it('round-trips the defaults into a body the PATCH route accepts', () => {
    const parsed = parseSecretPolicyDraft(secretPolicyDraftOf(ON));
    expect(parsed).toEqual({ ok: true, policy: ON });
    if (!parsed.ok) return;
    expect(parseWith(orgPoliciesPatchSchema, { secrets: parsed.policy }).secrets).toEqual(ON);
  });

  it('keeps a pattern that was switched off, so ticking it again brings it back', () => {
    const off: SecretPolicy = { ...ON, namePattern: null, minValueEntropyBits: null };
    const draft = secretPolicyDraftOf(off);
    expect(draft.useNamePattern).toBe(false);
    expect(draft.namePattern).toBe(DEFAULT_SECRET_POLICY.namePattern);
    const parsed = parseSecretPolicyDraft(draft);
    expect(parsed.ok && parsed.policy.namePattern).toBeNull();
    expect(parsed.ok && parsed.policy.minValueEntropyBits).toBeNull();
  });

  it('reads one entry per line, trimmed, blank lines dropped, each once', () => {
    expect(parseList('  SECRET \n\nTOKEN\r\nSECRET\n  ')).toEqual(['SECRET', 'TOKEN']);
    // A comma is part of an entry, not a separator.
    expect(parseList('a,b\nc')).toEqual(['a,b', 'c']);
  });

  it('refuses a pattern that does not compile, under the pattern field', () => {
    const parsed = parseSecretPolicyDraft({ ...secretPolicyDraftOf(ON), namePattern: '[A-Z' });
    expect(parsed).toMatchObject({ ok: false, field: 'namePattern' });
  });

  it('refuses a pattern that could backtrack', () => {
    const parsed = parseSecretPolicyDraft({ ...secretPolicyDraftOf(ON), namePattern: '(A+)+' });
    expect(parsed).toMatchObject({ ok: false, field: 'namePattern' });
  });

  it('refuses entropy out of range, under the entropy field', () => {
    for (const typed of ['0', '513', 'lots', '']) {
      const parsed = parseSecretPolicyDraft({
        ...secretPolicyDraftOf(ON),
        minValueEntropyBits: typed,
      });
      expect(parsed).toMatchObject({ ok: false, field: 'minValueEntropyBits' });
    }
  });

  it('uses the default rules without switching the policy off', () => {
    const custom = secretPolicyDraftOf({
      ...ON,
      scope: 'production',
      namePattern: 'X_.*',
      forbiddenSubstrings: ['hunter2'],
    });
    const reset = withDefaultRules(custom);
    expect(reset.enabled).toBe(true);
    expect(reset.scope).toBe('production');
    expect(reset.namePattern).toBe(DEFAULT_SECRET_POLICY.namePattern);
    expect(parseList(reset.forbiddenSubstrings)).toEqual(DEFAULT_SECRET_POLICY.forbiddenSubstrings);
  });

  it('agrees with the server about which changes need the plan', () => {
    const cases: [SecretPolicy, SecretPolicy][] = [
      [DEFAULT_SECRET_POLICY, ON], // switching it on
      [ON, { ...ON, namePattern: 'Y.*' }], // editing it while on
      [ON, { ...ON, enabled: false }], // switching it off
      [DEFAULT_SECRET_POLICY, { ...DEFAULT_SECRET_POLICY, namePattern: 'Z.*' }], // editing it while off
      [ON, ON], // saving it unchanged
    ];
    for (const [current, next] of cases) {
      expect(secretPolicyChangeNeedsPlan(current, next)).toBe(serverNeedsPlan(current, next));
    }
    expect(secretPolicyBlocked(ON, { ...ON, enabled: false }, LOCKED)).toBe(false);
    expect(secretPolicyBlocked(ON, { ...ON, namePattern: 'Y.*' }, LOCKED)).toBe(true);
    expect(secretPolicyBlocked(ON, { ...ON, namePattern: 'Y.*' }, ENTITLED)).toBe(false);
    expect(secretPolicyBlocked(DEFAULT_SECRET_POLICY, ON, LOCKED)).toBe(true);
  });

  it('reports a stored pattern this engine cannot compile, and is quiet about a good one', () => {
    expect(storedSecretPolicyProblem(ON)).toBeNull();
    expect(storedSecretPolicyProblem({ ...ON, namePattern: '(?<' })).not.toBeNull();
  });
});

describe('field problems under a prefix', () => {
  it('maps the policy route’s secrets.* fields, and a list entry’s index, to the form field', () => {
    expect(
      fieldProblemsUnder(
        [
          { field: 'secrets.namePattern', message: 'Bad pattern.' },
          { field: 'tokens.maxLifetimeDays', message: 'Not this one.' },
        ],
        'secrets',
      ),
    ).toEqual({ namePattern: 'Bad pattern.' });

    expect(
      fieldProblemsUnder(
        [
          { field: 'ipAllowlist.3', message: 'Enter an IP address or CIDR range.' },
          { field: 'ipAllowlist.4', message: 'A second one.' },
          { field: 'expiresAt', message: 'Too far.' },
        ],
        '',
      ),
    ).toEqual({ ipAllowlist: 'Enter an IP address or CIDR range.', expiresAt: 'Too far.' });
  });
});

describe('the token dialog’s policy fields', () => {
  it('reads addresses and ranges separated by commas, spaces or lines, each once', () => {
    expect(parseIpAllowlist('203.0.113.4, 198.51.100.0/24\n2001:db8::/32 203.0.113.4')).toEqual({
      ok: true,
      entries: ['203.0.113.4', '198.51.100.0/24', '2001:db8::/32'],
    });
    expect(parseIpAllowlist('   ')).toEqual({ ok: true, entries: [] });
  });

  it('refuses a host name, naming the entry', () => {
    const parsed = parseIpAllowlist('203.0.113.4, ci.example.com');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('ci.example.com');
  });

  it('refuses more entries than the server stores', () => {
    const many = Array.from({ length: IP_ALLOWLIST_MAX_ENTRIES + 1 }, (_, i) => `10.0.0.${i}`);
    expect(parseIpAllowlist(many.join(',')).ok).toBe(false);
  });

  it('pre-fills the expiry at the cap, and needs nothing without a policy', () => {
    expect(tokenScopeDraftFor({ requireIpAllowlist: false, maxLifetimeDays: 30 })).toEqual({
      ipAllowlist: '',
      expires: true,
      expiresInDays: '30',
    });
    expect(tokenScopeDraftFor(null).expires).toBe(false);
    expect(parseTokenScope(tokenScopeDraftFor(null), null, NOW)).toEqual({
      ok: true,
      scope: { ipAllowlist: [], expiresAt: null },
    });
  });

  it('refuses an empty allowlist where the policy requires one, before anything is minted', () => {
    const policy: TokenPolicy = { requireIpAllowlist: true, maxLifetimeDays: null };
    const parsed = parseTokenScope(tokenScopeDraftFor(policy), policy, NOW);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.ipAllowlist).toMatch(/requires every service token/);
    expect(parsed.errors.expiresAt).toBeUndefined();
  });

  it('refuses no expiry, or a longer one, under a lifetime cap', () => {
    const policy: TokenPolicy = { requireIpAllowlist: false, maxLifetimeDays: 30 };
    const never = parseTokenScope(
      { ipAllowlist: '', expires: false, expiresInDays: '30' },
      policy,
      NOW,
    );
    expect(never.ok).toBe(false);
    if (!never.ok) expect(never.errors.expiresAt).toMatch(/expire within 30 days/);

    const longer = parseTokenScope(
      { ipAllowlist: '', expires: true, expiresInDays: '31' },
      policy,
      NOW,
    );
    expect(longer.ok).toBe(false);
    if (!longer.ok) expect(longer.errors.expiresAt).toMatch(/30 days/);
  });

  it('mints at the cap a minute short of it, inside the server’s own check', () => {
    const policy: TokenPolicy = { requireIpAllowlist: true, maxLifetimeDays: 30 };
    const parsed = parseTokenScope(
      { ipAllowlist: '203.0.113.4', expires: true, expiresInDays: '30' },
      policy,
      NOW,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.scope.ipAllowlist).toEqual(['203.0.113.4']);
    const expiresAt = Date.parse(parsed.scope.expiresAt ?? '');
    expect(expiresAt).toBe(NOW.getTime() + 30 * DAY - 60_000);
    // Below the cap there is no margin to take.
    expect(expiryAfterDays(7, NOW, 30).getTime()).toBe(NOW.getTime() + 7 * DAY);
  });
});

describe('the marker on a token outside the policy', () => {
  const policy: TokenPolicy = { requireIpAllowlist: true, maxLifetimeDays: 30 };

  it('says which rule, measuring a lifetime from creation as the server does', () => {
    expect(
      tokenPolicyGaps(policy, { ipAllowlist: null, expiresAt: null, createdAt: NOW.toISOString() }),
    ).toEqual(['has no IP allowlist', 'never expires']);

    const created = new Date(NOW.getTime() - 100 * DAY).toISOString();
    expect(
      tokenPolicyGaps(policy, {
        ipAllowlist: ['10.0.0.1'],
        // Expires in a week, but was minted 100 days ago: a 107-day lifetime.
        expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
        createdAt: created,
      }),
    ).toEqual(['lives longer than 30 days']);

    expect(
      tokenPolicyGaps(policy, {
        ipAllowlist: ['10.0.0.1'],
        expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
        createdAt: NOW.toISOString(),
      }),
    ).toEqual([]);
  });

  it('says the token keeps working', () => {
    expect(outsidePolicySentence(['never expires'])).toMatch(/never expires.*keeps working/);
  });
});
