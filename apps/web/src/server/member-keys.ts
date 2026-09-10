import { can } from '@xecret/core/authz';
import {
  listEnvironmentsForOrganization,
  listOrganizationsForUser,
  loadAuthorizationContext,
  loadMemberKeyPresence,
} from '@xecret/db/repositories';
import type { Executor } from '@xecret/db/repositories';
import type { AuditBuilder, AuditRecord } from '@xecret/core/audit';
import type { ServiceContext } from './context';
import { queueKeyShare, revokeMemberAccess } from './env-keys-service';
import { toGrantContext } from './tenancy';

/**
 * Keeping environment keys in step with who is allowed to read them.
 *
 * ── Why this is one reconciliation rather than five hooks ──
 * Five different acts change what a member may read: adding them, changing their
 * role, widening a grant, narrowing one, suspending or removing them. Each could
 * have its own key-handling branch, and each branch would be a place to get it
 * wrong — a role change that forgot to queue, a suspension that forgot to revoke.
 * Worse, they compose: a role change can widen access on one environment and
 * narrow it on another in a single request, so per-act logic would have to
 * compute the difference anyway.
 *
 * So every one of them calls the same function, which asks one question per
 * environment — *may this person read it, and do they hold its key?* — and moves
 * the world to match. It is idempotent, so calling it twice is harmless, and it
 * is total, so an act nobody thought about is still handled correctly the moment
 * it routes through here.
 *
 * ── The two outcomes, and why they are not symmetric ──
 * **Gaining access queues a debt.** It does not, and cannot, produce a key: the
 * EDK exists only inside browsers that hold a grant, and the person making the
 * access change may not be one of them. An owner who has never opened
 * `production` has nothing to seal.
 *
 * **Losing access deletes grants immediately** — and that is bookkeeping, not
 * protection. The member read what they read while they held the key, and the
 * sealed blob may still be in a browser. What actually protects future writes is
 * the rotation that must follow, which is why `GET …/keys` reports
 * `needsRotation` until one lands. Deleting the row is what stops them being
 * handed the key *again*.
 *
 * ── `server`-mode environments are skipped entirely ──
 * They have no EDK, no grants, and no queue. Their access model is enforced on
 * the routes that read secrets, and it always was.
 */

export interface KeyAccessReconciliation {
  /** Environment ids where a key share was newly queued. */
  queued: string[];
  /** Environment ids where grants were deleted, and a rotation is now owed. */
  revoked: string[];
}

/**
 * Brings one member's environment keys in line with what they may now read.
 *
 * Three reads, whatever the size of the change: the organisation's environments,
 * the member's authorization context, and where they currently hold or are owed
 * a key. Writes happen only where the two disagree, so the ordinary case — a
 * role change that alters nothing about environment access — costs three reads
 * and no writes.
 *
 * A member who is no longer in the organisation resolves to no context, and
 * `can()` is never consulted for them: absence of membership is a denial
 * everywhere, which is exactly the answer removal needs.
 *
 * ── One transaction, and what it does and does not buy ──
 * The whole reconciliation commits or none of it does. It used to be a loop of
 * untransacted statements, and a failure part-way through — the fourth
 * environment of six — left a member with grants revoked on some environments and
 * intact on others, with no record anywhere that the act was incomplete. The
 * transaction makes that state unreachable, and `revokeMemberAccess` takes the
 * same executor so its own pair of statements cannot half-happen either.
 *
 * It is **not** in the same transaction as the membership change that prompted
 * it, and cannot honestly be made so: `removeMember`, `updateMemberRole` and
 * `suspendMember` each open their own transaction inside the repository, and the
 * reconciliation deliberately runs *after* the membership write so that it reads
 * the world the change produced. Threading one transaction through both would
 * mean either the route composing a repository transaction by hand — losing the
 * last-owner guard's lock discipline — or the reconciliation deciding from a
 * membership that has not committed.
 *
 * What covers the remaining window is that this function is **total and
 * idempotent**: it asks one question per environment and moves the world to
 * match, so re-running it after a crash produces the same answer and no
 * duplicate work. And the state it would have been left in is no longer
 * invisible — `GET …/keys` reports `missingGrants` for an entitled member holding
 * no key and `needsRotation` for a holder who should not be one, both derived
 * from the rows rather than from a record of what somebody meant to do.
 */
export async function reconcileMemberKeyAccess(
  services: ServiceContext,
  params: { orgId: string; userId: string; actorUserId: string },
): Promise<KeyAccessReconciliation> {
  return services.db.transaction((tx) => reconcile(tx, params));
}

