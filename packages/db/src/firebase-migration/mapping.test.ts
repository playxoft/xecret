import { describe, expect, it } from 'vitest';
import {
  emptyUserMapping,
  MAPPING_FORMAT,
  parseUserMapping,
  serializeUserMapping,
  withMappingEntry,
} from './mapping';
import type { MappingEntry } from './mapping';

const CLIENT = 'client_01TEST';

const entry = (over: Partial<MappingEntry> = {}): MappingEntry => ({
  workosUserId: 'user_01AAA',
  outcome: 'created',
  passwordImported: true,
  recordedAt: '2026-10-12T00:00:00.000Z',
  ...over,
});

describe('user mapping', () => {
  it('round-trips through its file form', () => {
    const mapping = withMappingEntry(
      withMappingEntry(
        emptyUserMapping('production', CLIENT),
        'uidB',
        entry({ workosUserId: 'user_02' }),
      ),
      'uidA',
      entry(),
    );
    const file = serializeUserMapping(mapping, '2026-10-12T01:00:00.000Z');
    expect(file).toMatchObject({
      format: MAPPING_FORMAT,
      environment: 'production',
      clientId: CLIENT,
    });
    // Sorted by uid, so two runs over the same users write the same file.
    expect(Object.keys((file as { entries: object }).entries)).toEqual(['uidA', 'uidB']);
    const back = parseUserMapping(JSON.parse(JSON.stringify(file)));
    expect(back.environment).toBe('production');
    expect(back.clientId).toBe(CLIENT);
    expect([...back.entries]).toEqual([...mapping.entries].sort(([a], [b]) => a.localeCompare(b)));
  });

  it('a re-run that finds the same user keeps what the first run recorded', () => {
    const first = withMappingEntry(emptyUserMapping('staging', CLIENT), 'uidA', entry());
    const again = withMappingEntry(
      first,
      'uidA',
      entry({ outcome: 'already-imported', passwordImported: null, recordedAt: 'later' }),
    );
    expect(again.entries.get('uidA')).toEqual(entry());
  });

  it('a re-run learns the password state when the first run could not tell', () => {
    const first = withMappingEntry(
      emptyUserMapping('staging', CLIENT),
      'uidA',
      entry({ outcome: 'already-imported', passwordImported: null }),
    );
    const again = withMappingEntry(
      first,
      'uidA',
      entry({ outcome: 'already-imported', passwordImported: false }),
    );
    expect(again.entries.get('uidA')?.passwordImported).toBe(false);
  });

  it('a different WorkOS id for the same uid replaces the entry', () => {
    const first = withMappingEntry(emptyUserMapping('staging', CLIENT), 'uidA', entry());
    const again = withMappingEntry(
      first,
      'uidA',
      entry({ workosUserId: 'user_01BBB', outcome: 'already-imported' }),
    );
    expect(again.entries.get('uidA')).toMatchObject({
      workosUserId: 'user_01BBB',
      outcome: 'already-imported',
    });
  });

  it('is created only for a WorkOS client id', () => {
    expect(() => emptyUserMapping('staging', 'not-a-client')).toThrow(/Not a WorkOS client id/);
  });

  it('refuses two uids mapped to one WorkOS user', () => {
    const first = withMappingEntry(emptyUserMapping('staging', CLIENT), 'uidA', entry());
    expect(() => withMappingEntry(first, 'uidB', entry())).toThrow(
      /mapped from both uidA and uidB/,
    );
    expect(() =>
      parseUserMapping({
        format: MAPPING_FORMAT,
        environment: 'staging',
        clientId: CLIENT,
        entries: { uidA: entry(), uidB: entry() },
      }),
    ).toThrow(/mapped from both/);
  });

  it.each([
    [{}, /Not a user mapping file/],
    [{ format: MAPPING_FORMAT, environment: 'prod', entries: {} }, /no valid "environment"/],
    [{ format: MAPPING_FORMAT, environment: 'staging', entries: {} }, /no valid "clientId"/],
    [
      { format: MAPPING_FORMAT, environment: 'staging', clientId: 'sk_test_x', entries: {} },
      /no valid "clientId"/,
    ],
    [{ format: MAPPING_FORMAT, environment: 'staging', clientId: CLIENT }, /no "entries" object/],
    [
      {
        format: MAPPING_FORMAT,
        environment: 'staging',
        clientId: CLIENT,
        entries: { uidA: entry({ workosUserId: 'fbUid' }) },
      },
      /does not hold a WorkOS user id/,
    ],
    [
      {
        format: MAPPING_FORMAT,
        environment: 'staging',
        clientId: CLIENT,
        entries: { uidA: { ...entry(), outcome: 'guessed' } },
      },
      /unknown outcome/,
    ],
    [
      {
        format: MAPPING_FORMAT,
        environment: 'staging',
        clientId: CLIENT,
        entries: { uidA: { ...entry(), passwordImported: 'yes' } },
      },
      /malformed "passwordImported"/,
    ],
    [
      {
        format: MAPPING_FORMAT,
        environment: 'staging',
        clientId: CLIENT,
        entries: { uidA: { ...entry(), recordedAt: 1 } },
      },
      /no "recordedAt"/,
    ],
    [
      {
        format: MAPPING_FORMAT,
        environment: 'staging',
        clientId: CLIENT,
        entries: { uidA: 'user_01' },
      },
      /malformed/,
    ],
  ])('refuses a damaged file: %j', (json, message) => {
    expect(() => parseUserMapping(json)).toThrow(message);
  });
});
