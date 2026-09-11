'use client';

import { useState } from 'react';
import { DEVICE_PIN_LENGTH } from '@xecret/core/crypto/client';
import { DEVICE_PIN_MAX_ATTEMPTS } from '@xecret/core/auth';

import { errorMessage } from '@/lib/api';
import { formatAbsoluteTime, formatRelativeTime, pluralize, toIsoString } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  LockIcon,
  Skeleton,
  useToast,
} from '@/components/ui';
import { pinProblem, useDevicePinId } from './device-pin';
import { disablePinHere, enrolPin, revokeAllPinDevices, revokePinDevice } from './vault-client';
import type { PinDevice } from './vault-client';
import { useVault } from './vault-keys';

/**
 * The device PIN, managed from the one screen that owns every unlock method.
 *
 * ── Why the trade-off is on screen rather than in a doc ──
 * A PIN is the only credential in xecret whose security depends on the server
 * behaving: the wrap in this browser is encrypted under
 * `HKDF(pinKey ‖ pepper)`, and a server that colluded with whoever holds the
 * device could enumerate six digits. Everything else in the product is safe
 * against a compromised server by construction, and a person choosing to give
 * that up on one browser is entitled to know they are doing it. So the sentence
 * is in the hint line, not in a footnote, and it names the limit that makes the
 * trade defensible — five wrong tries and the enrolment is destroyed.
 *
 * ── Why the device list has no names ──
 * Because nothing here knows any. An enrolment is made by a browser, not by a
 * person naming a device, and deriving a label from whichever `User-Agent`
 * happened to carry the request would put a confident and frequently wrong name
 * on the row somebody uses to decide what to revoke. A short id, the dates, and
 * a badge on the one that is *this* browser are what the row honestly knows.
 */

export interface DevicePinSectionProps {
  user: { id: string };
}

interface DeviceListResponse {
  devices: PinDevice[];
}

