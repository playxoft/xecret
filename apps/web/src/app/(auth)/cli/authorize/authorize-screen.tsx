'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
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

  const organizations = useMemo(() => me.data?.organizations ?? [], [me.data]);
  const selectedSlug = orgSlug ?? organizations[0]?.slug ?? null;
  const locked = me.data !== null && me.data.pin.configured && !me.data.pin.unlocked;

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
      setFailure(
        isApiError(cause) && cause.code === 'session_locked'
          ? 'Your session is locked. Unlock it in the dashboard, then approve again.'
          : errorMessage(cause),
      );
    }
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
          <p className="text-fg-subtle text-xs uppercase tracking-wide">Device requesting access</p>
          <p className="text-fg mt-1 truncate text-sm font-medium" title={request.device}>
            {request.device}
          </p>
        </div>

        <Alert tone="warning">
          Only approve if you just ran <code>xecret login</code> on this device. Approval lets it
          read and change secrets as you, until you revoke it.
        </Alert>

        {locked ? (
          <Alert tone="warning">
            Your session is locked.{' '}
            <Link href="/app" className="underline underline-offset-2">
              Unlock it in the dashboard
            </Link>{' '}
            first, then return here to approve.
          </Alert>
        ) : null}

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

        {failure ? <Alert tone="danger">{failure}</Alert> : null}

        {phase === 'approved' ? (
          <Alert tone="success">Approved. Return to your terminal — you can close this tab.</Alert>
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
      </div>
    </AuthCard>
  );
}
