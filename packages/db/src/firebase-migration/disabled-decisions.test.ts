import { describe, expect, it } from 'vitest';
import {
  describeDecision,
  DISABLED_DECISIONS_FORMAT,
  keptUids,
  parseDisabledDecisions,
  serializeDisabledDecisions,
} from './disabled-decisions';
import type { DisabledDecision } from './disabled-decisions';

const at = '2026-10-12T10:00:00.000Z';
const decisions = new Map<string, DisabledDecision>([
  [
    'fbGone',
    {
      decision: 'soft-deleted',
      userId: 'u1',
      decidedAt: at,
      revokedSessions: 2,
      revokedCliTokens: 0,
      removedFromOrgs: ['org-a'],
    },
  ],
  ['fbKept', { decision: 'kept', userId: 'u2', decidedAt: at }],
  ['fbNoRow', { decision: 'no-row', decidedAt: at }],
  ['fbWas', { decision: 'already-deleted', userId: 'u4', decidedAt: at }],
]);

describe('disabled-user decisions', () => {
  it('round-trips through its file form, sorted by uid', () => {
    const file = JSON.parse(JSON.stringify(serializeDisabledDecisions(decisions))) as {
      entries: object;
    };
    expect(file).toMatchObject({ format: DISABLED_DECISIONS_FORMAT });
    expect(Object.keys(file.entries)).toEqual(['fbGone', 'fbKept', 'fbNoRow', 'fbWas']);
    expect(parseDisabledDecisions(file)).toEqual(decisions);
  });

  it('names the kept uids, which later runs honour', () => {
    expect(keptUids(decisions)).toEqual(new Set(['fbKept']));
  });

  it('describes each decision with its date', () => {
    expect([...decisions.values()].map(describeDecision)).toEqual([
      'soft-deleted (decided 2026-10-12)',
      'kept active on purpose (decided 2026-10-12)',
      'no xecret row, nothing to lock (decided 2026-10-12)',
      'row was already soft-deleted (decided 2026-10-12)',
    ]);
  });

  const file = (entries: unknown) => ({ format: DISABLED_DECISIONS_FORMAT, entries });
  it.each([
    [{}, /Not a disabled-users decisions file/],
    [{ format: DISABLED_DECISIONS_FORMAT }, /no "entries"/],
    [file({ fb: 'kept' }), /malformed/],
    [file({ fb: { decision: 'kept', userId: 'u' } }), /"decidedAt"/],
    [file({ fb: { decision: 'kept', decidedAt: at } }), /"userId"/],
    [file({ fb: { decision: 'maybe', decidedAt: at } }), /unknown "decision"/],
    [
      file({
        fb: {
          decision: 'soft-deleted',
          userId: 'u',
          decidedAt: at,
          revokedSessions: -1,
          removedFromOrgs: [],
        },
      }),
      /"revokedSessions"/,
    ],
    [
      file({
        fb: {
          decision: 'soft-deleted',
          userId: 'u',
          decidedAt: at,
          revokedSessions: 0,
          revokedCliTokens: 0,
          removedFromOrgs: [1],
        },
      }),
      /"removedFromOrgs"/,
    ],
  ])('refuses a damaged file: %j', (json, message) => {
    expect(() => parseDisabledDecisions(json)).toThrow(message);
  });
});
