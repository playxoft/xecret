'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { loginHref } from '@/app/(auth)/_components/login-href';
import { api, errorMessage, isApiError } from '@/lib/api';
import { pluralize } from '@/lib/format';
import { apiPath, appPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { canAdminister } from '@/app/(dashboard)/_components/session';
import type { SessionOrganization } from '@/app/(dashboard)/_components/session';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Skeleton,
  Switch,
  useToast,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';

/** One identity-provider connection, as `GET /api/orgs/{orgSlug}/sso` reports it. */
export interface SsoConnection {
  id: string;
  type: string;
  state: 'draft' | 'active' | 'inactive' | 'validating';
}

/** One of the organisation's domains at WorkOS. */
export interface SsoDomain {
  domain: string;
  state: 'verified' | 'pending' | 'failed';
}

/** What every SSO settings route answers with, under `sso`. */
export interface SsoStatus {
  enabled: boolean;
  ssoRequired: boolean;
  jitJoinEnabled: boolean;
  seatLimit: number;
  addon: { enabled: boolean };
  connections: readonly SsoConnection[] | null;
  domains: readonly SsoDomain[] | null;
  /** Active non-owner members with an address outside the verified domains. */
  membersOutsideVerifiedDomains: number | null;
  providerReachable: boolean;
}

export interface SsoStatusResponse {
  sso: SsoStatus;
}

/** What `PATCH` answers: the status, and what requiring SSO now holds back. */
export interface SsoPatchResponse extends SsoStatusResponse {
  nonSsoAccess: { sessions: number; cliTokens: number } | null;
}

/** The two switches, by the field name the PATCH takes. */
type Policy = 'ssoRequired' | 'jitJoinEnabled';

/**
 * The organisation's single sign-on, on its settings page.
 *
 * ── Who sees what ──
 * Owners and admins (`org.update`, the server's read gate) see the settings;
 * anybody else is told who manages them rather than shown an empty card. Of
 * those who can see it, only **owners** (`sso.manage`) can turn SSO on, open
 * the setup portal, or switch a policy on — whoever does those decides which
 * identity provider vouches for every member, owners included. An admin sees
 * the same card read-only, told so, and can still switch a policy off.
 *
 *  - **Turning SSO on** creates the organisation's account at WorkOS. It needs
 *    the single sign-on add-on, which is bought separately — without it the
 *    card says so and offers the way to ask, rather than a button that fails.
 *  - **The setup portal** is WorkOS's page for connecting the identity provider
 *    and verifying domains, opened in a new tab cut loose from this one. The
 *    link is as good as a credential while it lasts, so the server asks the
 *    owner to have signed in again in the last ten minutes, and the page never
 *    navigates itself to it: a blocked tab gets a link the owner clicks.
 *  - **The two switches** take effect when flipped (a switch, not a form).
 *    Switching either *on* needs the add-on, and requiring SSO also needs an
 *    active connection and a verified domain, because a requirement nobody can
 *    meet leaves only the owners able to get in. Switching either *off* is
 *    always available.
 *
 * Each absent or unavailable control is explained in a sentence, for the same
 * reason the Roles card does it: "why can't I?" has several answers here, and
 * they are fixed by different people.
 */
export function SingleSignOnCard({
  orgSlug,
  organization,
}: {
  orgSlug: string;
  organization: SessionOrganization | null;
}) {
  const mayRead = canAdminister(organization, 'org.update');
  const mayManage = canAdminister(organization, 'sso.manage');
  const status = useApiResource<SsoStatusResponse>(mayRead ? apiPath.sso(orgSlug) : null);

  return (
    // The anchor the setup portal sends people back to when they are done.
    <Card id="single-sign-on">
      <CardHeader>
        <CardTitle>Single sign-on</CardTitle>
        <CardDescription>
          Let your team sign in through your company’s identity provider — Okta, Microsoft Entra ID,
          Google Workspace, or any SAML or OIDC provider. Set up and verified through WorkOS, which
          runs sign-in for xecret.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {!mayRead ? (
          <p className="text-fg-subtle text-sm">
            Single sign-on is managed by the organisation’s owners and admins.
          </p>
        ) : status.error !== null ? (
          <Alert tone="danger" title="The single sign-on settings could not be loaded">
            <p>{errorMessage(status.error)}</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => void status.reload()}
            >
              Try again
            </Button>
          </Alert>
        ) : status.data === null ? (
          <div
            aria-busy="true"
            aria-label="Loading single sign-on settings"
            className="flex flex-col gap-2"
          >
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <SsoSettings
            orgSlug={orgSlug}
            sso={status.data.sso}
            mayManage={mayManage}
            onChanged={() => void status.reload()}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Rendered once the status has loaded, so every control starts from what the
 * server holds rather than from a default corrected a render later.
 */
function SsoSettings({
  orgSlug,
  sso,
  mayManage,
  onChanged,
}: {
  orgSlug: string;
  sso: SsoStatus;
  mayManage: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [enabling, setEnabling] = useState(false);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState<Policy | null>(null);
  const [error, setError] = useState<unknown>(null);
  // A link the browser would not open in a tab of its own. Held only here, in
  // memory, until it is clicked — never followed by this page.
  const [blockedLink, setBlockedLink] = useState<string | null>(null);

  const controls = ssoControls(sso, mayManage);
  const needsReauth = isApiError(error) && error.code === 'reauth_required';

  async function enable() {
    if (enabling) return;
    setEnabling(true);
    setError(null);
    try {
      await api.post(apiPath.sso(orgSlug));
      toast({ variant: 'success', title: 'Single sign-on is on' });
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setEnabling(false);
    }
  }

  async function openPortal() {
    if (opening) return;
    // Opened before the request, while the click still counts as the person's
    // own gesture — a window opened after an `await` is a popup, and blocked.
    // It is cut loose from this page before it is pointed anywhere, so the
    // portal can never reach back into the dashboard through `window.opener`.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    setOpening(true);
    setError(null);
    setBlockedLink(null);
    try {
      const { link } = await api.post<{ link: string }>(apiPath.ssoPortal(orgSlug));
      if (tab) tab.location.href = link;
      // A browser that refused even that: this page does not navigate itself
      // to the link — that would leave a credential-grade URL in this tab's
      // history. The owner gets a link of their own to click instead.
      else setBlockedLink(link);
    } catch (cause) {
      tab?.close();
      setError(cause);
    } finally {
      setOpening(false);
    }
  }

  async function setPolicy(policy: Policy, value: boolean) {
    if (saving !== null) return;
    setSaving(policy);
    setError(null);
    try {
      const answer = await api.patch<SsoPatchResponse>(apiPath.sso(orgSlug), { [policy]: value });
      const description =
        policy === 'ssoRequired' && value && answer.nonSsoAccess !== null
          ? nonSsoAccessSentence(answer.nonSsoAccess)
          : undefined;
      toast({
        variant: 'success',
        title: POLICY_TOASTS[policy][value ? 'on' : 'off'],
        ...(description === undefined ? {} : { description }),
      });
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      {needsReauth ? (
        <Alert tone="warning" title="Confirm it’s you first">
          <p>
            The setup portal decides who can sign in as this organisation’s members, so it opens
            only within ten minutes of signing in again.
          </p>
          <Button variant="secondary" size="sm" className="mt-2" asChild>
            <a href={loginHref({ reauth: true, next: appPath.orgSettings(orgSlug) })}>
              Sign in again
            </a>
          </Button>
        </Alert>
      ) : error !== null ? (
        <Alert tone="danger" title="That change was not made">
          <p>{errorMessage(error)}</p>
          {isApiError(error) && error.requestId ? (
            <p className="mt-1.5 text-sm">
              Request id: <code className="font-mono select-all">{error.requestId}</code>
            </p>
          ) : null}
        </Alert>
      ) : null}

      {blockedLink !== null ? (
        <Alert tone="info" title="Your browser kept the setup portal from opening">
          <p>
            <a
              href={blockedLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-fg decoration-line-strong hover:decoration-fg font-medium underline underline-offset-4"
              onClick={() => setBlockedLink(null)}
            >
              Open the setup portal
            </a>{' '}
            in a new tab. The link works for a few minutes.
          </p>
        </Alert>
      ) : null}

      {!mayManage ? (
        <p className="text-fg-subtle text-sm">
          Only an owner can turn single sign-on on, open the setup portal or switch a sign-in policy
          on — whoever does decides which identity provider vouches for every member. You can still
          switch a policy off.
        </p>
      ) : null}

      {!sso.enabled ? (
        sso.addon.enabled ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-fg-muted text-sm leading-6">
              Single sign-on is off. Turning it on creates this organisation’s account at WorkOS.
              Nothing changes for anybody until an identity provider is connected, and both sign-in
              policies start switched off.
            </p>
            {mayManage ? (
              <Button variant="primary" loading={enabling} onClick={() => void enable()}>
                Turn on single sign-on
              </Button>
            ) : null}
          </div>
        ) : (
          <Alert tone="info" title="Single sign-on is an add-on">
            Single sign-on is purchased separately for each organisation, because every connected
            identity provider is a paid connection at WorkOS.{' '}
            <Link
              href="/contact"
              className="text-fg decoration-line-strong hover:decoration-fg font-medium underline underline-offset-4"
            >
              Contact us
            </Link>{' '}
            to turn it on for this organisation.
          </Alert>
        )
      ) : (
        <>
          {!sso.providerReachable ? (
            <Alert tone="warning" title="WorkOS could not be reached">
              The connection and domain status below is unknown for now. The sign-in policies still
              apply as shown.
            </Alert>
          ) : null}

          <section aria-labelledby="sso-connections" className="flex flex-col gap-2">
            <h3 id="sso-connections" className="text-fg text-sm font-medium">
              Identity provider
            </h3>
            {sso.connections === null ? null : sso.connections.length === 0 ? (
              <p className="text-fg-subtle text-sm">
                No identity provider is connected yet. Open the setup portal to connect one.
              </p>
            ) : (
              <ul className="border-line divide-line-subtle divide-y rounded-lg border">
                {sso.connections.map((connection) => {
                  const state = connectionState(connection.state);
                  return (
                    <li
                      key={connection.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5"
                    >
                      <span className="text-fg text-sm font-medium">
                        {connectionLabel(connection.type)}
                      </span>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="sso-domains" className="flex flex-col gap-2">
            <h3 id="sso-domains" className="text-fg text-sm font-medium">
              Domains
            </h3>
            {sso.domains === null ? null : sso.domains.length === 0 ? (
              <p className="text-fg-subtle text-sm">
                No domains yet. Add and verify your company’s domains in the setup portal: only
                addresses at a verified domain can sign in through your identity provider.
              </p>
            ) : (
              <ul className="border-line divide-line-subtle divide-y rounded-lg border">
                {sso.domains.map((domain) => (
                  <li
                    key={domain.domain}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5"
                  >
                    <span className="text-fg font-mono text-sm">{domain.domain}</span>
                    <Badge tone={DOMAIN_STATES[domain.state].tone}>
                      {DOMAIN_STATES[domain.state].label}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {sso.membersOutsideVerifiedDomains !== null && sso.membersOutsideVerifiedDomains > 0 ? (
              <Alert tone="warning" title="Some members are outside your verified domains">
                {pluralize(sso.membersOutsideVerifiedDomains, 'member')}{' '}
                {sso.membersOutsideVerifiedDomains === 1 ? 'has' : 'have'} an address your identity
                provider cannot sign in, because its domain is not verified here. While single
                sign-on is required they cannot use this organisation — verify their domain, or
                change their address. Owners are exempt.
              </Alert>
            ) : null}
          </section>

          {sso.addon.enabled ? (
            mayManage ? (
              <div className="flex flex-col items-start gap-2">
                <Button
                  variant={controls.hasActiveConnection ? 'secondary' : 'primary'}
                  loading={opening}
                  onClick={() => void openPortal()}
                >
                  Open setup portal
                </Button>
                <p className="text-fg-subtle text-sm">
                  Opens WorkOS in a new tab, where your IT admin connects the identity provider and
                  verifies your domains. The link works for a few minutes, and opens only within ten
                  minutes of signing in again.
                </p>
              </div>
            ) : null
          ) : (
            <p className="text-fg-subtle text-sm">
              This organisation no longer holds the single sign-on add-on, so the setup portal is
              unavailable and neither policy can be switched on. Both can still be switched off.
            </p>
          )}

          <PolicySwitch
            id="sso-required"
            label="Require single sign-on"
            description={
              <>
                Members can use this organisation only after signing in through your identity
                provider. It takes effect immediately for this organisation’s resources: anyone
                signed in another way — a password, Google, or a CLI device approved from such a
                session — loses access to it on their next request. Their other organisations are
                unaffected. Owners are always exempt, so a misconfigured identity provider cannot
                lock the organisation out, and every time an owner uses that exemption the audit log
                records it.
              </>
            }
            checked={sso.ssoRequired}
            disabledReason={controls.requireUnavailable}
            saving={saving === 'ssoRequired'}
            busy={saving !== null}
            onChange={(value) => void setPolicy('ssoRequired', value)}
          />

          <PolicySwitch
            id="sso-jit"
            label="Let people join through single sign-on"
            description={
              <>
                Anybody your identity provider signs in, with an address at a verified domain, joins
                this organisation as a <span className="text-fg font-medium">Viewer</span> — no
                invitation needed — while seats last ({pluralize(sso.seatLimit, 'seat')} in all). A
                Viewer can read the secrets of every environment except production, and cannot
                change anything; give them more on the Members page. Somebody you removed does not
                rejoin this way — invite them again. When this is off, everybody needs an
                invitation.
              </>
            }
            checked={sso.jitJoinEnabled}
            disabledReason={controls.joinUnavailable}
            saving={saving === 'jitJoinEnabled'}
            busy={saving !== null}
            onChange={(value) => void setPolicy('jitJoinEnabled', value)}
          />
        </>
      )}
    </>
  );
}

function PolicySwitch({
  id,
  label,
  description,
  checked,
  disabledReason,
  saving,
  busy,
  onChange,
}: {
  id: string;
  label: string;
  description: ReactNode;
  checked: boolean;
  /** Why the switch cannot be turned on, or `null` when it can. Never stops it turning off. */
  disabledReason: string | null;
  saving: boolean;
  busy: boolean;
  onChange: (value: boolean) => void;
}) {
  const blocked = !checked && disabledReason !== null;
  const hintId = `${id}-hint`;
  return (
    <div className="border-line rounded-lg border p-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={id}>{label}</Label>
          <p className="text-fg-muted mt-1 text-sm leading-5">{description}</p>
          {blocked ? (
            <p id={hintId} className="text-fg-subtle mt-1.5 text-sm">
              {disabledReason}
            </p>
          ) : null}
        </div>
        <Switch
          id={id}
          checked={checked}
          disabled={blocked || busy}
          aria-busy={saving || undefined}
          aria-describedby={blocked ? hintId : undefined}
          onCheckedChange={onChange}
        />
      </div>
    </div>
  );
}

const POLICY_TOASTS: Record<Policy, { on: string; off: string }> = {
  ssoRequired: {
    on: 'Single sign-on is now required',
    off: 'Single sign-on is no longer required',
  },
  jitJoinEnabled: {
    on: 'People can now join through single sign-on',
    off: 'Joining through single sign-on is off',
  },
};

/**
 * What switching the requirement on just did, in a sentence: the sessions and
 * CLI tokens of members who did not come through the identity provider, which
 * no longer reach this organisation.
 */
export function nonSsoAccessSentence(access: { sessions: number; cliTokens: number }): string {
  if (access.sessions === 0 && access.cliTokens === 0) {
    return 'Every member signed in now already came through your identity provider.';
  }
  const parts = [
    ...(access.sessions > 0 ? [pluralize(access.sessions, 'browser session')] : []),
    ...(access.cliTokens > 0 ? [pluralize(access.cliTokens, 'CLI token')] : []),
  ];
  return (
    `${parts.join(' and ')} of members who did not sign in through your identity provider ` +
    'no longer reach this organisation. Those members need to sign in again through it.'
  );
}

const CONNECTION_STATES: Record<SsoConnection['state'], { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  validating: { label: 'Validating', tone: 'warning' },
  draft: { label: 'Not finished', tone: 'warning' },
  inactive: { label: 'Inactive', tone: 'neutral' },
};

/**
 * A connection state's label and tone — `Inactive` for one this dashboard does
 * not know, which the server folds the same way, so a state WorkOS adds later
 * can never break the card's render.
 */
export function connectionState(state: string): { label: string; tone: BadgeTone } {
  return Object.hasOwn(CONNECTION_STATES, state)
    ? CONNECTION_STATES[state as SsoConnection['state']]
    : CONNECTION_STATES.inactive;
}

const DOMAIN_STATES: Record<SsoDomain['state'], { label: string; tone: BadgeTone }> = {
  verified: { label: 'Verified', tone: 'success' },
  pending: { label: 'Awaiting verification', tone: 'warning' },
  failed: { label: 'Verification failed', tone: 'danger' },
};

/** The identity providers people recognise by another name than WorkOS's type id. */
const CONNECTION_LABELS: Readonly<Record<string, string>> = {
  OktaSAML: 'Okta (SAML)',
  AzureSAML: 'Microsoft Entra ID (SAML)',
  GoogleSAML: 'Google Workspace (SAML)',
  GenericSAML: 'SAML',
  GenericOIDC: 'OpenID Connect',
  ADFSSAML: 'Active Directory Federation Services (SAML)',
  JumpCloudSAML: 'JumpCloud (SAML)',
  OneLoginSAML: 'OneLogin (SAML)',
  PingFederateSAML: 'PingFederate (SAML)',
  PingOneSAML: 'PingOne (SAML)',
};

/**
 * A connection type as a person reads it: `OktaSAML` → "Okta (SAML)". A type
 * this list does not know is spaced at its case changes rather than shown as
 * an identifier — `KeycloakSAML` → "Keycloak SAML".
 */
export function connectionLabel(type: string): string {
  return CONNECTION_LABELS[type] ?? type.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Which controls the settings can offer, and if not, why — the same rules the
 * server enforces, so a control is never drawn whose only answer is a refusal.
 * Pure, so it is tested without rendering. `mayManage` is whether the viewer
 * holds `sso.manage` (owners): without it, neither policy can be switched on.
 */
export function ssoControls(
  sso: SsoStatus,
  mayManage = true,
): {
  hasActiveConnection: boolean;
  hasVerifiedDomain: boolean;
  /** Why "Require single sign-on" cannot be switched on, or `null`. */
  requireUnavailable: string | null;
  /** Why "Let people join" cannot be switched on, or `null`. */
  joinUnavailable: string | null;
} {
  const hasActiveConnection = (sso.connections ?? []).some(
    (connection) => connection.state === 'active',
  );
  const hasVerifiedDomain = (sso.domains ?? []).some((domain) => domain.state === 'verified');
  const ownerOnly = 'Only an owner can switch this on.';
  const addonMissing = 'Switching this on needs the single sign-on add-on.';
  return {
    hasActiveConnection,
    hasVerifiedDomain,
    requireUnavailable: !mayManage
      ? ownerOnly
      : !sso.addon.enabled
        ? addonMissing
        : !sso.providerReachable
          ? 'WorkOS could not be reached to confirm an active connection. Try again shortly.'
          : !hasActiveConnection
            ? 'Connect an identity provider and finish its setup first — until a connection is active, requiring it would leave only owners able to sign in.'
            : !hasVerifiedDomain
              ? 'Verify at least one of your company’s domains in the setup portal first — your identity provider can only sign in addresses at a verified domain.'
              : null,
    joinUnavailable: !mayManage ? ownerOnly : !sso.addon.enabled ? addonMissing : null,
  };
}
