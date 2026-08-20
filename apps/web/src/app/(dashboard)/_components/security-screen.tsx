'use client';

import { useState } from 'react';

import { AUTO_LOCK_MINUTES_OPTIONS, PIN_LENGTH } from '@xecret/core/auth';
import { api, errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import { PinInput } from '@/components/auth/pin-input';
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
  Skeleton,
  useToast,
} from '@/components/ui';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState } from './resource-states';
import { useSession } from './session';
import type { PinResetResult } from './session';

/**
 * The Security tab: the password, the PIN, the lock, and every session that
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
  return (
    <div className="flex flex-col gap-6">
      <PasswordCard />
      <PinCard />
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

function PinCard() {
  const { user, pin, refresh } = useSession();
  const { toast } = useToast();

  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const needsCurrent = pin.configured;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    if (newPin !== confirmPin) {
      setProblem('The new PINs do not match.');
      return;
    }

    setSaving(true);
    setProblem(null);
    try {
      await api.post(apiPath.pin(), {
        pin: newPin,
        ...(needsCurrent ? { currentPin } : {}),
      });

      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      toast({
        variant: 'success',
        title: needsCurrent ? 'PIN changed' : 'PIN set',
        description: 'It takes effect the next time any of your sessions locks.',
      });
      // Everything this card renders reads from the shell's copy of
      // `/api/auth/me`, which nothing re-reads on its own. Without this, the
      // account that just set its first PIN keeps being told it has none: no
      // "Current PIN" field, no reset section — the one below being exactly
      // what that person needs next — until a full navigation. `LockCard` does
      // the same after changing the auto-lock interval.
      refresh();
    } catch (cause) {
      setProblem(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} noValidate>
        <CardHeader>
          <CardTitle>Unlock PIN</CardTitle>
          <CardDescription>
            Six digits between a signed-in device and your secrets. Changing it requires the current
            one; if you cannot remember it, reset it by email below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {problem !== null ? (
            <Alert tone="danger" title="The PIN was not changed">
              {problem}
            </Alert>
          ) : null}

          {needsCurrent ? (
            <Field label="Current PIN">
              <PinInput label="Current PIN" value={currentPin} onChange={setCurrentPin} />
            </Field>
          ) : (
            <Alert tone="info" title="No PIN yet">
              Set one now and every one of your sessions will ask for it after 8 hours idle.
            </Alert>
          )}
          <Field label="New PIN">
            <PinInput label="New PIN" value={newPin} onChange={setNewPin} />
          </Field>
          <Field label="Confirm new PIN">
            <PinInput label="Confirm new PIN" value={confirmPin} onChange={setConfirmPin} />
          </Field>

          <div>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={
                newPin.length !== PIN_LENGTH || (needsCurrent && currentPin.length !== PIN_LENGTH)
              }
            >
              {needsCurrent ? 'Change PIN' : 'Set PIN'}
            </Button>
          </div>

          {/* Only once a PIN exists: there is nothing to reset otherwise, and
              the form above is already the way to set the first one. */}
          {needsCurrent ? <PinResetSection email={user.email} /> : null}
        </CardContent>
      </form>
    </Card>
  );
}

/**
 * "I have forgotten my PIN", from a signed-in session.
 *
 * ── Why this belongs here and not only on the lock screen ──
 * The lock screen is where somebody discovers they have forgotten it, and it
 * has carried this flow all along. But it is reachable only while locked, and
 * the person who *remembers* they will forget — before a trip, after setting a
 * PIN they are unsure of — comes to their security settings and finds the change
 * form demanding the very thing they cannot supply. A dead end on the one page
 * named "Security" is worse than a redundant button.
 *
 * ── The two factors ──
 * No address is accepted or offered: the link goes to the address on the
 * account. Combined with the session cookie the requester already holds, that
 * is control of the mailbox plus control of the session — two independent
 * factors to replace a PIN, and no account-enumeration oracle, because a
 * stranger cannot reach this endpoint at all.
 */
