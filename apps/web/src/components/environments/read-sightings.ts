/**
 * The new-address read list (P19 §7), as `GET …/read-sightings` answers it, and
 * the words the dashboard puts around it.
 *
 * Mirrors `SightingPayload` in `server/read-alerts.ts`, restated for the usual
 * reason: that module imports the repositories and the mailer.
 *
 * ── What one row is ──
 * One (principal, address) pair that has read this environment: the *person*
 * for a browser session, the *device* for a CLI login, the token for CI. An
 * IPv6 address arrives as its /64 — the unit one host's privacy addresses
 * rotate within — so a laptop is one row, not one a day.
 */

export type SightingPrincipalKind = 'user' | 'cli_token' | 'service_token';

export interface ReadSighting {
  id: string;
  principalKind: SightingPrincipalKind;
  /** An email, `email (device)`, or a token name. `null` when it could not be resolved. */
  principalLabel: string | null;
  /** A v4 address, or a v6 /64. */
  address: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** When an alert covering it went out — or was cleared unsent — or `null` while one is owed. */
  notifiedAt: string | null;
}

export interface ReadSightingsResponse {
  sightings: readonly ReadSighting[];
  alerts: {
    /** Whether this environment's reads are noted at all: its switch, else production only. */
    active: boolean;
    /** Whether the plan includes the alert. */
    entitled: boolean;
    upgradeTo: string | null;
  };
}

const KIND_LABELS: Readonly<Record<SightingPrincipalKind, string>> = {
  user: 'Browser session',
  cli_token: 'CLI device',
  service_token: 'Service token',
};

/**
 * What kind of credential read from the address, as a person says it.
 *
 * An unknown kind — a server newer than this build — is shown as "Credential"
 * rather than as an identifier, so a kind added later can never break the
 * list's render.
 */
export function principalKindLabel(kind: string): string {
  return Object.hasOwn(KIND_LABELS, kind)
    ? KIND_LABELS[kind as SightingPrincipalKind]
    : 'Credential';
}

/**
 * Who read, as one line: the label the server resolved, or the kind alone.
 *
 * A label can be missing — a token deleted since, a user record gone — and the
 * row is still worth showing: "a service token read production from an address
 * nobody recognises" is the whole point of the list, with or without a name.
 */
export function principalLine(sighting: Pick<ReadSighting, 'principalKind' | 'principalLabel'>): {
  who: string;
  kind: string;
} {
  const kind = principalKindLabel(sighting.principalKind);
  const label = sighting.principalLabel?.trim();
  return {
    who: label === undefined || label === '' ? `Unnamed ${kind.toLowerCase()}` : label,
    kind,
  };
}

/**
 * Whether the alert covering a sighting has gone out.
 *
 * `notifiedAt === null` means owed: the organisation was mailed in the last
 * hour, and this one waits for the hourly digest. It is never "will not be
 * sent" — a sighting recorded at all is one the plan covered.
 */
export function alertState(sighting: Pick<ReadSighting, 'notifiedAt'>): 'sent' | 'pending' {
  return sighting.notifiedAt === null ? 'pending' : 'sent';
}

/**
 * Why the list is empty, or why it is not growing.
 *
 * Three different answers, fixed by different people: the switch is off here
 * (an owner or admin, two lines up), the plan does not include the alert (the
 * plan), or nothing new has read the environment yet (nobody — that is good
 * news). `null` when the list is live and has nothing to explain.
 */
export function sightingsNotice(
  response: ReadSightingsResponse,
): { kind: 'inactive' | 'unentitled' | 'empty'; text: string } | null {
  const { alerts, sightings } = response;

  if (!alerts.entitled) {
    return {
      kind: 'unentitled',
      text:
        sightings.length > 0
          ? 'The plan no longer includes read alerts, so nothing new is recorded. What was seen before is kept below.'
          : 'Nothing is recorded while the plan does not include read alerts.',
    };
  }
  if (!alerts.active) {
    return {
      kind: 'inactive',
      text:
        sightings.length > 0
          ? 'Alerts are off for this environment, so nothing new is recorded. What was seen while they were on is kept below.'
          : 'Alerts are off for this environment, so its reads are not recorded. Switch them on above to start.',
    };
  }
  if (sightings.length === 0) {
    return {
      kind: 'empty',
      text: 'No reads of this environment have been recorded yet. The first read from each address or device will appear here.',
    };
  }
  return null;
}
