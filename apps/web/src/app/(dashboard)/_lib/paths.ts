/**
 * Every address the dashboard uses: the pages a person navigates to, and the API
 * routes behind them.
 *
 * The two halves live together because they have to agree. `/app/{org}/{projectId}`
 * and `/api/orgs/{org}/projects/{projectId}` name the same resource, and a screen
 * that reads one while linking to the other produces a 404 nobody notices until
 * somebody's slug is interesting. The API's project segment takes the project's
 * id or its slug (`resolveProject`), so a screen hands it whichever its own URL
 * holds, and the CLI keeps addressing projects by slug.
 *
 * Two rules:
 *
 *  1. **Every segment is encoded.** Ids, slugs and secret names are
 *     pattern-bound (a canonical UUID, `^[a-z0-9]+(?:-[a-z0-9]+)*$`,
 *     `^[A-Za-z_][A-Za-z0-9_]*$`), so encoding is a no-op for every value
 *     that can legitimately arrive — which is precisely
 *     why it is unconditional rather than "where needed". The day a value gets
 *     here from a path that did not validate it, this is what keeps it inside
 *     its own segment.
 *  2. **A secret name may appear in a path; a secret value may not.** Not in a
 *     path, not in a query string, not in a fragment. A URL is logged by every
 *     proxy on the way, kept in browser history, and sent in `Referer`. The
 *     reveal endpoint answers with a body, and the body is the only place a
 *     plaintext value is ever permitted to exist.
 *
 * API builders return paths that already start with `/api/`, which `lib/api.ts`
 * passes through untouched. That makes the same string usable both as an
 * argument to `api.get()` and as the `href` of a download link.
 *
 * This is the dashboard's address book, so it lives with the dashboard routes
 * and is imported by their feature components in `components/projects` and
 * `components/secrets`. The alternative — each feature interpolating its own
 * paths — is how a client ends up calling `/api/org/…` in one place and
 * `/api/orgs/…` in another.
 */

const segment = encodeURIComponent;

/**
 * The host the dashboard is being served from — `xecret.playxoft.com` in
 * production, and something else in every other place this runs.
 *
 * Read from the browser rather than pinned to a constant, so the one place a
 * URL is *shown* to a person rather than navigated to stays true in every
 * environment — localhost, staging, a self-hosted deployment on somebody else's
 * domain. That last one is the reason this stays dynamic now that the canonical
 * host is settled: a self-hoster's dashboard must not print ours.
 * `XECRET_PUBLIC_URL` is the server's answer to the same question, but it is a
 * Cloudflare binding and so unreachable from a client component, which is where
 * the question actually gets asked.
 *
 * Returns an empty string during server rendering, so callers must be mounted
 * client-side only. Today's sole caller sits inside a Radix dialog, whose
 * content stays unmounted until it opens.
 */
export function dashboardHost(): string {
  return typeof window === 'undefined' ? '' : window.location.host;
}

/**
 * The admin page's tabs, as `?tab=` names them. In the address rather than
 * only in the page's state, so an organisation's or account's page can link
 * back to the tab it was opened from, and the browser's Back returns to it.
 */
export const ADMIN_TABS = [
  'overview',
  'organizations',
  'users',
  'grants',
  'promo-codes',
  'admins',
] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

/** The tab `?tab=` names, or Overview for none, or for one the page does not have. */
export function adminTabFromQuery(value: string | null | undefined): AdminTab {
  return (ADMIN_TABS as readonly string[]).includes(value ?? '') ? (value as AdminTab) : 'overview';
}

