'use client';

import { useCallback, useEffect, useState } from 'react';

import { formatAbsoluteTime, formatRelativeTime, toIsoString } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { ChangeError, PlanLock } from '@/components/plans/plan-notice';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EyeIcon,
  EyeOffIcon,
  Field,
  Input,
  PencilIcon,
  PlusIcon,
  Skeleton,
  Spinner,
  Textarea,
  TrashIcon,
  useToast,
} from '@/components/ui';
import { useVaultKeys } from '@/components/vault';
import type { VaultKeyMaterial } from '@/components/vault';
import {
  openOverride,
  overrideFailureMessage,
  overrideNameProblem,
  removeOverride,
  setOverride,
} from './override-crypto';
import type { OverrideListResponse, OverrideTarget, StoredOverride } from './override-crypto';

/**
 * How long a revealed override stays on screen, and in memory.
 *
 * The same window every other reveal in the dashboard keeps. It is the owner's
 * own value — nobody else can open it — but an unattended screen does not know
 * whose value it is showing.
 */
const REVEAL_DURATION_MS = 180_000;

/** The same mask every secret gets: fixed length, unrelated to the real one. */
const MASK = '•'.repeat(18);

export interface OverridesCardProps {
  orgSlug: string;
  /** From the session. An AAD component of every override, so nothing opens without it. */
  orgId: string | null;
  projectSlug: string;
  envSlug: string;
  /** From the environment's key state. `null` while it is still being read. */
  environmentId: string | null;
  /** From the same key state. `null` while it is still being read. */
  encryptionMode: string | null;
}

/**
 * "My overrides" — the signed-in member's own values for keys in this
 * environment (P19 §2).
 *
 * ── What the card has to make unmistakable ──
 * That an override is *personal* in the strongest sense the product has. It is
 * applied by `xecret run` on this person's machine and nowhere else; it is never
 * part of a CI fetch, an export or anything a service token reads; it is never
 * inherited by an environment that inherits from this one; and nobody else can
 * see it — not a teammate holding the environment's key, not an administrator,
 * not the server. That last one is a property of the ciphertext rather than of a
 * permission check (see `override-crypto.ts`), and the card says it in those
 * words, because "only you can see this" is a claim people rightly distrust when
 * it is only a policy.
 *
 * ── Who can do what ──
 * Anybody who may read the environment may list, reveal and remove their own.
 * *Setting* one needs the `personalOverrides` feature (Pro); without it the form
 * is locked with the plan that unlocks it, and everything else keeps working —
 * an organisation that downgraded keeps every override its members set, and
 * `xecret run` keeps applying them.
 *
 * ── The vault ──
 * Listing needs nothing but the session: names and timestamps are plaintext.
 * Revealing and setting need the vault unlocked, because the key is derived
 * from the member's own private key. A lock forgets anything revealed here.
 */
