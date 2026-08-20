'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { PIN_LENGTH } from '@xecret/core/auth';
import { api, errorMessage, isApiError } from '@/lib/api';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { PinSetupForm, PinUnlockForm } from '@/components/auth/pin-forms';
import {
  Alert,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/ui';
import { AuthCard } from '../../_components/auth-card';

/** The validated query parameters `xecret login` sent. See `page.tsx`. */
export interface AuthorizeRequest {
  challenge: string;
  port: number;
  device: string;
  state: string;
}

interface MeResponse {
  user: { email: string; displayName: string | null };
  pin: { configured: boolean; unlocked: boolean };
  organizations: Array<{ id: string; name: string; slug: string; role: string }>;
}

interface AuthorizeResponse {
  code: string;
  expiresAt: string;
}

/**
 * The consent decision.
 *
 * The redirect target is constructed from the validated port and nothing else:
 * both outcomes land on `http://127.0.0.1:{port}/callback`, which browsers
 * treat as a trustworthy loopback destination even from an HTTPS page. The
 * `state` value is echoed back so the CLI can reject a response it did not
 * initiate — its verification happens in the CLI, not here.
 */
function callbackUrl(request: AuthorizeRequest, params: Record<string, string>): string {
  const url = new URL(`http://127.0.0.1:${request.port}/callback`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('state', request.state);
  return url.toString();
}

export function AuthorizeScreen({ request }: { request: AuthorizeRequest | null }) {
  // Loaded even when the request is invalid: the 401 redirect to sign-in is
  // wanted in both cases, so the user never reads "invalid link" while
  // signed out and wonders which problem is theirs.
  const me = useApiResource<MeResponse>('/auth/me');

  const [orgSlug, setOrgSlug] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'submitting' | 'approved'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  /** Set when the server refuses an approval this page believed was unlocked. */
  const [relocked, setRelocked] = useState(false);

  const organizations = useMemo(() => me.data?.organizations ?? [], [me.data]);
  const selectedSlug = orgSlug ?? organizations[0]?.slug ?? null;

  /**
   * The PIN gate, asked here rather than pointed at.
   *
   * `xecret login` sends the browser straight to this page — through sign-in if
   * needed, and back — so the session that arrives has usually never been
   * unlocked. This screen used to answer that with a link to the dashboard,
   * which meant leaving the page the CLI had just opened, unlocking somewhere
   * else, and finding the way back. The PIN is asked for here instead, and
   * nothing else is offered until it is: an organisation switcher and an
   * Approve button above a locked session are three clicks that end in a 423.
   *
   * The condition is `!configured || !unlocked`, matching the server's gate
   * rather than the word "locked": what `authenticatedRoute` checks is whether
   * *this session* has verified a PIN, so a brand-new account with no PIN at
   * all is refused too — and is asked to choose one, not to enter one it does
   * not have. That case is reachable only from here, because signing in through
   * this flow never passes the dashboard, which is where a first PIN is
   * otherwise set up.
   */
  const pin = me.data?.pin ?? null;
  const gate: 'setup' | 'unlock' | null =
    pin === null ? null : !pin.configured ? 'setup' : !pin.unlocked || relocked ? 'unlock' : null;

  if (request === null) {
    return (
      <AuthCard
        title="This link is not usable"
        description="The authorization request is incomplete or malformed."
      >
        <p className="text-fg-muted text-sm leading-6">
          Return to your terminal and run <code className="text-fg">xecret login</code> again. If
          this page was opened from anywhere other than the xecret CLI, close it.
        </p>
      </AuthCard>
    );
  }

  const approve = async () => {
    if (selectedSlug === null) return;
    setPhase('submitting');
    setFailure(null);

    try {
      const result = await api.post<AuthorizeResponse>('/cli/authorize', {
        orgSlug: selectedSlug,
        deviceName: request.device,
        codeChallenge: request.challenge,
      });

      setPhase('approved');
      window.location.replace(callbackUrl(request, { code: result.code }));
    } catch (cause) {
      setPhase('idle');

      // The session lapsed between the `/auth/me` this page rendered from and
      // the approval — eight hours is long enough for a consent page to be left
      // open across it. Answered by showing the PIN gate rather than by an
      // error telling the user to go and unlock somewhere else.
      if (isApiError(cause) && cause.code === 'session_locked') {
        setRelocked(true);
        setFailure('Your session locked while this page was open.');
        return;
      }

      setFailure(errorMessage(cause));
    }
  };

  /** Re-reads `/auth/me`, which is what actually dismisses the PIN gate. */
  const unlocked = () => {
    setRelocked(false);
    setFailure(null);
    void me.reload();
  };

  const deny = () => {
    // Nothing to tell the server: no code exists, so there is nothing to
    // revoke. The CLI learns the outcome from the error parameter.
    window.location.replace(callbackUrl(request, { error: 'access_denied' }));
  };

  return (
    <AuthCard
      title="Authorize the xecret CLI"
      description={
        me.data ? (
          <>
            Signed in as <span className="text-fg font-medium">{me.data.user.email}</span>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        <div className="border-line rounded-lg border px-4 py-3">
          <p className="text-fg-subtle text-sm tracking-wide uppercase">Device requesting access</p>
          <p className="text-fg mt-1 truncate text-sm font-medium" title={request.device}>
            {request.device}
          </p>
        </div>

        <Alert tone="warning">
          Only approve if you just ran <code>xecret login</code> on this device. Approval lets it
          read and change secrets as you, until you revoke it.
        </Alert>

        {failure ? <Alert tone="danger">{failure}</Alert> : null}

        {gate !== null ? (
          <PinGate mode={gate} onDone={unlocked} />
        ) : (
          <>
            {me.loading ? (
              <Skeleton className="h-9 w-full" />
            ) : organizations.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-fg-muted text-sm">Organisation</span>
                <Select value={selectedSlug ?? ''} onValueChange={setOrgSlug}>
                  <SelectTrigger aria-label="Organisation">
                    <SelectValue placeholder="Choose an organisation" />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations.map((org) => (
                      <SelectItem key={org.id} value={org.slug}>
                        {org.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : organizations.length === 1 ? (
              <p className="text-fg-muted text-sm">
                Organisation: <span className="text-fg font-medium">{organizations[0]?.name}</span>
              </p>
            ) : null}

            {phase === 'approved' ? (
              <Alert tone="success">
                Approved. Return to your terminal — you can close this tab.
              </Alert>
            ) : (
              <div className="flex gap-3">
                <Button
                  className="flex-1"
                  onClick={approve}
                  loading={phase === 'submitting'}
                  disabled={me.loading || selectedSlug === null}
                >
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={deny}
                  disabled={phase === 'submitting'}
                >
                  Deny
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AuthCard>
  );
}

/**
 * The lock, inside the card.
 *
 * Deliberately the only thing offered while it is up. The organisation
 * switcher and the Approve button are not merely disabled but absent, because
 * a screen showing a decision it cannot yet carry out invites the click that
 * fails — and the failure it invites, `session_locked`, is exactly what this
 * asks for the PIN to prevent.
 *
 * Unlocking does not approve anything. Consent stays a separate, deliberate
 * act: the buttons appear once the session is open, and the person who came
 * here to approve a device still has to say so.
 */
function PinGate({ mode, onDone }: { mode: 'setup' | 'unlock'; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <p className="text-fg text-sm font-medium">
          {mode === 'unlock' ? 'Enter your PIN' : 'Choose a PIN'}
        </p>
        <p className="text-fg-muted mt-1 text-sm leading-6">
          {mode === 'unlock'
            ? 'Your session is locked. Unlock it here, then approve the device.'
            : `This account has no PIN yet. ${PIN_LENGTH} digits, and it is what opens xecret on every device you sign in on.`}
        </p>
      </div>

      {mode === 'unlock' ? <PinUnlockForm onDone={onDone} /> : <PinSetupForm onDone={onDone} />}

      {mode === 'unlock' ? (
        <p className="text-fg-subtle text-center text-sm leading-5">
          Forgot it?{' '}
          <Link href="/app" className="hover:text-fg underline">
            Reset it in the dashboard
          </Link>
          , then run <code className="text-fg">xecret login</code> again.
        </p>
      ) : null}
    </div>
  );
}