/** Pages. Everything under `/app` requires a session. */
export const appPath = {
  root: (): string => '/app',
  org: (org: string): string => `/app/${segment(org)}`,
  orgSettings: (org: string): string => `/app/${segment(org)}/settings`,
  /** The billing screen (P12). Owners only; Dodo's checkout and portal return here. */
  orgBilling: (org: string): string => `/app/${segment(org)}/settings/billing`,
  /**
   * The plans, inside the app. Every member may read it; only an owner is
   * offered a checkout from it. Where every in-app "Compare plans" link goes,
   * and the public pricing page's buttons for a signed-in visitor (through
   * `/app?to=plans`). The account menu's Upgrade opens the pricing page.
   *
   * Under `settings`, beside billing, rather than at `/app/{org}/upgrade`: that
   * is the slot a project slug takes, and claiming it would shadow any project
   * already called `upgrade` — its overview, and every control that lives only
   * there. `settings` is already reserved, so this path shadows nothing.
   */
  orgPlans: (org: string): string => `/app/${segment(org)}/settings/plans`,
  // The rest of the organisation's settings sections, one address each — see
  // `settings-sections.ts` for the list they make and who is shown which.
  // General is `orgSettings` itself, so every link to the area as a whole
  // still lands on the page that names the organisation.
  orgRoles: (org: string): string => `/app/${segment(org)}/settings/roles`,
  /** Where the WorkOS setup portal sends an owner back to when they are done. */
  orgSingleSignOn: (org: string): string => `/app/${segment(org)}/settings/single-sign-on`,
  orgPolicies: (org: string): string => `/app/${segment(org)}/settings/policies`,
  orgWebhooks: (org: string): string => `/app/${segment(org)}/settings/webhooks`,
  orgDanger: (org: string): string => `/app/${segment(org)}/settings/danger`,
  members: (org: string): string => `/app/${segment(org)}/members`,
  tokens: (org: string): string => `/app/${segment(org)}/tokens`,
  audit: (org: string): string => `/app/${segment(org)}/audit`,
  /** The invitation-acceptance page. Top-level: the visitor may have no session. */
  invite: (token: string): string => `/invite/${segment(token)}`,
  /**
   * A project's pages, named by the project's **id** — never its slug.
   *
   * An id, so the address says nothing about what a project is called and is
   * the same address for as long as the project exists: a bookmark, a link in
   * a chat, a URL in an emailed digest. The organisation and the environment
   * are still named by slug, as `xecret run --env` names an environment. An
   * address from before projects were named this way still arrives — the page
   * reads a slug-shaped segment as one and replaces the URL with
   * `canonicalProjectAddress`.
   */
  project: (org: string, projectId: string): string => `${appPath.org(org)}/${segment(projectId)}`,
  environment: (org: string, projectId: string, env: string): string =>
    `${appPath.project(org, projectId)}/${segment(env)}`,
  environmentSettings: (org: string, projectId: string, env: string): string =>
    `${appPath.environment(org, projectId, env)}/settings`,
  account: (): string => '/app/settings/account',
  // The account area's other sections. There is no `settingsSecurity` any
  // more: `/app/settings/security` was one long page of five cards, and it is
  // now four sections with an address each. The old address still answers —
  // it redirects to the vault, which is what the emails that carry it are
  // about — but nothing new should link to a page that no longer exists.
  settingsAppearance: (): string => '/app/settings/appearance',
  settingsSignIn: (): string => '/app/settings/sign-in',
  settingsVault: (): string => '/app/settings/vault',
  settingsUnlock: (): string => '/app/settings/unlock',
  settingsDevices: (): string => '/app/settings/devices',
  settingsDanger: (): string => '/app/settings/danger',
  /**
   * The admin page: xecret's own staff keeping an eye on the service, giving
   * organisations a free plan and issuing promo codes. `?tab=` names the tab
   * it opens on (`adminTabFromQuery`). Linked from the account menu only for an
   * admin; for everybody else it is a 404, as its API is (`server/admin.ts`).
   *
   * At the first position, where an organisation slug would go, which is safe
   * only because `admin` is in the reserved slug list — no organisation can be
   * called `admin` and be shadowed by this, as none can be called `settings`.
   */
  admin: (): string => '/app/admin',
  /** The admin page with one tab open, e.g. `/app/admin?tab=users`. Overview's is the page's own. */
  adminTab: (tab: AdminTab): string =>
    tab === 'overview' ? appPath.admin() : `${appPath.admin()}?tab=${segment(tab)}`,
  /**
   * One organisation, and one account, on the admin page — by id, like the
   * admin API: the admin is not a member, and a slug is the organisation's to
   * rename. Under `/app/admin`, so the shell reads them as the admin area too.
   */
  adminOrganization: (orgId: string): string =>
    `${appPath.admin()}/organizations/${segment(orgId)}`,
  adminUser: (userId: string): string => `${appPath.admin()}/users/${segment(userId)}`,
} as const;

