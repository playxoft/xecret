import { describe, expect, it } from 'vitest';

import {
  alertsDormant,
  exportDisabled,
  readAlertDefault,
  readAlertsOn,
  readAlertsReset,
  readAlertsSource,
  switchLock,
} from './environment-policy';
import type { PolicyFields } from './environment-policy';
import { alertState, principalKindLabel, principalLine, sightingsNotice } from './read-sightings';
import type { ReadSightingsResponse } from './read-sightings';

/**
 * The environment's two switches and the read list beside them. The rule
 * pinned throughout: the plan locks only the "on" direction of a switch that is
 * off, never a switch that is on, and an unknown plan locks nothing.
 */

/**
 * An environment's policy fields. A key given as `undefined` is *removed*, which
 * is how a test stands for a payload from a server that predates the field.
 */
function fields(over: { [K in keyof PolicyFields]?: PolicyFields[K] | undefined } = {}) {
  const merged: Record<string, unknown> = {
    isProduction: false,
    plaintextExport: 'allowed',
    readAlerts: null,
    readAlertsActive: false,
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as PolicyFields;
}

const entitled = { enabled: true, upgradeTo: null };
const notEntitled = { enabled: false, upgradeTo: 'pro' };

describe('read alerts', () => {
  it('defaults on for production and off elsewhere', () => {
    expect(readAlertDefault(true)).toBe(true);
    expect(readAlertDefault(false)).toBe(false);
  });

  it('prefers the server’s answer, and falls back to the same rule without one', () => {
    expect(readAlertsOn(fields({ readAlertsActive: true }))).toBe(true);
    expect(
      readAlertsOn(fields({ isProduction: true, readAlertsActive: undefined, readAlerts: null })),
    ).toBe(true);
    expect(readAlertsOn(fields({ readAlertsActive: undefined, readAlerts: true }))).toBe(true);
  });

  it('says where the setting comes from', () => {
    expect(readAlertsSource(fields({ isProduction: true, readAlertsActive: true }))).toMatch(
      /^On by default, because this is a production environment/,
    );
    expect(readAlertsSource(fields())).toMatch(/^Off by default/);
    expect(readAlertsSource(fields({ readAlerts: true, readAlertsActive: true }))).toBe(
      'Set on for this environment. The default for an environment outside production is off.',
    );
    expect(
      readAlertsSource(fields({ isProduction: true, readAlerts: true, readAlertsActive: true })),
    ).toMatch(/the same as the default/);
  });

  it('offers a reset only when something was set, and says when it switches alerts on', () => {
    expect(readAlertsReset(fields())).toBeNull();
    expect(readAlertsReset(fields({ readAlerts: true, readAlertsActive: true }))).toEqual({
      turnsOn: false,
    });
    expect(
      readAlertsReset(fields({ isProduction: true, readAlerts: false, readAlertsActive: false })),
    ).toEqual({ turnsOn: true });
  });

  it('notices a switch that is on while the plan delivers nothing', () => {
    expect(alertsDormant(fields({ readAlertsActive: true }), notEntitled)).toBe(true);
    expect(alertsDormant(fields({ readAlertsActive: true }), entitled)).toBe(false);
    expect(alertsDormant(fields(), notEntitled)).toBe(false);
    // Not known yet is not a "no".
    expect(alertsDormant(fields({ readAlertsActive: true }), null)).toBe(false);
  });
});

describe('the export switch', () => {
  it('reads the stored policy', () => {
    expect(exportDisabled(fields())).toBe(false);
    expect(exportDisabled(fields({ plaintextExport: 'disabled' }))).toBe(true);
    expect(exportDisabled(fields({ plaintextExport: undefined }))).toBe(false);
  });
});

describe('switchLock', () => {
  it('locks only the on direction of a switch that is off', () => {
    expect(switchLock(false, notEntitled)).toEqual({ locked: true, upgradeTo: 'pro' });
    expect(switchLock(true, notEntitled).locked).toBe(false);
    expect(switchLock(false, entitled).locked).toBe(false);
  });

  it('locks nothing while the plan is unknown', () => {
    expect(switchLock(false, null)).toEqual({ locked: false, upgradeTo: null });
  });
});

describe('read sightings', () => {
  function response(over: Partial<ReadSightingsResponse> = {}): ReadSightingsResponse {
    return {
      sightings: [],
      alerts: { active: true, entitled: true, upgradeTo: null },
      ...over,
    };
  }

  const sighting = {
    id: 's1',
    principalKind: 'cli_token' as const,
    principalLabel: 'ada@example.com (laptop)',
    address: '203.0.113.7',
    firstSeenAt: '2026-10-19T10:00:00.000Z',
    lastSeenAt: '2026-10-20T09:00:00.000Z',
    notifiedAt: null,
  };

  it('labels each kind of credential, and an unknown one without breaking', () => {
    expect(principalKindLabel('user')).toBe('Browser session');
    expect(principalKindLabel('cli_token')).toBe('CLI device');
    expect(principalKindLabel('service_token')).toBe('Service token');
    expect(principalKindLabel('robot')).toBe('Credential');
  });

  it('names who read, or what, when the label is gone', () => {
    expect(principalLine(sighting)).toEqual({
      who: 'ada@example.com (laptop)',
      kind: 'CLI device',
    });
    expect(principalLine({ principalKind: 'service_token', principalLabel: null }).who).toBe(
      'Unnamed service token',
    );
  });

  it('tells a sent alert from one waiting for the digest', () => {
    expect(alertState(sighting)).toBe('pending');
    expect(alertState({ notifiedAt: '2026-10-20T09:01:00.000Z' })).toBe('sent');
  });

  it('explains each reason the list can be empty, plan first', () => {
    expect(
      sightingsNotice(response({ alerts: { active: true, entitled: false, upgradeTo: 'pro' } }))
        ?.kind,
    ).toBe('unentitled');
    expect(
      sightingsNotice(response({ alerts: { active: false, entitled: true, upgradeTo: null } }))
        ?.kind,
    ).toBe('inactive');
    expect(sightingsNotice(response())?.kind).toBe('empty');
    expect(sightingsNotice(response({ sightings: [sighting] }))).toBeNull();
  });

  it('keeps what was seen when recording has stopped, and says so', () => {
    const notice = sightingsNotice(
      response({
        sightings: [sighting],
        alerts: { active: false, entitled: true, upgradeTo: null },
      }),
    );
    expect(notice?.text).toMatch(/kept below/);
  });
});
