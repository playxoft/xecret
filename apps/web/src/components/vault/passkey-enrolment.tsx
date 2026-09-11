'use client';

import { useMemo, useState } from 'react';
import { fromBase64Url } from '@xecret/core/crypto/client';

import { errorMessage } from '@/lib/api';
import { Alert, Button, Field, Input, KeyIcon } from '@/components/ui';
import type { VaultKeyMaterial } from './key-store';
import {
  currentPasskeyAvailability,
  enrollPasskey,
  PasskeyCancelledError,
  PasskeyUnsupportedError,
} from './passkey';
import { enrollPasskeyWrap } from './vault-client';
import type { VaultMaterial, VaultPasskey } from './vault-client';

/**
 * Enrolling a passkey, wherever that is offered.
 *
 * The same component finishes the setup ceremony and sits in the Security card,
 * because it is the same act with the same three failure modes — this browser
 * cannot do it, this authenticator cannot do it, or the person changed their
 * mind — and each of them wants a different answer:
 *
 *  - **Unsupported browser or insecure origin.** A permanent state with no
 *    button, because there is nothing to retry.
 *  - **Authenticator without PRF.** Also permanent for *that* device, and worth
 *    saying so specifically: "your passkey does not support this" sends somebody
 *    to try a different one, where "enrolment failed" sends them to support.
 *  - **Dismissed the prompt.** Not an error. The button comes back and nothing
 *    is said about it.
 *
 * ── Why it needs the keys, and what that implies about ordering ──
 * A passkey wrap holds the User Key, so one cannot be enrolled from a locked
 * session — there would be nothing to wrap. That is also the mechanism that
 * enforces "a passkey is never the only wrap": the passphrase must already exist
 * for the vault to be open at all.
 *
 * ── The two framings, and why the words differ ──
 * In the setup ceremony this is the step's whole content and the thing the
 * screen is asking for, so it is the one primary button on it and it is named
 * after what the person will actually be shown by their machine. On the
 * security page it is the last control in a list of enrolled passkeys, where
 * "Add a passkey" is the only accurate label and a second primary button would
 * put the emphasis nowhere. Same act, same failures, different prominence.
 */

export interface PasskeyEnrolmentProps {
  user: { id: string; email: string; displayName: string | null };
  material: VaultMaterial | null;
  keys: VaultKeyMaterial | null;
  onEnrolled: (passkey: VaultPasskey) => void;
  /**
   * `'offer'` is the ceremony's framing — the primary action on its screen.
   * `'manage'`, the default, is the settings list's. See the header.
   */
  framing?: 'offer' | 'manage';
}