/** API routes, as documented in `docs/architecture/api.md` §4. */
export const apiPath = {
  me: (): string => '/api/auth/me',
  sessions: (): string => '/api/auth/sessions',
  account: (): string => '/api/auth/account',
  /** The vault's state, and the material an unlock attempt needs. */
  vault: (): string => '/api/auth/vault',
  vaultUnlock: (): string => '/api/auth/vault/unlock',
  vaultLock: (): string => '/api/auth/vault/lock',
  vaultPassphrase: (): string => '/api/auth/vault/passphrase',
  /** `POST` redeems a recovery code's lookup hash; `PUT` reissues the whole kit. */
  vaultRecovery: (): string => '/api/auth/vault/recovery',
  vaultRecoveryComplete: (): string => '/api/auth/vault/recovery/complete',
  /** Passkey wraps for one-touch unlock. `DELETE` takes `/{passkeyId}`. */
  vaultPasskeys: (): string => '/api/auth/vault/prf',
  /**
   * Device PINs. `GET` lists them, `POST` enrols this browser, `DELETE` revokes
   * every one.
   */
  vaultPins: (): string => '/api/auth/vault/pin',
  /**
   * One PIN attempt. A sibling of `/api/auth/vault/pin/{deviceId}` rather than a
   * nested route, which is unambiguous because a device id is always a uuid and
   * `attempt` is not one — the same arrangement `/api/orgs/availability` has
   * beside `/api/orgs/{orgSlug}`.
   */
  vaultPinAttempt: (): string => '/api/auth/vault/pin/attempt',
  vaultPin: (deviceId: string): string => `${apiPath.vaultPins()}/${segment(deviceId)}`,
  /** Destroys the vault when the passphrase and every recovery code are gone. */
  vaultReset: (): string => '/api/auth/vault/reset',
  /** What a reset would do with the escape archive, asked before anybody confirms. */
  vaultResetPreflight: (): string => '/api/auth/vault/reset/preflight',
  /**
   * The reset's re-authentication: where it stands, the emailed code, and the
   * check that turns the code into the proof the reset spends.
   */
  reauth: (): string => '/api/auth/reauth',
  reauthStart: (): string => '/api/auth/reauth/start',
  reauthVerify: (): string => '/api/auth/reauth/verify',
  orgs: (): string => '/api/orgs',
  /**
   * Whether an organisation slug is free. Takes `?slug=`.
   *
   * A sibling of `/api/orgs/{orgSlug}` rather than a nested route, which works
   * only because `availability` is in the reserved slug list — no organisation
   * can claim it and shadow this.
   */
  orgSlugAvailability: (): string => '/api/orgs/availability',
  org: (org: string): string => `/api/orgs/${segment(org)}`,
  projects: (org: string): string => `${apiPath.org(org)}/projects`,
  members: (org: string): string => `${apiPath.org(org)}/members`,
  member: (org: string, memberId: string): string => `${apiPath.members(org)}/${segment(memberId)}`,
  memberGrants: (org: string, memberId: string): string =>
    `${apiPath.member(org, memberId)}/grants`,
  memberAccess: (org: string, memberId: string): string =>
    `${apiPath.member(org, memberId)}/access`,
  invitations: (org: string): string => `${apiPath.org(org)}/invitations`,
  invitation: (org: string, invitationId: string): string =>
    `${apiPath.invitations(org)}/${segment(invitationId)}`,
  invitationLookup: (): string => '/api/invitations/lookup',
  invitationAccept: (): string => '/api/invitations/accept',
  /** The viewer's own authority, and the level they could grant on each environment. */
  authority: (org: string): string => `${apiPath.org(org)}/authority`,
  /** The organisation's custom roles. */
  roles: (org: string): string => `${apiPath.org(org)}/roles`,
  role: (org: string, roleId: string): string => `${apiPath.roles(org)}/${segment(roleId)}`,
  /** The organisation's single sign-on: status, turning it on, and its two policies. */
  sso: (org: string): string => `${apiPath.org(org)}/sso`,
  /** `POST` mints a WorkOS Admin Portal link for setting up the identity provider. */
  ssoPortal: (org: string): string => `${apiPath.sso(org)}/portal`,
  /** The billing screen's status (P12). */
  billing: (org: string): string => `${apiPath.org(org)}/billing`,
  /** `POST` a plan and period: a Dodo checkout URL to send the browser to. */
  billingCheckout: (org: string): string => `${apiPath.billing(org)}/checkout`,
  /** `GET` previews and `POST` requests a move to another plan or period. */
  billingChange: (org: string): string => `${apiPath.billing(org)}/change`,
  /** `POST` mints a link into Dodo's customer portal. */
  billingPortal: (org: string): string => `${apiPath.billing(org)}/portal`,
  /** `POST {code}`: what a promo code would do here. Changes nothing. */
  billingPromoCode: (org: string): string => `${apiPath.billing(org)}/promo-code`,
  /** `POST {code}`: applies a free-plan code now. A discount code goes to checkout instead. */
  billingPromoCodeRedeem: (org: string): string => `${apiPath.billingPromoCode(org)}/redeem`,
  serviceTokens: (org: string): string => `${apiPath.org(org)}/tokens/service`,
  cliTokens: (org: string): string => `${apiPath.org(org)}/tokens/cli`,
  token: (org: string, kind: 'cli' | 'service', tokenId: string): string =>
    `${apiPath.org(org)}/tokens/${kind}/${segment(tokenId)}`,
  audit: (org: string): string => `${apiPath.org(org)}/audit`,
  /**
   * One project, and everything below it. `project` is the project's id — what
   * every dashboard address holds — or its slug, which is all some payloads
   * carry; the API resolves either, within the organisation (`resolveProject`).
   */
  project: (org: string, project: string): string => `${apiPath.projects(org)}/${segment(project)}`,
  environments: (org: string, project: string): string =>
    `${apiPath.project(org, project)}/environments`,
  /** Who can reach one project, and at what level — the transpose of `memberAccess`. */
  projectMembers: (org: string, project: string): string =>
    `${apiPath.project(org, project)}/members`,
  environment: (org: string, project: string, env: string): string =>
    `${apiPath.environments(org, project)}/${segment(env)}`,
  secrets: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/secrets`,
  secret: (org: string, project: string, env: string, name: string): string =>
    `${apiPath.secrets(org, project, env)}/${segment(name)}`,
  secretVersions: (org: string, project: string, env: string, name: string): string =>
    `${apiPath.secret(org, project, env, name)}/versions`,
  secretRestore: (org: string, project: string, env: string, name: string): string =>
    `${apiPath.secret(org, project, env, name)}/restore`,
  secretVersion: (
    org: string,
    project: string,
    env: string,
    name: string,
    version: number,
  ): string => `${apiPath.secretVersions(org, project, env, name)}/${version}`,
  import: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/import`,
  export: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/export`,
  pull: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/pull`,

  // ── P19: the paid secret features ──
  /** `PUT {parent: slug|null}` — what this environment inherits from. */
  environmentParent: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/parent`,
  /** `PATCH {plaintextExport?, readAlerts?}` — the environment's two switches. */
  environmentPolicy: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/policy`,
  /** The new addresses this environment has been read from. Takes `?limit=`. */
  readSightings: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/read-sightings`,
  /** The caller's own personal overrides in one environment. */
  overrides: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/overrides`,
  override: (org: string, project: string, env: string, name: string): string =>
    `${apiPath.overrides(org, project, env)}/${segment(name)}`,
  /** `POST` into `env` — the *target* — from the source named in the body. */
  promote: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/promote`,
  /** `GET ?at=` previews a point-in-time restore; `POST` applies it. */
  restorePoint: (org: string, project: string, env: string): string =>
    `${apiPath.environment(org, project, env)}/restore-point`,
  /** The organisation's token and secret policies. */
  policies: (org: string): string => `${apiPath.org(org)}/policies`,
  webhooks: (org: string): string => `${apiPath.org(org)}/webhooks`,
  webhook: (org: string, webhookId: string): string =>
    `${apiPath.webhooks(org)}/${segment(webhookId)}`,
  webhookRotateSecret: (org: string, webhookId: string): string =>
    `${apiPath.webhook(org, webhookId)}/rotate-secret`,
  webhookTest: (org: string, webhookId: string): string =>
    `${apiPath.webhook(org, webhookId)}/test`,
  webhookDeliveries: (org: string, webhookId: string): string =>
    `${apiPath.webhook(org, webhookId)}/deliveries`,

  // ── The admin page (`server/admin.ts`): 404 to everybody but xecret's staff ──
  /** `GET` — how many accounts, organisations, projects, environments and secrets, and recent sign-ups. */
  adminOverview: (): string => '/api/admin/overview',
  /**
   * `GET` — every organisation, newest first (`?cursor=`); `GET ?q=` —
   * organisations by a member's email address or by slug.
   */
  adminOrganizations: (): string => '/api/admin/organizations',
  /** `GET` — one organisation, with its members. */
  adminOrganization: (orgId: string): string => `${apiPath.adminOrganizations()}/${segment(orgId)}`,
  /** `GET` — every account, newest first (`?cursor=`, `?q=` part of an address). */
  adminUsers: (): string => '/api/admin/users',
  /** `GET` — one account, with its organisations. */
  adminUser: (userId: string): string => `${apiPath.adminUsers()}/${segment(userId)}`,
  /**
   * `POST` gives the organisation a free plan, or replaces the one it has.
   * Keyed by id, not slug: the admin is not a member, and a slug is the
   * organisation's to rename.
   */
  adminGrant: (orgId: string): string => `/api/admin/organizations/${segment(orgId)}/grant`,
  /** `POST {reason}` ends a free plan now; the organisation returns to Free. */
  adminGrantEnd: (orgId: string): string => `${apiPath.adminGrant(orgId)}/end`,
  /** Every free plan in force, soonest to end first. */
  adminGrants: (): string => '/api/admin/grants',
  /** `GET` lists the codes, `POST` creates one. */
  adminPromoCodes: (): string => '/api/admin/promo-codes',
  adminPromoCodeRevoke: (codeId: string): string =>
    `${apiPath.adminPromoCodes()}/${segment(codeId)}/revoke`,
  /** `GET` lists xecret's admins, longest-serving first; `POST {email}` adds one. */
  adminAdmins: (): string => '/api/admin/admins',
  /** `POST` — that account is no longer an admin. Never the last one. */
  adminRemoveAdmin: (userId: string): string =>
    `${apiPath.adminAdmins()}/${segment(userId)}/remove`,
} as const;

/**
 * Appends a query string, dropping absent values.
 *
 * The result is a plain string rather than `api`'s `query` option because these
 * paths are used as effect dependencies: an object literal is a new identity on
 * every render, and a fetch keyed on one re-runs forever.
 *
 * ── Why it merges rather than appends ──
 * A path handed in may already carry a query string, because building one is
 * exactly what this function is for: the audit screen composes its filters once
 * and then asks for the next page of *those* filters. Appending a second `?`
 * produced `…?action=secret.read?cursor=…`, which the server reads as an
 * `action` of `secret.read?cursor=…` — a 400, and one that only appeared once a
 * filter was on. So an existing search string is parsed and the new parameters
 * are merged into it, later values winning.
 */
export function withQuery(
  path: string,
  params: Readonly<Record<string, string | number | undefined>>,
): string {
  const separator = path.indexOf('?');
  const base = separator === -1 ? path : path.slice(0, separator);
  const search = new URLSearchParams(separator === -1 ? '' : path.slice(separator + 1));

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised.length > 0 ? `${base}?${serialised}` : base;
}

/**
 * Which organisation, project and environment the current URL is about.
 *
 * Derived from the path rather than from a context that each page has to
 * populate, so the shell knows where it is before any request has resolved —
 * which is what lets the sidebar and breadcrumbs render during the first load
 * rather than appearing a beat later.
 *
 * `settings` is unambiguous at both places it appears. At the first position it
 * is `/app/settings/account`, and no organisation can shadow it because
 * `settings` is in the reserved slug list; at the second it is the organisation
 * settings page, and nothing in the project slot can shadow it — an id never
 * spells a word, and the slug an old address carries there is barred from the
 * list for the same reason.
 *
 * `admin` at the first position is the admin page, by the same reasoning. Read
 * as a slug it would point the whole shell at an organisation called "admin" —
 * every sidebar link to `/app/admin/members` and the like, and the tab's
 * remembered organisation overwritten with one the viewer is not a member of.
 */
export interface DashboardLocation {
  orgSlug: string | null;
  /**
   * The project segment as the URL spells it: the project's id at every address
   * the dashboard builds, or — for a moment, on an address from before projects
   * were named by id — its slug, which the page then replaces with the id. Both
   * reach the same project through the API, so nothing reading this has to know
   * which it holds; nothing should show it to a person either.
   */
  projectId: string | null;
  envSlug: string | null;
  /** `/app/settings/**` — scoped to the person, not to an organisation. */
  isAccountArea: boolean;
  /** `/app/admin` — xecret's staff page, scoped to no organisation either. */
  isAdminArea: boolean;
}

