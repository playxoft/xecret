'use client';

import { useState } from 'react';

import { AUTO_LOCK_MINUTES_OPTIONS, nearestAutoLockOption } from '@xecret/core/auth';
import { api, errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  useToast,
} from '@/components/ui';
import {
  DevicePinSection,
  PasskeysSection,
  setAutoLockMinutes,
  VaultCard,
} from '@/components/vault';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { useSession } from './session';

/**
 * The Security tab: the password, the vault, the lock, and every session that
 * can currently act as this account.
 *
 * The password card talks to Firebase — the identity provider owns passwords
 * (ADR 0003) — and the module is imported *dynamically inside the submit
 * handler*, so the ~300 KB Firebase SDK stays out of this route's chunk for
 * everyone who never changes a password. Phase 5 already fought this exact
 * bundle once; the import style is the fix being kept won.
 */

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

export function SecurityScreen() {
  const { user } = useSession();

  return (
    <div className="flex flex-col gap-6">
      <PasswordCard />
      {/* The vault card lives with the rest of the vault client, in
          `components/vault`, because it is the only card on this page that
          composes cryptography: changing a passphrase re-derives Argon2id in the
          browser and re-wraps the User Key, and that machinery belongs beside
          the ceremony and the unlock screen that share it. */}
      <VaultCard user={user} />
      <LockCard />
      <DevicesCard />
    </div>
  );
}