export function OverridesCard({
  orgSlug,
  orgId,
  projectSlug,
  envSlug,
  environmentId,
  encryptionMode,
}: OverridesCardProps) {
  const vault = useVaultKeys();
  const { toast } = useToast();
  const e2ee = encryptionMode === 'e2ee';
  const target: OverrideTarget = { orgSlug, projectSlug, envSlug };

  const list = useApiResource<OverrideListResponse>(
    e2ee ? apiPath.overrides(orgSlug, projectSlug, envSlug) : null,
  );

  /** The name the set dialog opened on: `''` for a new one, a name to replace one. */
  const [setting, setSetting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<StoredOverride | null>(null);

  const canSet = list.data?.canSet ?? false;
  const upgradeTo = list.data?.upgradeTo ?? null;
  /** Every AAD component this browser needs, present and unlocked. */
  const ready = vault !== null && orgId !== null && environmentId !== null;
  const overrides = list.data?.overrides ?? [];

  async function save(name: string, value: string): Promise<void> {
    if (!ready) return;
    const replacing = overrides.some((entry) => entry.name === name);
    await setOverride({ target, vault, orgId, environmentId, name, value });
    toast({
      variant: 'success',
      title: replacing ? `Replaced your override for ${name}` : `Override set for ${name}`,
      description: 'xecret run on your machine uses it from its next run.',
    });
    void list.reload();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle>My overrides</CardTitle>
          <CardDescription>
            Your own values for keys in this environment, used in place of the shared ones when{' '}
            <code className="font-mono">xecret run</code> starts a process on your machine.
            Everybody else — and every CI run — keeps getting the shared values.
          </CardDescription>
        </div>
        {e2ee && list.data !== null && canSet && ready ? (
          <Button variant="secondary" onClick={() => setSetting('')}>
            <PlusIcon className="size-4" />
            Set an override
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {encryptionMode === null ? (
          <div aria-busy="true" aria-label="Loading your overrides" className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full" />
          </div>
        ) : !e2ee ? (
          <Alert tone="info" title="Personal overrides need end-to-end encryption">
            An override is sealed under a key only your own vault can derive, so it exists only for
            environments whose values are encrypted in the browser. This one uses server-side
            encryption.
          </Alert>
        ) : (
          <>
            <Alert tone="info" title="Only you, and only on your machine">
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  Encrypted under a key derived from your own vault. A teammate who holds this
                  environment’s key cannot open one, and neither can xecret’s servers.
                </li>
                <li>
                  Applied only by <code className="font-mono">xecret run</code> when you run it,
                  signed in as you. Never part of a CI fetch, a service token’s read, an export or a
                  pull.
                </li>
                <li>
                  This environment only. An environment that inherits from this one does not inherit
                  your overrides.
                </li>
                <li>
                  A vault reset gives your account a new key pair, and overrides made before it stop
                  opening — remove them and set them again.
                </li>
              </ul>
            </Alert>

            {vault === null ? (
              <p className="text-fg-subtle text-sm">
                Unlock your vault to reveal or set an override. The list below needs no key: it
                holds names and dates, never values.
              </p>
            ) : orgId === null || environmentId === null ? (
              <p className="text-fg-subtle text-sm">Reading this environment’s key state…</p>
            ) : null}

            {list.data !== null && !canSet ? (
              <PlanLock what="Setting a personal override" upgradeTo={upgradeTo} />
            ) : null}

            {list.error !== null ? (
              <ChangeError error={list.error} title="Your overrides could not be loaded">
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={() => void list.reload()}
                >
                  Try again
                </Button>
              </ChangeError>
            ) : list.data === null ? (
              <div
                aria-busy="true"
                aria-label="Loading your overrides"
                className="flex flex-col gap-2"
              >
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : overrides.length === 0 ? (
              <p className="text-fg-subtle text-sm">
                {canSet
                  ? 'You have no overrides here. Set one to try a different value locally — a scratch database, a test key — without changing what anybody else gets.'
                  : 'You have no overrides here.'}
              </p>
            ) : (
              <ul className="border-line divide-line-subtle divide-y rounded-lg border">
                {overrides.map((override) => (
                  <li
                    // Keyed on the timestamp as well as the name, so a value
                    // replaced elsewhere remounts its row and drops anything
                    // revealed from the blob it replaced.
                    key={`${override.name}\u0000${override.updatedAt}`}
                    className="flex flex-col gap-2 px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-fg min-w-0 truncate font-mono text-sm font-medium">
                        {override.name}
                      </span>
                      <span className="text-fg-subtle text-sm whitespace-nowrap">
                        set{' '}
                        <time
                          dateTime={toIsoString(override.updatedAt)}
                          title={formatAbsoluteTime(override.updatedAt)}
                        >
                          {formatRelativeTime(override.updatedAt)}
                        </time>
                      </span>
                      <span className="flex-1" />
                      {canSet && ready ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Replace your override for ${override.name}`}
                          onClick={() => setSetting(override.name)}
                        >
                          <PencilIcon className="size-3.5" />
                          Replace
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger-text hover:text-danger-text"
                        aria-label={`Remove your override for ${override.name}`}
                        onClick={() => setRemoving(override)}
                      >
                        <TrashIcon className="size-3.5" />
                        Remove
                      </Button>
                    </div>
                    <OverrideValue
                      name={override.name}
                      vault={ready ? vault : null}
                      reveal={() =>
                        ready
                          ? openOverride({ vault, orgId, environmentId, override })
                          : Promise.reject(new Error('locked'))
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>

      <Dialog
        open={setting !== null}
        onOpenChange={(open) => (open ? undefined : setSetting(null))}
      >
        <DialogContent>
          {/* One component down, so closing the dialog unmounts the form and the
              value typed into it goes with it — nothing typed here outlives the
              dialog it was typed into. */}
          {setting !== null ? (
            <SetOverrideForm
              initialName={setting}
              envSlug={envSlug}
              existingNames={overrides.map((entry) => entry.name)}
              onCancel={() => setSetting(null)}
              onSave={async (name, value) => {
                await save(name, value);
                setSetting(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {removing !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setRemoving(null))}
          title={`Remove your override for ${removing.name}?`}
          description={`xecret run on your machine goes back to the shared value of ${removing.name} from its next run. Nobody else is affected — nobody else ever received it.`}
          confirmLabel="Remove override"
          onConfirm={async () => {
            // A refusal is thrown back to the dialog, which shows it and stays
            // open. Removing needs no key and no plan.
            await removeOverride(target, removing.name);
            toast({ variant: 'success', title: `Removed your override for ${removing.name}` });
            setRemoving(null);
            void list.reload();
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * One override's value: masked, revealed only when asked.
 *
 * The decryption happens here, in this browser, the moment the eye is pressed —
 * the list carried only the blob. The plaintext is held in this component's
 * state for the reveal window and then dropped; hiding the tab drops it too,
 * and so does the vault locking, because a value revealed under keys that have
 * since been put away should not still be on screen.
 */
function OverrideValue({
  name,
  vault,
  reveal,
}: {
  name: string;
  /** `null` when the vault is locked or the key state is not read yet. */
  vault: VaultKeyMaterial | null;
  reveal: () => Promise<string>;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A lock forgets, compared during render so the plaintext is never painted
  // for a frame under a locked vault.
  if (vault === null && value !== null) setValue(null);

  const forget = useCallback(() => setValue(null), []);

  useEffect(() => {
    if (value === null) return;
    const forgetAt = setTimeout(forget, REVEAL_DURATION_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') forget();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(forgetAt);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [value, forget]);

  async function show() {
    setProblem(null);
    setLoading(true);
    try {
      setValue(await reveal());
    } catch (cause) {
      // The named failures carry fixed sentences; anything else is collapsed
      // to one, because an arbitrary exception's message is not ours to show.
      setProblem(overrideFailureMessage(cause) ?? 'This override could not be opened.');
    } finally {
      setLoading(false);
    }
  }

  const revealed = value !== null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="border-line bg-canvas-inset min-w-0 flex-1 rounded-md border px-2.5 py-1.5">
          {revealed ? (
            <code className="text-fg block font-mono text-sm leading-5 break-all whitespace-pre-wrap">
              {value}
            </code>
          ) : (
            <>
              <span
                aria-hidden="true"
                className="text-fg-subtle block font-mono text-sm leading-5 tracking-[0.14em] select-none"
              >
                {MASK}
              </span>
              <span className="sr-only">Your override for {name} is hidden.</span>
            </>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={revealed ? forget : () => void show()}
          disabled={loading || (!revealed && vault === null)}
          title={vault === null ? 'Unlock your vault to reveal this' : undefined}
          aria-label={
            revealed ? `Hide your override for ${name}` : `Reveal your override for ${name}`
          }
        >
          {loading ? (
            <Spinner className="size-4" label={null} />
          ) : revealed ? (
            <EyeOffIcon className="size-4" />
          ) : (
            <EyeIcon className="size-4" />
          )}
        </Button>
      </div>
      {problem !== null ? (
        <p role="alert" className="text-danger-text text-sm leading-5">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The set-or-replace form.
 *
 * The name is any key the secret-name grammar allows — usually one this
 * environment already holds, but not necessarily: an override of a key nobody
 * has set yet is how somebody tries a new variable locally before proposing it.
 * A name that already has an override is a replacement, and the form says so
 * before the button is pressed rather than after.
 */
function SetOverrideForm({
  initialName,
  envSlug,
  existingNames,
  onCancel,
  onSave,
}: {
  initialName: string;
  envSlug: string;
  existingNames: readonly string[];
  onCancel: () => void;
  onSave: (name: string, value: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const trimmed = name.trim();
  const nameProblem = trimmed.length === 0 ? null : overrideNameProblem(trimmed);
  const replacing = trimmed.length > 0 && existingNames.includes(trimmed);
  const failureMessage = failure === null ? null : overrideFailureMessage(failure);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || trimmed.length === 0 || nameProblem !== null) return;

    setSaving(true);
    setFailure(null);
    try {
      await onSave(trimmed, value);
    } catch (cause) {
      // Kept here, with the form still holding what was typed: the box is the
      // only copy of the value, and closing over a failure would lose it.
      setFailure(cause);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>
          {replacing ? `Replace your override for ${trimmed}` : 'Set an override'}
        </DialogTitle>
        <DialogDescription>
          Encrypted in this browser under your own key before it is sent. Only{' '}
          <code className="font-mono">xecret run</code> on your machine, signed in as you, will use
          it — in {envSlug}, and nowhere else.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <Field
          label="Key"
          error={nameProblem}
          hint={
            replacing
              ? `You already have an override for ${trimmed}. Saving replaces it.`
              : 'Usually a key this environment holds. A new name works too — it is how you try a variable locally before adding it for everybody.'
          }
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="DATABASE_URL"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono"
            autoFocus={initialName === ''}
          />
        </Field>

        <Field label="Your value">
          <Textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            rows={3}
            placeholder="The value xecret run should use on your machine"
            // Every assistant that could carry this value somewhere else is off.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono text-sm break-all"
            autoFocus={initialName !== ''}
          />
        </Field>

        {failure !== null ? (
          failureMessage !== null ? (
            <Alert tone="danger" title="The override was not set">
              <p>{failureMessage}</p>
            </Alert>
          ) : (
            <ChangeError error={failure} title="The override was not set" />
          )
        ) : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={saving}
          disabled={trimmed.length === 0 || nameProblem !== null}
        >
          {replacing ? 'Replace override' : 'Set override'}
        </Button>
      </DialogFooter>
    </form>
  );
}
