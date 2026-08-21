'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { PIN_LENGTH } from '@xecret/core/auth';
import { api, errorMessage, isApiError } from '@/lib/api';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { PinChooseForm, PinUnlockForm, storePin } from '@/components/auth/pin-forms';
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
 * What this card can offer, which is not always the decision it was opened for.
 *
 *  - `loading` — `/auth/me` has not answered yet.
 *  - `unreadable` — it answered with something other than an account.
 *  - `setup` / `unlock` — there is a PIN gate in the way. See `PinGate`.
 *  - `decide` — approve or deny, the thing the page exists for.
 *
 * Five states rather than "gate or no gate", because the two that are neither
 * used to collapse into "no gate": a `null` PIN status meant the Approve button
 * rendered during the first paint and after a failed read, in the one case
 * where it cannot possibly work.
 */
type Stage = 'loading' | 'unreadable' | 'setup' | 'unlock' | 'decide';

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
   * else, and finding the way back. The PIN is asked for here instead, and the
   * approval is not offered until it is answered: an organisation switcher and
   * an Approve button above a locked session are three clicks that end in the
   * 403 `session_locked` returns.
   *
   * The condition is `!configured || !unlocked`, matching the server's gate
   * rather than the word "locked": what `authenticatedRoute` checks is whether
   * *this session* has verified a PIN, so a brand-new account with no PIN at
   * all is refused too — and is asked to choose one, not to enter one it does
   * not have. That case is reachable only from here, because signing in through
   * this flow never passes the dashboard, which is where a first PIN is
   * otherwise set up.
   *
   * Not knowing is its own answer. `me.data` is null before the first response
   * and after a failed one, and reading that as "no gate needed" showed the
   * decision UI in both — a flash of Approve on first paint, and a permanent
   * dead form when `/auth/me` failed with anything the API client does not
   * redirect on.
   */
  const pin = me.data?.pin ?? null;
  const stage: Stage =
    pin === null
      ? me.error !== null
        ? 'unreadable'
        : 'loading'
      : !pin.configured
        ? 'setup'
        : !pin.unlocked || relocked
          ? 'unlock'
          : 'decide';

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

  /**
   * Re-reads `/auth/me`, which is what actually dismisses the PIN gate.
   *
   * Awaited by the form that calls it, so the button stays busy until the new
   * answer lands and the gate goes with it. A re-read that fails leaves `stage`
   * at `unreadable` rather than clearing the screen: the PIN was accepted, the
   * session *is* open, and the page has to say so rather than blank the only
   * message on it.
   */
  const unlocked = async () => {
    setRelocked(false);
    setFailure(null);
    await me.reload();
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

        {stage === 'decide' ? (
          <>
            {organizations.length > 1 ? (
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
            ) : (
              // A device is authorized *for* an organisation, so an account
              // with none cannot approve one. Rare — one is created at first
              // sign-in — but reachable once every membership is gone, and
              // Approve is disabled by `selectedSlug === null` whether or not
              // anything explains why. This is what explains why.
              <Alert tone="danger" title="No organisation to authorize for">
                This account is not in any organisation. Create one in the dashboard, then run{' '}
                <code>xecret login</code> again.
              </Alert>
            )}

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
        ) : (
          /*
           * Everything that is not the decision still ends in a decision the
           * user is allowed to make. Approve is absent here — it cannot
           * succeed — but Deny is the answer to "somebody sent me this link",
           * and it is the one this screen must never take away: without it the
           * only way out of a consent page is to abandon the tab and let
           * `xecret login` sit on its five-minute timeout, which is exactly the
           * wrong thing to make the cautious answer.
           */
          <div className="flex flex-col gap-4">
            {stage === 'loading' ? (
              <Skeleton className="h-9 w-full" />
            ) : stage === 'unreadable' ? (
              <Alert tone="danger" title="Your account could not be read">
                {errorMessage(me.error)} Nothing has been approved.
              </Alert>
            ) : (
              <PinGate
                mode={stage}
                email={me.data?.user.email ?? null}
                onUnlocked={unlocked}
              />
            )}

            {stage === 'unreadable' ? (
              <Button variant="secondary" onClick={() => void me.reload()} loading={me.loading}>
                Try again
              </Button>
            ) : null}

            <Button variant="ghost" onClick={deny}>
              Deny
            </Button>
          </div>
        )}
      </div>
    </AuthCard>
  );
}

/**
 * The lock, inside the card.
 *
 * The organisation switcher and the Approve button are not merely disabled but
 * absent, because a screen showing a decision it cannot yet carry out invites
 * the click that fails — and the failure it invites, `session_locked`, is
 * exactly what this asks for the PIN to prevent. Deny stays, above: refusing a
 * request needs no unlocked session and is the answer somebody who did not
 * expect this page should be able to give immediately.
 *
 * Unlocking does not approve anything. Consent stays a separate, deliberate
 * act: the buttons appear once the session is open, and the person who came
 * here to approve a device still has to say so.
 *
 * `setup` says what happens if the PIN is forgotten, because this is the only
 * place some accounts will ever be told. Signing in through `xecret login`
 * never passes the dashboard, where that is otherwise explained — so leaving it
 * out would mean an account-wide, unrecoverable credential chosen on a page
 * opened by a command line, with no statement of what recovering it involves.
 */
function PinGate({
  mode,
  email,
  onUnlocked,
}: {
  mode: 'setup' | 'unlock';
  email: string | null;
  onUnlocked: () => Promise<void>;
}) {
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

      {mode === 'unlock' ? (
        <PinUnlockForm onDone={onUnlocked} />
      ) : (
        <PinChooseForm
          submit={async (pin) => {
            await storePin(pin);
            await onUnlocked();
          }}
        />
      )}

      {mode === 'unlock' ? (
        <p className="text-fg-subtle text-center text-sm leading-5">
          Forgot it?{' '}
          <Link href="/app" className="hover:text-fg underline">
            Reset it in the dashboard
          </Link>
          , then run <code className="text-fg">xecret login</code> again.
        </p>
      ) : (
        <Alert tone="info" title="If you forget it">
          We will email a reset link to {email ?? 'the address on your account'}. There is no way to
          recover a PIN without access to that mailbox — nobody at xecret can read it, because only
          a derived hash is stored.
        </Alert>
      )}
    </div>
  );
}