export function PasskeyEnrolment({
  user,
  material,
  keys,
  onEnrolled,
  framing = 'manage',
}: PasskeyEnrolmentProps) {
  const availability = useMemo(() => currentPasskeyAvailability(), []);

  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ permanent: boolean; message: string } | null>(null);

  const existingCredentialIds = useMemo(
    () => (material?.passkeys ?? []).map((passkey) => fromBase64Url(passkey.credentialId)),
    [material],
  );

  if (availability === 'insecure-context') {
    return (
      <Alert tone="info" title="Passkeys need a secure connection">
        This page is not served over HTTPS, so the browser will not create a passkey. This is
        expected in local development.
      </Alert>
    );
  }

  if (availability === 'unsupported') {
    return (
      <Alert tone="info" title="This browser does not support passkeys">
        Your passphrase is all you need — a passkey only ever adds a second way in, never a
        replacement. You can enrol one later from another browser.
      </Alert>
    );
  }

  const ready = keys !== null && material !== null;

  // The ceremony's step has nothing else on it to confirm that the tap worked,
  // where the settings card announces it with a toast and grows a row in the
  // list above. `material` is the adopted copy, so this follows the enrolment
  // without any state of its own.
  const enrolledHere = framing === 'offer' && (material?.passkeys.length ?? 0) > 0;

  /**
   * The words on the button, and why the ceremony's are not "Add a passkey".
   *
   * They name what the machine is about to put in front of the person rather
   * than the word for the credential. "Use Windows Hello" is a sentence
   * somebody recognises before they have learned what a passkey is, which is
   * exactly the state they are in the first time this is offered. On the
   * settings page, among a list of enrolled passkeys, the word is the accurate
   * one and the sentence would be the odd one out.
   */
  const prominent = framing === 'offer' && !enrolledHere;
  const enrolLabel = prominent
    ? 'Use Windows Hello, Touch ID or a security key'
    : enrolledHere
      ? 'Add another passkey'
      : 'Add a passkey';

  async function enrol() {
    if (!ready || busy) return;

    setBusy(true);
    setFailure(null);
    try {
      const enrolment = await enrollPasskey({
        userId: user.id,
        email: user.email,
        displayName: user.displayName ?? user.email,
        existingCredentialIds,
      });

      const passkey = await enrollPasskeyWrap({
        userId: user.id,
        userKey: keys.userKey,
        label: label.trim().length > 0 ? label.trim() : defaultLabel(),
        credentialId: enrolment.credentialId,
        transports: enrolment.transports,
        prfOutput: enrolment.prfOutput,
      });

      setLabel('');
      onEnrolled(passkey);
    } catch (cause) {
      if (cause instanceof PasskeyCancelledError) {
        // Deliberately silent. The user said no; telling them so is noise.
        return;
      }
      // `PasskeyUnsupportedError`'s message is written for this screen and is
      // safe to show; anything else goes through `errorMessage`, which collapses
      // an arbitrary exception rather than reading a `message` that may have
      // been built from a request payload. See `lib/api.ts`.
      setFailure(
        cause instanceof PasskeyUnsupportedError
          ? { permanent: true, message: cause.message }
          : { permanent: false, message: errorMessage(cause) },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {failure !== null ? (
        <Alert
          tone={failure.permanent ? 'warning' : 'danger'}
          title={failure.permanent ? 'This device cannot do it' : 'The passkey was not enrolled'}
        >
          {failure.message}
        </Alert>
      ) : null}

      {enrolledHere ? (
        <Alert tone="success" title="This device can open your vault">
          Next time you are asked to unlock, your authenticator is one tap away.
        </Alert>
      ) : null}

      <Field
        label="Name this passkey"
        optional
        hint="Something you will recognise in the list later — “MacBook Touch ID”, “YubiKey on my keys”."
      >
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={64}
          placeholder={defaultLabel()}
        />
      </Field>

      <div>
        <Button
          // Primary and full-width only where it is the screen's own request.
          variant={prominent ? 'primary' : 'secondary'}
          size={prominent ? 'lg' : 'md'}
          // The label is a sentence rather than a word, and a phone is 320px
          // wide: the default `whitespace-nowrap` and fixed height would push
          // it off the side of the panel instead of on to a second line.
          className={prominent ? 'h-auto min-h-11 w-full py-2.5 whitespace-normal' : undefined}
          loading={busy}
          disabled={!ready}
          onClick={() => void enrol()}
        >
          <KeyIcon className="size-4 shrink-0" />
          {enrolLabel}
        </Button>
      </div>

      <p className="text-fg-subtle text-sm leading-6">
        A passkey stores a second copy of your key, encrypted so that only your authenticator can
        open it. Your passphrase keeps working either way — it is never replaced, which is why
        losing a device can never lose you the vault.
      </p>
    </div>
  );
}

/**
 * A name for a passkey the user did not name.
 *
 * The platform, not the browser: somebody choosing between two enrolled passkeys
 * six months from now is picking a *device*, and "Chrome" is the answer to a
 * question they did not ask. It is a default, and the field above is right
 * there.
 */
function defaultLabel(): string {
  if (typeof navigator === 'undefined') return 'This device';

  const agent = navigator.userAgent;
  if (/\b(iPhone|iPad)\b/.test(agent)) return 'iPhone or iPad';
  if (/\bMac OS X\b/.test(agent)) return 'Mac';
  if (/\bAndroid\b/.test(agent)) return 'Android device';
  if (/\bWindows\b/.test(agent)) return 'Windows PC';
  return 'This device';
}