function PinResetSection({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  async function send() {
    if (state === 'sending') return;
    setState('sending');
    setProblem(null);

    try {
      const result = await api.post<PinResetResult>(apiPath.pinReset());
      // A resolved promise is not the same as a sent email — mail is optional
      // in a self-hosted install. See `PinResetResult`.
      if (!result.sent) {
        setProblem(result.reason ?? 'A reset link could not be sent.');
        setState('idle');
        return;
      }
      setState('sent');
    } catch (cause) {
      setProblem(errorMessage(cause));
      setState('idle');
    }
  }

  return (
    <div className="border-line-subtle flex flex-col gap-3 border-t pt-4">
      {/* The success alert joins this section rather than replacing it, and the
          button stays. A provider that refuses the send now arrives here as
          `sent: false` and is shown, but that only covers the failures the
          server hears about while the request is open: a message accepted and
          then bounced, or filed as spam, is logged on the server and never
          reaches this screen — the person it happens to sees "check your email"
          and then nothing arrives. Replacing the section left them no way to
          ask again short of navigating away and back. It also matches the rest
          of this page, where the control stays put and the outcome is announced
          beside it. */}
      {state === 'sent' ? (
        <Alert tone="success" title="Check your email">
          We sent a link to {email}. It works once and expires in 15 minutes — opening it in this
          browser lets you choose a new PIN straight away.
        </Alert>
      ) : null}

      {problem !== null ? (
        <Alert tone="danger" title="Could not send the reset link">
          {problem}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button
          // Explicit, though `Button` already defaults to `type="button"` for
          // this very reason: the platform default inside a form is `submit`,
          // and this one sits inside the change-PIN form above. Saying it here
          // is documentation at the site where it matters, not a fix.
          type="button"
          variant="secondary"
          loading={state === 'sending'}
          onClick={() => void send()}
        >
          {state === 'sent' ? 'Send another link' : 'Forgot your PIN? Email me a reset link'}
        </Button>
        {state === 'sent' ? null : (
          <span className="text-fg-subtle text-sm">
            Sent to {email} — the only address it can go to.
          </span>
        )}
      </div>

      <p className="text-fg-subtle text-xs leading-5">
        Nobody at xecret can read your PIN back to you: only a derived hash is stored. Access to
        that mailbox is the one way to replace it.
      </p>
    </div>
  );
}

function LockCard() {
  const { pin, lock, refresh } = useSession();
  const { toast } = useToast();
  const [lockingEverywhere, setLockingEverywhere] = useState(false);
  const [savingAutoLock, setSavingAutoLock] = useState(false);

  async function changeAutoLock(minutes: number) {
    if (minutes === pin.autoLockMinutes || savingAutoLock) return;
    setSavingAutoLock(true);
    try {
      await api.patch(apiPath.pin(), { autoLockMinutes: minutes });
      toast({
        variant: 'success',
        title:
          minutes === 0
            ? 'Auto-lock turned off'
            : `Auto-lock set to ${pluralize(minutes, 'minute')}`,
      });
      // The idle timer runs in the shell off the session's copy of this value;
      // re-reading is what makes the new interval take effect immediately.
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
      const result = await api.post<{ locked: number }>(apiPath.pinLock(), { everywhere: true });
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

  if (!pin.configured) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lock</CardTitle>
        <CardDescription>
          Locking asks for the PIN again without signing anything out — the control for stepping
          away from a machine, or for a device you cannot reach right now.
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
          hint="Locks the dashboard after this long without activity, on every device you use. The PIN opens it again."
        >
          <Select
            value={String(pin.autoLockMinutes)}
            onValueChange={(next) => void changeAutoLock(Number(next))}
            disabled={savingAutoLock}
          >
            <SelectTrigger className="w-56" aria-label="Auto-lock after">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Intervals first, "Never" last — the menu reads as an
                  escalation ending at the option that opts out. */}
              {[...AUTO_LOCK_MINUTES_OPTIONS.filter((minutes) => minutes !== 0), 0].map(
                (minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {minutes === 0 ? 'Never' : `After ${pluralize(minutes, 'minute')} idle`}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </Field>
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
