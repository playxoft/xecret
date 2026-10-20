import type { SightingPrincipalKind } from '@xecret/db/schema';
import {
  claimReadAlertDigest,
  findOrganizationById,
  findUserById,
  listAdministratorAddresses,
  listOrgsOwedReadAlerts,
  loadEntitlements,
  recordReadSighting,
  takeOwedSightings,
} from '@xecret/db/repositories';
import type { OwedSighting, SightingRecord } from '@xecret/db/repositories';
import type { Principal } from './actor';
import { publicOrigin } from './bindings';
import type { ServiceContext } from './context';
import { describeError } from './logging';
import { describeMailFailure, mailerFrom } from './mail';
import { readAlertDigestMail } from './notification-mail';
import type { ReadAlertSighting } from './notification-mail';
import { readAlertsActive } from './schemas/resources';
import type { EnvironmentScope } from './tenancy';

/**
 * New-location read alerts (P19 §7): the first read of an environment from an
 * address — or by a device — nobody had seen read it before is told to the
 * organisation's owners and admins.
 *
 * ── A read is never slower, and never refused, for being noted ──
 * `noteEnvironmentRead` is synchronous and cannot throw. Everything it does —
 * resolving a label, the upsert, the throttle, the mail — runs after the
 * response, in `services.waitUntil`. It sits on the pull, the export and the
 * reveal, the hottest paths in the product, and the only cost it may add to
 * them is a few comparisons of facts the request already holds: the address,
 * the plan, and the environment's switch. A read the plan does not cover, or an
 * environment with alerts off, costs nothing more than that.
 *
 * ── What counts as "new" ──
 * One (environment, principal, address) triple, recorded in
 * `environment_read_sightings` (migration 0030). The principal is the *device*
 * for a CLI login and a CI token — each login and each token is its own row —
 * and the *person* for a browser session, so a new laptop is a new sighting and
 * a new browser tab is not. An IPv6 address is recorded as its /64 — the unit a
 * single host's privacy addresses rotate within, so one laptop is one sighting
 * rather than one a day — and an IPv4 address whole; a v4 address reaching us
 * as v4-mapped v6 is recorded as the v4 address it is.
 *
 * ── One mail an hour, at most ──
 * A new sighting mails immediately only if the organisation has not been
 * mailed in the last hour (`claimReadAlertDigest`, one statement, so two reads
 * arriving together send one mail). Otherwise it waits, owed, for the
 * five-minute sweep, which sends one digest per organisation once its hour is
 * up. A CI fleet on rotating addresses therefore produces one email an hour
 * listing them, never one per runner.
 *
 * ── What a digest says ──
 * Where and by whom — project and environment slugs, whether it is production,
 * the reader's email or token name, the address, when — and where to switch
 * the alerts off. Never a secret's name or value: this mail goes to an inbox,
 * and the question it answers is "was that us?", not "what was read?".
 */

/** The throttle: at most one alert mail per organisation per this long. */
export const READ_ALERT_DIGEST_INTERVAL_MS = 60 * 60_000;

/** Sightings one digest lists. More wait for the next one, an hour later. */
export const READ_ALERT_DIGEST_SIZE = 50;

/** Organisations one sweep serves. The rest are served five minutes later. */
export const READ_ALERT_SWEEP_ORGS = 50;

/**
 * How many owed sightings of an organisation no longer entitled are cleared per
 * sweep. Bounded so one run is bounded; the backlog is only what was owed at
 * the downgrade, because nothing is recorded after it.
 */
const UNENTITLED_DRAIN = 1000;

const RECIPIENT_LIMIT = 20;

/**
 * Notes that `principal` read `scope.environment` from this request's address.
 *
 * Skips — synchronously, at no cost — when the address is unknown, when the
 * plan does not include `newIpReadAlerts`, or when the environment's alerts are
 * off (`readAlertsActive`: its own setting, else on for production only).
 */
export function noteEnvironmentRead(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
): void {
  try {
    const ip = services.meta.ipAddress;
    if (ip === null) return;
    if (!scope.entitlements.features.newIpReadAlerts) return;
    if (!readAlertsActive(scope.environment)) return;

    const address = normaliseReadAddress(ip);
    if (address === null) return;

    services.waitUntil(
      noteNow(scope, services, principal, address).catch((cause: unknown) => {
        services.log
          .at('readAlerts')
          .error('Could not record a read sighting; the read itself was unaffected', {
            environmentId: scope.environment.id,
            error: describeError(cause),
          });
      }),
    );
  } catch (cause) {
    try {
      services.log
        .at('readAlerts')
        .error('Could not schedule a read sighting', { error: describeError(cause) });
    } catch {
      // A logger that throws has nothing left to report to.
    }
  }
}

