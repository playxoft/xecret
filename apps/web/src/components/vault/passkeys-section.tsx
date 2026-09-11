'use client';

import { useState } from 'react';

import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { Badge, Button, ConfirmDialog, KeyIcon, useToast } from '@/components/ui';
import { PasskeyEnrolment } from './passkey-enrolment';
import { removeVaultPasskey } from './vault-client';
import type { VaultPasskey } from './vault-client';
import { useVault } from './vault-keys';

/**
 * The enrolled passkeys, and the two things that can be done to the list.
 *
 * ── Why this sits with the lock and the auto-lock interval ──
 * Because they are one subject. A passkey, the idle allowance, and whatever
 * else this browser can be taught to unlock with are all answers to "how do I
 * get back in, and how soon am I asked again" — and a person who finds the
 * auto-lock picker too aggressive is a person who wants a passkey, in that
 * order, on that screen. It used to live inside the vault card with the
 * passphrase and the recovery codes, which grouped it by the machinery it
 * shares rather than by the question it answers.
 *
 * What stayed behind in the vault card is the material the *account* owns: the
 * master passphrase and the Emergency Kit, both of which are the same on every
 * device. Everything here is about this browser and the ones like it.
 */

export interface PasskeysSectionProps {
  user: { id: string; email: string; displayName: string | null };
}

export function PasskeysSection({ user }: PasskeysSectionProps) {
  const vault = useVault();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<VaultPasskey | null>(null);

  const passkeys = vault.material?.passkeys ?? [];

  async function remove() {
    if (removing === null || vault.material === null) return;
    const target = removing;

    await removeVaultPasskey(target.id);
    vault.adopt({
      material: {
        ...vault.material,
        passkeys: vault.material.passkeys.filter((passkey) => passkey.id !== target.id),
      },
    });
    toast({ variant: 'success', title: `Removed “${target.label}”` });
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-fg text-sm font-medium">Passkeys</h3>
          <p className="text-fg-subtle mt-1 text-sm leading-6">
            Each enrolled passkey holds its own encrypted copy of your key, opened by your
            authenticator. Removing one can never lock you out: your passphrase is always there and
            cannot be removed.
          </p>
        </div>

        {passkeys.length === 0 ? (
          <p className="text-fg-subtle text-sm">No passkeys enrolled.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {passkeys.map((passkey) => (
              <li
                key={passkey.id}
                className="border-line bg-canvas-inset flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3"
              >
                <KeyIcon className="text-fg-muted size-4 shrink-0" />
                <span className="text-fg text-sm font-medium">{passkey.label}</span>
                {passkey.transports?.includes('internal') ? (
                  <Badge tone="neutral">This device type</Badge>
                ) : null}
                <span className="w-full sm:hidden" />
                <span className="text-fg-subtle text-sm">
                  added{' '}
                  <time
                    dateTime={toIsoString(passkey.createdAt)}
                    title={formatAbsoluteTime(passkey.createdAt)}
                  >
                    {formatRelativeTime(passkey.createdAt)}
                  </time>
                  {passkey.lastUsedAt === null
                    ? ' · never used'
                    : ` · last used ${formatRelativeTime(passkey.lastUsedAt)}`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setRemoving(passkey)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <PasskeyEnrolment
          user={user}
          material={vault.material}
          keys={vault.keys}
          onEnrolled={(passkey) => {
            if (vault.material === null) return;
            vault.adopt({
              material: { ...vault.material, passkeys: [...vault.material.passkeys, passkey] },
            });
            toast({ variant: 'success', title: `Enrolled “${passkey.label}”` });
          }}
        />
      </div>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing === null ? 'Remove this passkey?' : `Remove “${removing.label}”?`}
        description="Its encrypted copy of your key is deleted with it. Your passphrase still opens your vault, and you can enrol the same authenticator again later."
        confirmLabel="Remove it"
        onConfirm={remove}
      />
    </>
  );
}
