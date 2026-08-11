'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import { THEME_LABELS } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import { PageHeader, useTheme } from '@/components/layout';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Field,
  Input,
  MonitorIcon,
  MoonIcon,
  Skeleton,
  SunIcon,
  useToast,
} from '@/components/ui';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { useSession } from './session';

interface DeviceSession {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
}

interface SessionsResponse {
  sessions: readonly DeviceSession[];
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; Icon: typeof SunIcon }> = [
  { value: 'light', Icon: SunIcon },
  { value: 'dark', Icon: MoonIcon },
  { value: 'system', Icon: MonitorIcon },
];

export function AccountScreen() {
  const { user } = useSession();
  const { preference, setPreference } = useTheme();
  const { toast } = useToast();

  const sessions = useApiResource<SessionsResponse>(apiPath.sessions());
  const [signingOutOthers, setSigningOutOthers] = useState(false);

  const others = sessions.data?.sessions.filter((session) => !session.current) ?? [];

  async function signOutOtherDevices() {
    // `except=current` rather than a blanket revoke: this is the control someone
    // reaches for after losing a laptop, and signing themselves out of the tab
    // they are using to do it would be an unhelpful way to succeed.
    const result = await api.delete<{ revoked: number }>(`${apiPath.sessions()}?except=current`);
    toast({
      variant: 'success',
      title: `Signed out ${pluralize(result.revoked, 'device')}`,
      description: 'Those sessions are revoked immediately, not when they expire.',
    });
    sessions.reload();
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Account"
        description="Your profile, how xecret looks, and where you are signed in."
      />

      <div className="flex max-w-2xl flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              Your identity comes from your sign-in provider. xecret stores a copy so it can show
              who did what, and does not let you edit it here — changing it in one place and not the
              other would make the audit log disagree with your account.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Name">
              <Input value={user.displayName ?? ''} readOnly disabled placeholder="Not set" />
            </Field>
            <Field label="Email">
              <Input value={user.email} readOnly disabled />
            </Field>
            {user.emailVerified ? null : (
              <Alert tone="warning" title="This address is not verified">
                Sign out and follow the link in the verification email. An unverified address cannot
                start a new session.
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>
              Stored in this browser only, so it never travels with your account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* A radio group rather than a toggle: "System" is a third state, and
                it is the one most people want back once they have left it. */}
            <fieldset>
              <legend className="sr-only">Theme</legend>
              <div className="flex flex-wrap gap-2">
                {THEME_OPTIONS.map(({ value, Icon }) => (
                  <label
                    key={value}
                    className={
                      preference === value
                        ? 'border-accent bg-accent-tint text-accent-text flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium'
                        : 'border-line text-fg-muted hover:bg-surface-hover flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition-colors'
                    }
                  >
                    <input
                      type="radio"
                      name="theme"
                      value={value}
                      checked={preference === value}
                      onChange={() => setPreference(value)}
                      className="sr-only"
                    />
                    <Icon aria-hidden="true" className="size-4" />
                    {THEME_LABELS[value]}
                  </label>
                ))}
              </div>
            </fieldset>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Signed-in devices</CardTitle>
            <CardDescription>
              Every session that can currently act as you. Revoking one takes effect on its next
              request — xecret issues its own sessions precisely so that this works immediately,
              which a provider-issued token cannot.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {sessions.loading && sessions.data === null ? (
              <div aria-busy="true" aria-label="Loading devices" className="space-y-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : sessions.error !== null ? (
              <ErrorState
                subject="your signed-in devices"
                error={sessions.error}
                onRetry={sessions.reload}
              />
            ) : sessions.data !== null ? (
              <>
                <ul className="flex flex-col gap-2">
                  {sessions.data.sessions.map((session) => (
                    <li
                      key={session.id}
                      className="border-line bg-canvas-inset flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3"
                    >
                      <span className="text-fg text-sm font-medium">
                        {describeUserAgent(session.userAgent)}
                      </span>
                      {session.current ? <Badge tone="accent">This device</Badge> : null}
                      <span className="w-full" />
                      <span className="text-fg-subtle text-xs">
                        {session.ipAddress ?? 'IP not recorded'} · last seen{' '}
                        <time
                          dateTime={toIsoString(session.lastSeenAt)}
                          title={formatAbsoluteTime(session.lastSeenAt)}
                        >
                          {formatRelativeTime(session.lastSeenAt)}
                        </time>
                      </span>
                    </li>
                  ))}
                </ul>

                {others.length > 0 ? (
                  <div>
                    <Button variant="danger" onClick={() => setSigningOutOthers(true)}>
                      Sign out {pluralize(others.length, 'other device')}
                    </Button>
                  </div>
                ) : (
                  <p className="text-fg-subtle text-[0.8125rem]">
                    This is the only device signed in.
                  </p>
                )}
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={signingOutOthers}
        onOpenChange={setSigningOutOthers}
        title="Sign out every other device?"
        description="Every other session is revoked immediately. Anyone using one — including you, on another machine — will have to sign in again."
        confirmLabel="Sign them out"
        onConfirm={signOutOtherDevices}
      >
        <Alert tone="info" title="This session stays">
          The browser you are reading this in keeps its session, so you will not be signed out of
          this tab.
        </Alert>
      </ConfirmDialog>
    </div>
  );
}

/**
 * A short, recognisable name for a user agent string.
 *
 * Deliberately a handful of substring checks rather than a parsing library: the
 * only question this answers is "is that one of mine?", and for that a person
 * needs to recognise their own browser and platform, not to be told the exact
 * build. Anything unrecognised falls back to the raw string, truncated — a wrong
 * guess would be worse than an ugly one on the screen where somebody decides
 * whether a session is an intruder.
 */
function describeUserAgent(userAgent: string | null): string {
  if (userAgent === null || userAgent.trim().length === 0) return 'Unknown device';

  const browser = /\bEdg\//.test(userAgent)
    ? 'Edge'
    : /\bOPR\//.test(userAgent)
      ? 'Opera'
      : /\bFirefox\//.test(userAgent)
        ? 'Firefox'
        : /\bChrome\//.test(userAgent)
          ? 'Chrome'
          : /\bSafari\//.test(userAgent)
            ? 'Safari'
            : /\bxecret-cli\b/i.test(userAgent)
              ? 'xecret CLI'
              : null;

  const platform = /\bWindows\b/.test(userAgent)
    ? 'Windows'
    : /\b(iPhone|iPad)\b/.test(userAgent)
      ? 'iOS'
      : /\bMac OS X\b/.test(userAgent)
        ? 'macOS'
        : /\bAndroid\b/.test(userAgent)
          ? 'Android'
          : /\bLinux\b/.test(userAgent)
            ? 'Linux'
            : null;

  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return platform;
  return userAgent.length > 48 ? `${userAgent.slice(0, 48)}…` : userAgent;
}