async function noteNow(
  scope: EnvironmentScope,
  services: ServiceContext,
  principal: Principal,
  address: string,
): Promise<void> {
  const orgId = scope.organization.id;
  const who = await sightingPrincipalOf(services, principal);

  const { isNew } = await recordReadSighting(services.db, {
    orgId,
    environmentId: scope.environment.id,
    principalKind: who.kind,
    principalId: who.id,
    principalLabel: who.label,
    ipAddress: address,
  });
  if (!isNew) return;

  const claimed = await claimReadAlertDigest(
    services.db,
    orgId,
    new Date(Date.now() - READ_ALERT_DIGEST_INTERVAL_MS),
  );
  // Mailed within the hour: this sighting stays owed, and the sweep includes
  // it in the next digest once the hour is up.
  if (!claimed) return;

  await sendDigest(services, scope.organization);
}

/**
 * Who read, as a sighting records them.
 *
 *  - A browser session: the person — kind `user`, their id, their email.
 *  - A CLI login: the device — kind `cli_token`, the login's own token id, and
 *    the person's email with the device's name. The CLI principal carries the
 *    user id and not the email, so this is the one case that costs a lookup,
 *    after the response.
 *  - A service token: the token — its id and its name.
 */
async function sightingPrincipalOf(
  services: ServiceContext,
  principal: Principal,
): Promise<{ kind: SightingPrincipalKind; id: string; label: string | null }> {
  switch (principal.kind) {
    case 'user':
      return { kind: 'user', id: principal.user.id, label: principal.user.email };
    case 'cliToken': {
      const user = await findUserById(services.db, principal.userId);
      const device = principal.tokenName.trim();
      const label =
        user === null
          ? `${device === '' ? 'CLI' : device} (CLI)`
          : device === ''
            ? user.email
            : `${user.email} (${device})`;
      return { kind: 'cli_token', id: principal.tokenId, label };
    }
    case 'serviceToken':
      return { kind: 'service_token', id: principal.tokenId, label: principal.tokenName };
  }
}

/**
 * Takes what is owed and mails it. The caller has already won the throttle.
 * Answers how many sightings the digest covered.
 *
 * Owed sightings are marked notified as they are taken, before the send — so a
 * mail that fails does not repeat them in the next digest. Under-notifying on a
 * mail failure is the direction to err: the environment's settings list every
 * sighting either way, and a failed send is logged.
 */
async function sendDigest(
  services: ServiceContext,
  organization: { id: string; name: string; slug: string },
): Promise<number> {
  const log = services.log.at('readAlerts');
  const owed = await takeOwedSightings(services.db, organization.id, READ_ALERT_DIGEST_SIZE);
  if (owed.length === 0) return 0;

  const mailer = mailerFrom(services.env);
  if (mailer === null) {
    log.info('Mail is not configured, so a read-alert digest was not sent', {
      orgId: organization.id,
      sightings: owed.length,
    });
    return owed.length;
  }

  const recipients = await listAdministratorAddresses(
    services.db,
    organization.id,
    RECIPIENT_LIMIT,
  );
  const origin = publicOrigin(services.env);
  const settingsUrls = new Map<string, string>();
  for (const sighting of owed) {
    settingsUrls.set(
      `${sighting.projectSlug}/${sighting.environmentSlug}`,
      `${origin}/app/${organization.slug}/${sighting.projectSlug}/${sighting.environmentSlug}/settings`,
    );
  }
  const sightings = owed.map(toMailSighting);

  // One at a time: a mail send is an outgoing connection, and this runs beside
  // whatever else the request or the sweep holds open.
  for (const recipient of recipients) {
    try {
      await mailer.send(
        readAlertDigestMail({
          to: recipient.email,
          toName: recipient.displayName,
          organizationName: organization.name,
          sightings,
          settingsUrls,
        }),
      );
    } catch (cause) {
      log.error('Could not email an administrator a read-alert digest', {
        orgId: organization.id,
        ...describeMailFailure(cause),
      });
    }
  }
  return owed.length;
}

function toMailSighting(sighting: OwedSighting): ReadAlertSighting {
  return {
    projectSlug: sighting.projectSlug,
    environmentSlug: sighting.environmentSlug,
    isProduction: sighting.isProduction,
    who: sighting.principalLabel ?? FALLBACK_LABEL[sighting.principalKind],
    address: sighting.ipAddress,
    firstSeenAt: sighting.firstSeenAt,
  };
}

