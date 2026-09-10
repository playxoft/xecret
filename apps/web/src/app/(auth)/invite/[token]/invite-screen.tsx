'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type { OrgRole } from '@xecret/core/authz';
import { api, endSession, errorMessage } from '@/lib/api';
import { Alert, Button, Card, CardContent, Spinner } from '@/components/ui';
import { InviteKeyStep } from '@/components/envkeys';
import type { InviteKeyGrant } from '@/components/envkeys';
import { ROLE_LABELS } from '@/components/members/types';
import type { InvitationState } from '@/components/members/types';

/**
 * The page an invitation link opens: what you are joining, and the one button
 * that does it.
 *
 * The screen holds two facts it fetches independently — what the invitation
 * says (public lookup) and who, if anyone, is signed in — and renders the one
 * state their combination implies. Every unhappy path gets a sentence and a
 * way forward rather than a dead end: an expired link says who to ask, a
 * wrong-account session says which address is needed and offers to sign out.
 *
 * The server re-checks everything at acceptance. This screen exists to make
 * the happy path one click, not to decide anything.
 *
 * ── The step after acceptance ──
 * An invitation may carry sealed environment keys, addressed to a one-off
 * keypair whose private half exists only in the code the inviter sent by a
 * second channel. This screen holds them and offers the code entry rather than
 * navigating straight into the dashboard, because the code arriving on the same
 * device at the same moment is the case worth optimising for.
 *
 * The grants are no longer destroyed by the response that carries them — they are
 * consumed by the write that stores each re-sealed copy — so leaving this screen
 * is recoverable, and `InviteKeyStep` offers the vault ceremony inline for the
 * common case of somebody whose account is minutes old.
 *
 * Skipping is a supported outcome, not a failure: the same acceptance queued a
 * pending key share for every environment the new member can read, so a teammate
 * can hand the keys over instead.
 */

interface Lookup {
  invitation: {
    email: string;
    role: OrgRole;
    state: InvitationState;
    expiresAt: string;
  };
  organization: { name: string };
  invitedBy: { email: string; displayName: string | null } | null;
}

interface Me {
  /** `id` travels because every vault wrap's AAD binds it — see `InviteKeyStep`. */
  user: { id: string; email: string; displayName: string | null };
  vault: { configured: boolean };
}

interface AcceptResponse {
  organization: { name: string; slug: string };
  role: OrgRole;
  /** The `recipientId` bound into each grant's AAD, and the claim's key. */
  invitationId: string;
  /** Read-only. Consumed by the grant write that replaces each one. */
  inviteKeyGrants: readonly InviteKeyGrant[];
}

type Phase =
  { kind: 'loading' } | { kind: 'invalid' } | { kind: 'ready'; lookup: Lookup; viewer: Me | null };