export function DevicePinSection({ user }: DevicePinSectionProps) {
  const vault = useVault();
  const { toast } = useToast();
  const devices = useApiResource<DeviceListResponse>(apiPath.vaultPins());

  /**
   * Which enrolment, if any, is this browser's own.
   *
   * Subscribed rather than read once, and never in an initialiser: the answer is
   * in `localStorage`, which does not exist during server rendering, and it
   * changes underneath this component every time the flow below enrols or
   * revokes. See `device-pin.ts`.
   */
  const localDeviceId = useDevicePinId();
  const enrolled = localDeviceId !== null;

  const [choosing, setChoosing] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [revoking, setRevoking] = useState<PinDevice | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  function closeFlow() {
    setChoosing(false);
    setPin('');
    setConfirm('');
    setProblem(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    const fault = pinProblem(pin, confirm);
    if (fault !== null) {
      setProblem(fault);
      return;
    }

    // The User Key is what is being wrapped, so there has to be one. The button
    // is hidden while locked; this is the guard for the race where the vault
    // locks with the form open.
    if (vault.keys === null) {
      setProblem('Your vault locked. Unlock it and try again.');
      return;
    }

    setSaving(true);
    setProblem(null);
    try {
      await enrolPin({ userId: user.id, userKey: vault.keys.userKey, pin });
      closeFlow();
      devices.reload();
      toast({
        variant: 'success',
        title: enrolled ? 'PIN changed for this browser' : 'PIN set up for this browser',
      });
    } catch (cause) {
      setProblem(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function turnOffHere() {
    try {
      await disablePinHere();
      devices.reload();
      toast({ variant: 'success', title: 'PIN turned off for this browser' });
    } catch (cause) {
      toast({
        variant: 'error',
        title: 'Could not turn off the PIN',
        description: errorMessage(cause),
      });
    }
  }

  async function revoke() {
    if (revoking === null) return;
    await revokePinDevice(revoking.deviceId);
    devices.reload();
    toast({ variant: 'success', title: 'That browser can no longer use its PIN' });
  }

  async function revokeEverything() {
    const revoked = await revokeAllPinDevices();
    devices.reload();
    toast({ variant: 'success', title: `Turned off ${pluralize(revoked, 'PIN')}` });
  }

  const list = devices.data?.devices ?? [];

  return (
    <>
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-fg text-sm font-medium">PIN for this browser</h3>
          <p className="text-fg-subtle mt-1 text-sm leading-6">
            A {DEVICE_PIN_LENGTH}-digit PIN unlocks your vault on this browser without the master
            passphrase. Convenient, not as strong as your passphrase — {DEVICE_PIN_MAX_ATTEMPTS}{' '}
            wrong tries disables it. It works only here: the encrypted copy of your key never leaves
            this browser, and xecret holds the other half of what opens it.
          </p>
        </div>

        {vault.keys === null ? (
          <Alert tone="info" title="Unlock your vault to change this">
            Setting up a PIN encrypts a copy of your key, which needs the key — so it can only be
            done from an unlocked session. Turning one off does not.
          </Alert>
        ) : null}

        {choosing ? (
          <form onSubmit={save} noValidate className="flex flex-col gap-3">
            <Field
              label={enrolled ? 'New PIN' : 'Choose a PIN'}
              hint={`${DEVICE_PIN_LENGTH} digits. Avoid your birthday and 123456 — this is the one credential here that a person holding your laptop could plausibly guess.`}
              error={problem}
            >
              <Input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={DEVICE_PIN_LENGTH}
                value={pin}
                onChange={(event) =>
                  setPin(event.target.value.replace(/\D/g, '').slice(0, DEVICE_PIN_LENGTH))
                }
                autoComplete="off"
                autoFocus
                className="font-mono tracking-[0.5em]"
              />
            </Field>

            <Field label="Confirm PIN">
              <Input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={DEVICE_PIN_LENGTH}
                value={confirm}
                onChange={(event) =>
                  setConfirm(event.target.value.replace(/\D/g, '').slice(0, DEVICE_PIN_LENGTH))
                }
                autoComplete="off"
                className="font-mono tracking-[0.5em]"
              />
            </Field>

            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="primary" loading={saving}>
                {enrolled ? 'Change my PIN' : 'Set up my PIN'}
              </Button>
              <Button variant="ghost" onClick={closeFlow}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              disabled={vault.keys === null}
              onClick={() => setChoosing(true)}
            >
              {enrolled ? 'Change PIN' : 'Set up a PIN'}
            </Button>
            {enrolled ? (
              <Button variant="ghost" onClick={() => void turnOffHere()}>
                Turn off here
              </Button>
            ) : null}
          </div>
        )}

        {devices.loading && devices.data === null ? (
          <div aria-busy="true" aria-label="Loading enrolled browsers" className="space-y-2">
            <Skeleton className="h-12 w-full" />
          </div>
        ) : list.length === 0 ? (
          <p className="text-fg-subtle text-sm">No browser has a PIN.</p>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {list.map((device) => (
                <li
                  key={device.deviceId}
                  className="border-line bg-canvas-inset flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3"
                >
                  <LockIcon className="text-fg-muted size-4 shrink-0" />
                  <span className="text-fg font-mono text-sm font-medium">
                    {device.deviceId.slice(0, 8)}
                  </span>
                  {device.deviceId === localDeviceId ? (
                    <Badge tone="accent">This browser</Badge>
                  ) : null}
                  <span className="w-full sm:hidden" />
                  <span className="text-fg-subtle text-sm">
                    added{' '}
                    <time
                      dateTime={toIsoString(device.createdAt)}
                      title={formatAbsoluteTime(device.createdAt)}
                    >
                      {formatRelativeTime(device.createdAt)}
                    </time>
                    {device.lastUsedAt === null
                      ? ' · never used'
                      : ` · last used ${formatRelativeTime(device.lastUsedAt)}`}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setRevoking(device)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>

            {list.length > 1 ? (
              <div>
                <Button variant="danger-outline" size="sm" onClick={() => setRevokingAll(true)}>
                  Turn off every PIN
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Turn off this browser’s PIN?"
        description="Its encrypted copy of your key can never be opened again — not even with the correct PIN. Whoever uses that browser unlocks with the master passphrase, and can set a new PIN up afterwards."
        confirmLabel="Turn it off"
        onConfirm={revoke}
      />

      <ConfirmDialog
        open={revokingAll}
        onOpenChange={setRevokingAll}
        title="Turn off every PIN?"
        description="Every browser goes back to the master passphrase, this one included. The control for a laptop you can no longer reach."
        confirmLabel="Turn them all off"
        onConfirm={revokeEverything}
      />
    </>
  );
}