const FALLBACK_LABEL: Readonly<Record<SightingPrincipalKind, string>> = {
  user: 'a signed-in member',
  cli_token: 'a CLI login',
  service_token: 'a service token',
};

/**
 * The five-minute sweep: every organisation owed a digest whose hour is up, up
 * to {@link READ_ALERT_SWEEP_ORGS}, gets one. Answers how many were sent.
 *
 * ── An organisation that lost the feature ──
 * Its owed sightings are cleared, not mailed and not left owed. Not mailed,
 * because the plan no longer includes the alert. Not left owed, because the
 * sweep's work list is bounded and unordered, so organisations that would never
 * be served could crowd out the ones that should — every five minutes, for
 * ever. The sightings themselves stay, and the environment's settings still
 * list them: the data is the customer's, and the route that reads it is not
 * gated on the plan. Nothing new is recorded for such an organisation, so what
 * is cleared is only what was owed at the downgrade.
 *
 * Each organisation's failure is its own: logged, and the next one served.
 */
export async function sweepReadAlertDigests(services: ServiceContext): Promise<number> {
  const notSince = new Date(Date.now() - READ_ALERT_DIGEST_INTERVAL_MS);
  const orgIds = await listOrgsOwedReadAlerts(services.db, notSince, READ_ALERT_SWEEP_ORGS);

  let sent = 0;
  for (const orgId of orgIds) {
    try {
      const entitlements = await loadEntitlements(services.db, orgId);
      const organization = await findOrganizationById(services.db, orgId);
      if (!entitlements.features.newIpReadAlerts || organization === null) {
        await takeOwedSightings(services.db, orgId, UNENTITLED_DRAIN);
        continue;
      }
      if (!(await claimReadAlertDigest(services.db, orgId, notSince))) continue;
      if ((await sendDigest(services, organization)) > 0) sent += 1;
    } catch (cause) {
      services.log
        .at('readAlerts')
        .error('Could not send an organisation its read-alert digest; it is retried next run', {
          orgId,
          error: describeError(cause),
        });
    }
  }
  return sent;
}

/* ── addresses ────────────────────────────────────────────────────────────── */

/**
 * The address a sighting records: IPv4 whole; IPv6 as its /64, in RFC 5952
 * canonical compressed form with the prefix length (`2001:db8:1:2::/64`); a
 * v4-mapped v6 address (`::ffff:203.0.113.5`) as the v4 address it carries.
 * `null` for anything that is not an address — the read is then simply not
 * noted, rather than recorded under a string the `inet` column would refuse.
 */
export function normaliseReadAddress(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (!value.includes(':')) return normaliseIpv4(value);

  const hextets = parseIpv6(value.replace(/%.*$/, ''));
  if (hextets === null) return null;

  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
    const high = hextets[6]!;
    const low = hextets[7]!;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }

  return `${compressIpv6([...hextets.slice(0, 4), 0, 0, 0, 0])}/64`;
}

function normaliseIpv4(value: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.join('.');
}

function parseIpv6(value: string): number[] | null {
  let text = value.toLowerCase();

  // A dotted-quad tail is the last 32 bits, written as v4.
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (tail !== null) {
    const v4 = normaliseIpv4(tail[1]!);
    if (v4 === null) return null;
    const [a, b, c, d] = v4.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = parse(halves[0]!);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const rest = parse(halves[1]!);
  if (rest === null) return null;
  const missing = 8 - head.length - rest.length;
  // `::` stands for at least one group of zeros (RFC 4291 §2.2).
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

/** RFC 5952: lowercase, no leading zeros, the longest run of two or more zero groups as `::`. */
function compressIpv6(hextets: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < hextets.length;) {
    if (hextets[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < hextets.length && hextets[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }

  const groups = hextets.map((hextet) => hextet.toString(16));
  if (bestLength < 2) return groups.join(':');
  const head = groups.slice(0, bestStart).join(':');
  const tail = groups.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

/* ── the listing ─────────────────────────────────────────────────────────── */

export interface SightingPayload {
  id: string;
  principalKind: SightingPrincipalKind;
  /** An email, `email (device)`, or a token name. */
  principalLabel: string | null;
  /** A v4 address, or a v6 /64. */
  address: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** When an alert covering it was sent — or cleared unsent — or `null` while one is owed. */
  notifiedAt: string | null;
}

export function toSightingPayload(record: SightingRecord): SightingPayload {
  return {
    id: record.id,
    principalKind: record.principalKind,
    principalLabel: record.principalLabel,
    address: record.ipAddress,
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    notifiedAt: record.notifiedAt === null ? null : record.notifiedAt.toISOString(),
  };
}
