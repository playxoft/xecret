'use client';

import { Alert, Button, EmptyState, KeyIcon, LockIcon } from '@/components/ui';
import { ClaimInviteKeys } from './claim-invite-keys';
import type { EnvKeyUnavailable } from './env-keys';

/**
 * What an environment says when this browser cannot read it.
 *
 * ── Three states, three different sentences ──
 * Collapsing them into "could not load" would be actively harmful. A person
 * whose vault is locked needs to unlock it; a person waiting for a key share
 * needs to know they already have access and to go and ask a colleague — telling
 * them "access denied" sends them to request permission they hold. And an
 * unkeyed `e2ee` environment is a genuine fault worth reporting rather than a
 * state to wait out.
 *
 * The lock screen already gates a locked vault at the shell level, so `locked`
 * is reached only in the narrow window where the shell has not caught up yet —
 * it is written anyway, because a screen whose failure branch depends on another
 * component having rendered first is a screen that eventually renders nothing.
 */
export function EnvKeyUnavailableState({
  reason,
  onRetry,
  target,
}: {
  reason: EnvKeyUnavailable;
  onRetry: () => void;
  /**
   * Which environment this is, when the caller knows.
   *
   * Only the `pending` branch uses it, and only to ask whether this account has
   * an unclaimed invitation key for this environment — which is the one way out
   * of that state that does not require another person. Optional so that callers
   * rendering the other four reasons are not made to supply it.
   */
  target?: { orgSlug: string; environmentId: string };
}) {
  if (reason === 'pending') {
    return (
      <EmptyState
        icon={<KeyIcon />}
        title="Waiting for a teammate to share this environment's keys"
        description={
          <>
            You have access to this environment — the names above are yours to read. Its values are
            encrypted with a key that exists only in the browsers of the people who already hold it,
            so somebody who holds it has to hand you a copy. They see a prompt to do exactly that;
            it usually takes them one click.
          </>
        }
        action={
          <div className="flex flex-col items-center gap-3">
            {/* Renders nothing unless there is genuinely an unclaimed invitation
                key for this environment, so it is invisible to everybody who
                joined without a code — which is most people. */}
            {target === undefined ? null : (
              <ClaimInviteKeys
                orgSlug={target.orgSlug}
                environmentId={target.environmentId}
                onClaimed={onRetry}
              />
            )}
            <Button variant="secondary" onClick={onRetry}>
              Check again
            </Button>
          </div>
        }
      />
    );
  }

  if (reason === 'locked') {
    return (
      <EmptyState
        icon={<LockIcon />}
        title="Your vault is locked"
        description="This environment's values are decrypted in your browser, with keys that are only available while your vault is unlocked."
        action={
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }

  if (reason === 'downgraded') {
    // No retry button, and no "continue anyway". The whole content of the
    // warning is that the server asked this browser to stop encrypting, and an
    // override beside that sentence is a button that exists to be clicked under
    // deadline pressure by somebody who has read one line of it. The way out is
    // a conversation with whoever runs the deployment, not a control here.
    return (
      <Alert tone="danger" title="This environment is no longer reporting end-to-end encryption">
        <p>
          Your browser has read this environment as end-to-end encrypted before. The server now says
          it uses server-side encryption instead, which would mean sending every value you save in{' '}
          <strong>plaintext</strong> — so nothing here will be read or written until that is
          resolved.
        </p>
        <p className="mt-2">
          There are two explanations and both need a person. Either this deployment genuinely
          migrated the environment back, in which case an administrator can tell you so and you can
          clear this site&apos;s stored data to accept it. Or the answer did not come from your
          deployment, and clearing anything would be exactly what an attacker needs.
        </p>
      </Alert>
    );
  }

  if (reason === 'unkeyed') {
    return (
      <Alert tone="danger" title="This environment has no data key">
        <p>
          It is marked end-to-end encrypted but no key was ever recorded for it, which means its
          creation was interrupted. Nothing can be written to it, and nothing can repair it — the
          key existed only in the browser that generated it. Create a new environment and delete
          this one.
        </p>
      </Alert>
    );
  }

  return null;
}

/**
 * The "a revocation is only half done" banner.
 *
 * `needsRotation` is the honest name for *somebody's grant was deleted and the
 * key they held has not been replaced*. Until a rotation lands, the person who
 * was removed can still open everything written from now on with the copy they
 * already have — the deletion stopped them being handed it *again*, and nothing
 * more. Saying that plainly is the entire job of this banner: the alternative is
 * an administrator who believes an act completed that did not.
 */
export function NeedsRotationBanner({
  onRotate,
  canRotate,
}: {
  onRotate: () => void;
  /** Rotation is `environment.update`. A developer sees the warning, not the button. */
  canRotate: boolean;
}) {
  return (
    <Alert tone="warning" title="This environment is waiting for a key rotation">
      <p>
        Somebody&apos;s access was removed or narrowed, and their grant was deleted — but the data
        key itself has not changed. The copy they already hold still opens anything written from now
        on. Rotating replaces the key and re-shares it with everyone who is still entitled to it.
      </p>
      {canRotate ? (
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={onRotate}>
            Rotate the key
          </Button>
        </div>
      ) : (
        <p className="mt-2">Ask an administrator of this environment to rotate it.</p>
      )}
    </Alert>
  );
}