function PasswordCard() {
  const { user } = useSession();
  const { toast } = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    if (newPassword.length < 8) {
      setProblem('Use at least 8 characters for the new password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setProblem('The new passwords do not match.');
      return;
    }

    setSaving(true);
    setProblem(null);
    try {
      // Loaded on demand — see the header comment.
      const firebase = await import('@/lib/firebase');
      await firebase.changePassword(user.email, currentPassword, newPassword);

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast({
        variant: 'success',
        title: 'Password changed',
        description:
          'Devices signed in with the old password keep their xecret sessions — revoke those below if this change was about a lost device.',
      });
    } catch (cause) {
      const firebase = await import('@/lib/firebase').catch(() => null);
      setProblem(firebase ? firebase.describeAuthError(cause) : errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} noValidate>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            For accounts that sign in with email and password. Signed in with Google? Your password
            lives with Google, and there is nothing to change here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {problem !== null ? (
            <Alert tone="danger" title="The password was not changed">
              {problem}
            </Alert>
          ) : null}

          <Field label="Current password">
            <Input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Field label="New password" hint="At least 8 characters. Length beats complexity rules.">
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>

          <div>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={currentPassword.length === 0 || newPassword.length === 0}
            >
              Change password
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}

/**
 * How each offered interval is described.
 *
 * Written out rather than computed from the number, because the last one is not
 * a duration at heart: twelve hours is what the *server* will honour, while what
 * actually ends that unlock in practice is the tab closing — the key material
 * lives in `sessionStorage` and dies with it. "After 720 minutes idle" would be
 * a true sentence about the wrong mechanism.
 */
const AUTO_LOCK_LABELS: Record<number, string> = {
  15: 'After 15 minutes idle',
  60: 'After 1 hour idle',
  240: 'After 4 hours idle',
  720: 'Until this browser closes',
};

/**
 * Everything about getting back in: what unlocks this browser, and how long it
 * stays unlocked.
 *
 * The passkeys used to sit in the vault card above, beside the passphrase they
 * share their cryptography with. They belong here instead, because a person
 * arriving at this page has one of two questions — "why does it keep asking
 * me?" or "can it stop asking me?" — and the answer to both is in this card.
 */
function LockCard() {
  const { user, vault, lock, refresh } = useSession();
  const { toast } = useToast();
  const [lockingEverywhere, setLockingEverywhere] = useState(false);
  const [savingAutoLock, setSavingAutoLock] = useState(false);

  // The item to highlight, not the raw number. A row remapped by migration 0015
  // — or, in principle, a hand-crafted PATCH — is a valid preference that names
  // no menu item, and a `Select` handed one of those renders blank, which reads
  // as "auto-lock is off" on the one screen where that must never be a guess.
  const selected = nearestAutoLockOption(vault.autoLockMinutes);

  async function changeAutoLock(minutes: number) {
    if (minutes === selected || savingAutoLock) return;
    setSavingAutoLock(true);
    try {
      // Through the vault client rather than a bare PATCH from here: that module
      // is the one place that knows this endpoint's shape, and a second caller
      // spelling the body out by hand is how the two come to disagree.
      await setAutoLockMinutes(minutes);
      toast({
        variant: 'success',
        title: `Auto-lock set to ${(AUTO_LOCK_LABELS[minutes] ?? `${pluralize(minutes, 'minute')} idle`).toLowerCase()}`,
      });
      // The idle timer runs in the shell off the session's copy of this value,
      // and so does the server's own unlock window; re-reading is what makes the
      // new interval take effect immediately rather than at the next navigation.
      refresh();
    } catch (cause) {
      toast({
        variant: 'error',
        title: 'Could not change auto-lock',
        description: errorMessage(cause),
      });
    } finally {
      setSavingAutoLock(false);
    }
  }

  async function lockEverywhere() {
    setLockingEverywhere(true);
    try {
      const result = await api.post<{ locked: number }>(apiPath.vaultLock(), { everywhere: true });
      toast({
        variant: 'success',
        title: `Locked ${pluralize(result.locked ?? 1, 'session')}`,
      });
      // This tab is among them — surface the lock screen rather than letting
      // the next request discover it as an error.
      await lock();
    } catch (cause) {
      toast({ variant: 'error', title: 'Could not lock', description: errorMessage(cause) });
    } finally {
      setLockingEverywhere(false);
    }
  }

  if (!vault.configured) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unlock &amp; auto-lock</CardTitle>
        <CardDescription>
          How this browser opens your vault, and how long it stays open. Locking asks for your
          master passphrase again without signing anything out — the control for stepping away from
          a machine, or for a device you cannot reach right now.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => void lock()}>
            Lock this device
          </Button>
          <Button variant="secondary" loading={lockingEverywhere} onClick={lockEverywhere}>
            Lock every device
          </Button>
        </div>

        <Field
          label="Auto-lock"
          hint="Locks your vault after this long without activity, on every device you use — the browser counts the idle time and the server enforces the same allowance. Your passphrase opens it again."
        >
          <Select
            value={String(selected)}
            onValueChange={(next) => void changeAutoLock(Number(next))}
            disabled={savingAutoLock}
          >
            <SelectTrigger className="w-56" aria-label="Auto-lock after">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Tightest first: the menu reads as a relaxation, ending at the
                  option that gives up the idle timer and relies on the tab. */}
              {AUTO_LOCK_MINUTES_OPTIONS.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {AUTO_LOCK_LABELS[minutes] ?? `After ${pluralize(minutes, 'minute')} idle`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {selected === 720 ? (
          <Alert tone="info" title="“Until this browser closes” has a ceiling">
            Closing the tab clears the keys, and so does eight hours — the longest any single unlock
            lasts, however busy the session is.
          </Alert>
        ) : null}

        <Separator className="my-2" />

        <PasskeysSection user={user} />

        <Separator className="my-2" />

        {/* Below the passkeys, and that order is the recommendation: a passkey
            is the stronger of the two and costs nothing to the threat model,
            while a PIN trades some of it away for convenience. */}
        <DevicePinSection user={user} />
      </CardContent>
    </Card>
  );
}

function DevicesCard() {
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
    <>
      <Card>
        <CardHeader>
          <CardTitle>Signed-in devices</CardTitle>
          <CardDescription>
            Every session that can currently act as you. Revoking one takes effect on its next
            request — xecret issues its own sessions precisely so that this works immediately, which
            a provider-issued token cannot.
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
                    <span className="text-fg-subtle text-sm">
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
                <p className="text-fg-subtle text-sm">This is the only device signed in.</p>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

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
    </>
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
