import { can } from '@xecret/core/authz';
import {
  listEnvironmentsForOrganization,
  loadAuthorizationContext,
  loadMemberKeyPresence,
} from '@xecret/db/repositories';
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
 */
export async function reconcileMemberKeyAccess(
  services: ServiceContext,
  params: { orgId: string; userId: string; actorUserId: string },
): Promise<KeyAccessReconciliation> {
  const environments = await listEnvironmentsForOrganization(services.db, params.orgId);
  const e2ee = environments.filter((environment) => environment.encryptionMode === 'e2ee');

  if (e2ee.length === 0) return { queued: [], revoked: [] };

  const context = await loadAuthorizationContext(services.db, {
    orgId: params.orgId,
    userId: params.userId,
  });

  const presence = await loadMemberKeyPresence(services.db, params.orgId, params.userId);

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

      const recorded = await queueKeyShare(services, {
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
    const removed = await revokeMemberAccess(services, {
      orgId: params.orgId,
      environmentId: environment.id,
      userId: params.userId,
    });
    if (removed > 0) revoked.push(environment.id);
  }

  return { queued, revoked };
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