async function reconcile(
  exec: Executor,
  params: { orgId: string; userId: string; actorUserId: string },
): Promise<KeyAccessReconciliation> {
  const environments = await listEnvironmentsForOrganization(exec, params.orgId);
  const e2ee = environments.filter((environment) => environment.encryptionMode === 'e2ee');

  if (e2ee.length === 0) return { queued: [], revoked: [] };

  const context = await loadAuthorizationContext(exec, {
    orgId: params.orgId,
    userId: params.userId,
  });

  const presence = await loadMemberKeyPresence(exec, params.orgId, params.userId);

  const queued: string[] = [];
  const revoked: string[] = [];

  for (const environment of e2ee) {
    // `secret.read` is the gate, matching `GET …/keys`: holding an environment's
    // key and reading its values are the same authority, and any gap between the
    // two would be either a key somebody may not use or a value somebody may not
    // decrypt. `can()` is the same function every request goes through, so the
    // key set and the access model cannot drift.
    const allowed =
      context !== null &&
      can(
        { kind: 'user', userId: params.userId, orgId: params.orgId },
        'secret.read',
        {
          kind: 'environment',
          orgId: params.orgId,
          projectId: environment.projectId,
          environmentId: environment.id,
        },
        { membership: toGrantContext(context), isProduction: environment.isProduction },
      ).allowed;

    if (allowed) {
      // Already holds it, or is already queued: nothing to do. Checking both is
      // what makes a repeated call free rather than merely harmless.
      if (presence.granted.has(environment.id) || presence.pending.has(environment.id)) continue;

      const recorded = await queueKeyShare(exec, {
        environmentId: environment.id,
        targetUserId: params.userId,
        requestedBy: params.actorUserId,
      });
      if (recorded) queued.push(environment.id);
      continue;
    }

    // Not allowed. Delete unconditionally rather than only when `presence` says
    // there is something to delete: the presence read covers the *active* key,
    // and a grant on a retired version is exactly the stale reach a revocation
    // has to remove. `revokeMemberAccess` reports how many rows went, and only a
    // non-zero count is worth telling the audit log about.
    const removed = await revokeMemberAccess(exec, {
      orgId: params.orgId,
      environmentId: environment.id,
      userId: params.userId,
    });
    if (removed > 0) revoked.push(environment.id);
  }

  return { queued, revoked };
}

/**
 * Re-records the key debts a vault reset destroys, across every organisation the
 * account belongs to.
 *
 * ── The gap this closes ──
 * A reset deletes the account's grants *and* its queued shares, because both
 * address a public key that no longer exists. That much is right. What was wrong
 * is what it left behind: an entitled member with no grant and no pending row, in
 * every environment at once — invisible to the pending-shares banner, invisible
 * to the person themselves beyond a list of secret names that will not open, and
 * carrying nothing that would prompt a teammate to act. The reset route's own
 * copy told the user "a teammate can share those environments with you again",
 * and nothing in the system was going to tell the teammate.
 *
 * So the debts are re-recorded, in the transaction that destroyed them. It is a
 * plain restatement of a fact that is still true: this person may read these
 * environments and now holds no key for any of them.
 *
 * ── `requestedBy` is the account itself ──
 * Because it is. Nobody else changed anything; the person reset their own vault,
 * and attributing the request to whoever last touched their access would put a
 * name on the row that had nothing to do with it.
 *
 * Runs inside the reset's transaction, so an account cannot come out of a reset
 * with its grants gone and its debts unrecorded.
 */
export async function requeueKeySharesAfterVaultReset(
  exec: Executor,
  userId: string,
): Promise<string[]> {
  const memberships = await listOrganizationsForUser(exec, userId);
  const queued: string[] = [];

  for (const membership of memberships) {
    const orgId = membership.organization.id;

    const context = await loadAuthorizationContext(exec, { orgId, userId });
    if (context === null) continue;

    const environments = await listEnvironmentsForOrganization(exec, orgId);

    for (const environment of environments) {
      if (environment.encryptionMode !== 'e2ee') continue;

      const allowed = can(
        { kind: 'user', userId, orgId },
        'secret.read',
        {
          kind: 'environment',
          orgId,
          projectId: environment.projectId,
          environmentId: environment.id,
        },
        { membership: toGrantContext(context), isProduction: environment.isProduction },
      ).allowed;

      if (!allowed) continue;

      const recorded = await queueKeyShare(exec, {
        environmentId: environment.id,
        targetUserId: userId,
        requestedBy: userId,
      });
      if (recorded) queued.push(environment.id);
    }
  }

  return queued;
}

/**
 * Turns a reconciliation into audit records, filed against the environments it
 * touched.
 *
 * ── Why these are recorded at all ──
 * Both halves describe a *partial* act, and a partial act with no record is how
 * an administrator comes to believe something finished. `envkey.grant_pending`
 * says "access changed and this person still cannot read anything" — a state
 * that looks like a bug from every screen in the product, and one the access
 * grant's own record would not explain. `envkey.grant_revoked` says "their key
 * was taken away and the environment is not yet safe", which is the line an
 * incident review needs beside the rotation that should follow it.
 *
 * One record per environment, not one per act. The set is bounded by the
 * organisation's environments and these paths are not polled, so nothing here
 * can flood a partition — and collapsing them would lose *which* environment,
 * which is the only fact either event carries.
 */
export function recordKeyReconciliation(
  reconciliation: KeyAccessReconciliation,
  context: {
    orgId: string;
    audit: (orgId: string) => AuditBuilder;
    record: (...events: AuditRecord[]) => void;
    targetEmail: string;
  },
): void {
  for (const environmentId of reconciliation.queued) {
    context.record(
      context.audit(context.orgId).success(
        'envkey.grant_pending',
        { type: 'environment', id: environmentId, environmentId },
        {
          targetEmail: context.targetEmail,
          principalKind: 'member',
          reason: 'awaiting a key share from a member who holds this environment',
        },
      ),
    );
  }

  for (const environmentId of reconciliation.revoked) {
    context.record(
      context.audit(context.orgId).success(
        'envkey.grant_revoked',
        { type: 'environment', id: environmentId, environmentId },
        {
          targetEmail: context.targetEmail,
          principalKind: 'member',
          reason: 'rotation required',
        },
      ),
    );
  }
}