export function parseDashboardPath(pathname: string): DashboardLocation {
  const [root, first, second, third] = pathname.split('/').filter(Boolean);
  const empty: DashboardLocation = {
    orgSlug: null,
    projectId: null,
    envSlug: null,
    isAccountArea: false,
    isAdminArea: false,
  };

  if (root !== 'app' || first === undefined) return empty;
  if (first === 'settings') return { ...empty, isAccountArea: true };
  if (first === 'admin') return { ...empty, isAdminArea: true };

  // Org-level pages that occupy the slot a project would. All four names are in
  // the reserved slug list and none is shaped like an id, so no project can
  // ever shadow one — which is what makes this a lookup rather than a guess.
  const orgPage =
    second === 'settings' || second === 'members' || second === 'tokens' || second === 'audit';

  return {
    orgSlug: decodeURIComponent(first),
    projectId: second === undefined || orgPage ? null : decodeURIComponent(second),
    envSlug: third === undefined || orgPage ? null : decodeURIComponent(third),
    isAccountArea: false,
    isAdminArea: false,
  };
}

/**
 * Where a project page reached by an old address belongs: the same page, named
 * by the project's id, with everything after it kept — the environment, the
 * `settings` beneath it, the query string and the fragment.
 *
 * ── Why an old address has to keep working ──
 * Until project pages were named by id they were named by slug, and those
 * addresses are in bookmarks, browser history, chat threads and every read-alert
 * digest ever sent. A link that 404s because the product changed its mind about
 * URLs is a broken promise to whoever saved it. So a slug-shaped segment is
 * looked up as a slug (the API still takes one) and the address is *replaced*
 * — not pushed, so Back does not return to a page that only redirects.
 *
 * Only the project segment changes. The rest is taken from the address as it
 * stands rather than rebuilt from parsed parts, so a sub-path this function has
 * never heard of — a settings anchor, a future tab — survives the move too.
 *
 * `null` when the path is not a project page at all, which no caller should
 * reach: it is the answer for an address the redirect has no business touching.
 */
export function canonicalProjectAddress(
  location: { pathname: string; search: string; hash: string },
  projectId: string,
): string | null {
  if (parseDashboardPath(location.pathname).projectId === null) return null;

  // `['', 'app', org, project, …rest]` — the leading slash is the empty first
  // element, so the project is the fourth. Checked rather than assumed: a path
  // `parseDashboardPath` reads leniently (a doubled slash) must not have some
  // other segment overwritten.
  const segments = location.pathname.split('/');
  if (segments[0] !== '' || segments[1] !== 'app' || !segments[3]) return null;
  segments[3] = segment(projectId);
  return `${segments.join('/')}${location.search}${location.hash}`;
}
