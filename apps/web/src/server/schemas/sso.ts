import * as z from 'zod/mini';
import type { Organization } from '@xecret/db/repositories';
import type { SsoConnectionSummary, SsoDomainSummary } from '../workos';

/**
 * The organisation SSO settings: the one request body they accept, and the
 * status they answer with.
 *
 * Both halves together for the reason `resources.ts` gives — the status is
 * returned by every one of the four routes, and a shape written out once
 * cannot drift between them.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';
const NON_EMPTY_PATCH = 'Provide at least one field to update.';

/**
 * `PATCH /api/orgs/{orgSlug}/sso` — the two policy switches.
 *
 * Booleans and nothing else: `"true"` is a string, and a switch that read a
 * truthy string as "on" would be a policy somebody turned on without meaning
 * to. Strict, so a misspelt field is refused rather than silently ignored — a
 * caller who sent `ssoRequried: true` must not walk away believing a bypass is
 * closed.
 */
export const ssoSettingsPatchSchema = z
  .strictObject(
    {
      ssoRequired: z.optional(z.boolean()),
      jitJoinEnabled: z.optional(z.boolean()),
    },
    UNEXPECTED_FIELD,
  )
  .check(z.refine((patch) => Object.keys(patch).length > 0, { message: NON_EMPTY_PATCH }));

export type SsoSettingsPatch = z.infer<typeof ssoSettingsPatchSchema>;

/** What every SSO settings route answers with, under `sso`. */
export interface SsoStatusPayload {
  /** Whether SSO has been turned on: a WorkOS organisation exists and is linked. */
  enabled: boolean;
  /** Members must sign in through the organisation's identity provider. Owners are exempt. */
  ssoRequired: boolean;
  /** Somebody the identity provider signs in may join as a viewer, while seats last. */
  jitJoinEnabled: boolean;
  /** The seat ceiling just-in-time joins are refused against. */
  seatLimit: number;
  /**
   * Whether the organisation holds the single sign-on add-on. Needed to turn
   * SSO on, to open the setup portal, and to switch either policy on — never
   * to read this, or to switch a policy off.
   */
  addon: { enabled: boolean };
  /**
   * The identity-provider connections at WorkOS. `null` when SSO is off, or
   * when WorkOS could not be asked — see `providerReachable`.
   */
  connections: SsoConnectionSummary[] | null;
  /** The organisation's domains at WorkOS and their verification. `null` as above. */
  domains: SsoDomainSummary[] | null;
  /**
   * `false` when SSO is on but WorkOS did not answer for the two lists above.
   * The rest of this payload is this deployment's own and is always current.
   */
  providerReachable: boolean;
}

/**
 * Builds the status from the organisation row and what WorkOS said.
 *
 * Lists its fields explicitly, so the WorkOS organisation id — which nothing
 * on the client needs — cannot reach a response by being added to the row.
 */
export function toSsoStatus(
  organization: Pick<Organization, 'workosOrgId' | 'ssoRequired' | 'jitJoinEnabled' | 'seatLimit'>,
  addonEnabled: boolean,
  provider: {
    connections: SsoConnectionSummary[] | null;
    domains: SsoDomainSummary[] | null;
    reachable: boolean;
  },
): SsoStatusPayload {
  const enabled = organization.workosOrgId !== null;
  return {
    enabled,
    ssoRequired: organization.ssoRequired,
    jitJoinEnabled: organization.jitJoinEnabled,
    seatLimit: organization.seatLimit,
    addon: { enabled: addonEnabled },
    connections: enabled ? provider.connections : null,
    domains: enabled ? provider.domains : null,
    providerReachable: enabled ? provider.reachable : true,
  };
}
