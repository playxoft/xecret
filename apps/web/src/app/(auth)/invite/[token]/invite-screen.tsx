'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { OrgRole } from '@xecret/core/authz';
import { api, endSession, errorMessage } from '@/lib/api';
import { Alert, Button, Card, CardContent, Spinner } from '@/components/ui';
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
  user: { email: string };
}

interface AcceptResponse {
  organization: { name: string; slug: string };
  role: OrgRole;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'ready'; lookup: Lookup; viewerEmail: string | null };

export function InviteScreen({ token }: { token: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [lookup, me] = await Promise.all([
          api.post<Lookup>('/api/invitations/lookup', { token }),
          api
            .get<Me>('/api/auth/me', { redirectOnUnauthenticated: false })
            .then((response) => response.user.email)
            .catch(() => null),
        ]);
        if (!cancelled) setPhase({ kind: 'ready', lookup, viewerEmail: me });
      } catch {
        if (!cancelled) setPhase({ kind: 'invalid' });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept() {
    if (accepting) return;
    setAccepting(true);
    setError(null);
    try {
      const accepted = await api.post<AcceptResponse>('/api/invitations/accept', { token });
      router.replace(`/app/${encodeURIComponent(accepted.organization.slug)}`);
    } catch (cause) {
      setError(cause);
      setAccepting(false);
    }
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

  const { lookup, viewerEmail } = phase;
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
