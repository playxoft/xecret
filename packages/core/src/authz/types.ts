/**
 * Authorization types.
 *
 * The engine lands in Phase 4. There is exactly one `can()` function in the
 * system and every protected route calls it — no route implements its own check
 * (threat T2, the most likely real breach).
 *
 * See docs/architecture/database-schema.md §6.
 */

export type OrgRole = 'owner' | 'admin' | 'developer' | 'viewer';

export type AccessLevel = 'none' | 'read' | 'write' | 'admin';

/** Every permission the system recognises. Additive only. */
export type Action =
  | 'project.read'
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'environment.read'
  | 'environment.create'
  | 'environment.update'
  | 'environment.delete'
  | 'secret.read'
  | 'secret.create'
  | 'secret.update'
  | 'secret.delete'
  | 'secret.rotate'
  | 'member.read'
  | 'member.invite'
  | 'member.update'
  | 'member.remove'
  | 'audit.read'
  | 'token.create'
  | 'token.revoke'
  | 'org.update'
  | 'org.delete'
  /**
   * Administering the organisation's single sign-on: turning it on, minting a
   * setup-portal link, switching a sign-in policy on. Whoever holds it decides
   * which identity provider vouches for the organisation's members — an
   * identity provider that can then sign anybody in as any of them, owners
   * included — so it is held by owners alone, and no custom role can carry it
   * (none is based on `owner`). Reading the settings and switching a policy
   * *off* stay with `org.update`.
   */
  | 'sso.manage'
  /**
   * Managing what the organisation pays for (P12): reading the billing
   * screen, starting a checkout, changing plan, opening the payment provider's
   * customer portal. Held by owners alone, and no custom role can carry it.
   *
   * Owner-only because each of those spends the organisation's money, and the
   * customer portal is where the card is changed and the subscription
   * cancelled — an admin who could open it could cancel the plan out from
   * under the owner who pays for it. Admins see nothing billing-related beyond
   * what a refusal says; that is the price of the rule being enforced by
   * capability rather than by hiding a link.
   */
  | 'billing.manage';

/**
 * Who is acting.
 *
 * Service tokens carry no user identity by construction, so a stolen CI
 * credential can never act as a person (threat T5).
 */
export type Actor =
  | { kind: 'user'; userId: string; orgId: string }
  | { kind: 'cliToken'; tokenId: string; userId: string; orgId: string }
  | {
      kind: 'serviceToken';
      tokenId: string;
      orgId: string;
      projectId: string;
      environmentId: string;
    };

/** What is being acted upon. */
export type Resource =
  | { kind: 'org'; orgId: string }
  | { kind: 'project'; orgId: string; projectId: string }
  | { kind: 'environment'; orgId: string; projectId: string; environmentId: string };

/**
 * Denial reason.
 *
 * `notFound` exists because returning 403 for a cross-tenant resource confirms
 * it exists, which is itself a leak. Callers translate `notFound` to HTTP 404.
 */
export type Decision =
  { allowed: true } | { allowed: false; reason: 'notFound' | 'forbidden'; message: string };