export function InviteScreen({ token }: { token: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /**
   * What acceptance returned, while the key step is still on screen.
   *
   * Held rather than navigated past, because these grants were served once and
   * the rows behind them are already gone. Navigating first would discard the
   * only copy.
   */
  const [accepted, setAccepted] = useState<AcceptResponse | null>(null);

  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [lookup, me] = await Promise.all([
          api.post<Lookup>('/api/invitations/lookup', { token }),
          api.get<Me>('/api/auth/me', { redirectOnUnauthenticated: false }).catch(() => null),
        ]);
        if (!cancelled) setPhase({ kind: 'ready', lookup, viewer: me });
      } catch {
        if (!cancelled) setPhase({ kind: 'invalid' });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [token, reloads]);

  // Re-read the account after a vault is created or unlocked inside the key
  // step. The lookup is re-run with it, which costs one request and keeps this
  // screen to a single source of truth rather than patching `viewer` in place.
  const reloadViewer = useCallback(() => setReloads((current) => current + 1), []);

  async function accept() {
    if (accepting) return;
    setAccepting(true);
    setError(null);
    try {
      const result = await api.post<AcceptResponse>('/api/invitations/accept', { token });

      // Straight through when there is nothing to unlock: an organisation whose
      // environments are all `server`-mode, or an invitation created before the
      // two-channel flow, carries no grants and has no second step.
      if (result.inviteKeyGrants.length === 0) {
        router.replace(`/app/${encodeURIComponent(result.organization.slug)}`);
        return;
      }

      setAccepted(result);
      setAccepting(false);
    } catch (cause) {
      setError(cause);
      setAccepting(false);
    }
  }

  if (accepted !== null && phase.kind === 'ready' && phase.viewer !== null) {
    const viewer = phase.viewer;
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 py-8">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-fg text-lg font-semibold">
              You have joined {accepted.organization.name}
            </h1>
            <p className="text-fg-muted text-sm">One thing left, and it takes a moment.</p>
          </div>

          <InviteKeyStep
            orgSlug={accepted.organization.slug}
            invitationId={accepted.invitationId}
            grants={accepted.inviteKeyGrants}
            vaultGate={{
              user: viewer.user,
              configured: viewer.vault.configured,
              onChanged: reloadViewer,
            }}
            onDone={() => router.replace(`/app/${encodeURIComponent(accepted.organization.slug)}`)}
          />
        </CardContent>
      </Card>
    );
  }

  if (phase.kind === 'loading') {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-3 py-10">
          <Spinner />
          <span className="text-fg-muted text-sm">Checking the invitation…</span>
        </CardContent>
      </Card>
    );
  }

  if (phase.kind === 'invalid') {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 py-8">
          <h1 className="text-fg text-lg font-semibold">This invitation link is not valid</h1>
          <p className="text-fg-muted text-sm">
            It may have been revoked, already used, or mistyped. Ask whoever invited you to send a
            new one — invitations can be re-issued in a click.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { lookup, viewer } = phase;
  const viewerEmail = viewer?.user.email ?? null;
  const invitation = lookup.invitation;
  const inviter = lookup.invitedBy;
  const nextPath = `/invite/${encodeURIComponent(token)}`;

  if (invitation.state !== 'pending') {
    const sentence =
      invitation.state === 'accepted'
        ? 'This invitation has already been accepted.'
        : invitation.state === 'revoked'
          ? 'This invitation was revoked.'
          : 'This invitation has expired.';
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 py-8">
          <h1 className="text-fg text-lg font-semibold">{sentence}</h1>
          <p className="text-fg-muted text-sm">
            {invitation.state === 'accepted'
              ? 'If that was you, sign in and the organisation is already in your switcher.'
              : `Ask ${inviterLabel(inviter) ?? 'whoever invited you'} to send a new one.`}
          </p>
        </CardContent>
      </Card>
    );
  }

  const emailMatches = isEmailMatch(viewerEmail, invitation.email);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-8">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-fg text-lg font-semibold">
            Join {lookup.organization.name} on xecret
          </h1>
          <p className="text-fg-muted text-sm">
            {inviterLabel(inviter) ?? 'A member'} invited{' '}
            <span className="text-fg font-medium">{invitation.email}</span> to join as{' '}
            {ROLE_LABELS[invitation.role].toLowerCase()}.
          </p>
        </div>

        {error !== null ? (
          <Alert tone="danger" title="The invitation could not be accepted">
            {errorMessage(error)}
          </Alert>
        ) : null}

        {viewerEmail === null ? (
          <>
            <Button variant="primary" asChild>
              <a href={`/sign-in?next=${encodeURIComponent(nextPath)}`}>Sign in to accept</a>
            </Button>
            <p className="text-fg-subtle text-sm">
              No account yet?{' '}
              <a
                className="text-fg decoration-line-strong hover:decoration-fg underline underline-offset-4 transition-colors"
                href="/sign-up"
              >
                Create one with {invitation.email}
              </a>
              , then open this link again.
            </p>
          </>
        ) : emailMatches ? (
          <Button variant="primary" loading={accepting} onClick={() => void accept()}>
            Accept and join
          </Button>
        ) : (
          <>
            <Alert tone="warning" title="Signed in as a different account">
              You are signed in as {viewerEmail}, but this invitation is addressed to{' '}
              {invitation.email}. Sign out, then sign in with the invited address.
            </Alert>
            <Button
              variant="secondary"
              onClick={() => {
                void endSession().then(() => window.location.reload());
              }}
            >
              Sign out
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function inviterLabel(inviter: Lookup['invitedBy']): string | null {
  if (inviter === null) return null;
  return inviter.displayName ?? inviter.email;
}

/**
 * Case-insensitive, matching the server's comparison — the address column is
 * `citext`, and a page that disagreed with the API about "the same address"
 * would tell someone to sign out for nothing.
 */
function isEmailMatch(viewer: string | null, invited: string): boolean {
  return viewer !== null && viewer.toLowerCase() === invited.toLowerCase();
}
