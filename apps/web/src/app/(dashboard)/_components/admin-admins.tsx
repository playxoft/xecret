'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, isApiError } from '@/lib/api';
import { formatAbsoluteTime, toIsoString } from '@/lib/format';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  PlusIcon,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/components/ui';
import type { AdminUserPayload } from '@/server/schemas/admin';
import { apiPath, appPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { AdminFailure, useDialogTarget } from './admin-grant-dialogs';
import { ErrorState } from './resource-states';
import { useSession } from './session';

/**
 * The Admins tab: who xecret's admins are, and adding and removing them.
 *
 * ── An admin is an account, listed in the database ──
 * `platform_admins` (migration 0035), read on every admin request
 * (`server/admin.ts`). Any admin adds and removes the others here; an
 * operator at a shell makes the first one. Taking an account off the list
 * takes the page from it on its next request — there is nothing cached to
 * wait out.
 *
 * ── Three rules the server keeps, and this tab says out loud ──
 *  1. **Only an account that exists, with a verified address.** The person
 *     signs in to xecret once; then they are added by the address they signed
 *     in with. The server's refusal is said beside the field it is about.
 *  2. **Never the last admin.** Somebody must always be able to reach this
 *     page, so the only admin's Remove is not offered — and if two admins
 *     remove each other at once, the server's 409 is said in the dialog.
 *  3. **Every admin is emailed when the list changes**, the one added or
 *     removed included. An admin added behind the others' backs is what a
 *     taken-over admin account looks like, and the email is how it is noticed.
 *     The tab says so before anybody adds or removes anyone.
 *
 * ── Removing yourself ──
 * Allowed, and said plainly first: the page is gone the moment it is done. The
 * session is re-read — so the account menu stops offering "Admin" — and the
 * browser is taken to `/app`. `AdminScreen` shows a calm notice for the moment
 * in between, rather than the 404 a stranger would get.
 */

/** The server's own shape for an address — the server checks again, and its answer counts. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NOT_AN_ADDRESS = 'Enter the address they sign in to xecret with.';

/** What adding somebody came to: the new admin, or why not — beside the field, or for the form. */
export type AddAdminOutcome =
  { ok: true; admin: AdminUserPayload } | { ok: false; problem: string | null; error: unknown };

/**
 * Adds the account that signs in with `email`. A refusal about the address —
 * no such account, not verified, already an admin — comes back as `problem`,
 * to be said beside the field; anything else as `error`, for the form.
 */
export async function addAdmin(email: string): Promise<AddAdminOutcome> {
  const address = email.trim();
  if (!EMAIL.test(address)) return { ok: false, problem: NOT_AN_ADDRESS, error: null };
  try {
    const { admin } = await api.post<{ admin: AdminUserPayload }>(apiPath.adminAdmins(), {
      email: address,
    });
    return { ok: true, admin };
  } catch (cause) {
    const problem = isApiError(cause) ? (cause.fieldErrors()['email'] ?? null) : null;
    return { ok: false, problem, error: problem === null ? cause : null };
  }
}

/** What happens around a removal: the screen's, handed in so the order can be pinned. */
export interface RemovalEffects {
  /** Re-reads the session, so the account menu loses "Admin". Resolves once it is in. */
  refresh: () => Promise<void>;
  navigate: (href: string) => void;
  /** Re-reads this list. */
  reload: () => void;
  notify: (title: string) => void;
}

/**
 * Removes one admin. Throws what the server answered — the last admin's 409
 * included — so `ConfirmDialog` keeps itself open and says why.
 *
 * Removing yourself ends with the session re-read and then `/app`: re-read
 * first, because the session is what draws the account menu, and a page that
 * navigated on a stale one would still offer "Admin" to somebody it now 404s.
 */
export async function removeAdmin(admin: AdminUserPayload, effects: RemovalEffects): Promise<void> {
  await api.post(apiPath.adminRemoveAdmin(admin.userId));
  if (admin.you) {
    effects.notify('You are no longer an admin');
    await effects.refresh();
    effects.navigate(appPath.root());
    return;
  }
  effects.notify(`${admin.email} is no longer an admin`);
  effects.reload();
}

export function AdminsTab() {
  const { refresh } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const resource = useApiResource<{ admins: AdminUserPayload[] }>(apiPath.adminAdmins());
  const [adding, setAdding] = useState(false);
  const removing = useDialogTarget<AdminUserPayload>();
  const reload = () => void resource.reload();

  const admins = resource.data?.admins ?? null;
  const onlyOne = admins !== null && admins.length <= 1;
  const target = removing.target;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <p className="text-fg-muted max-w-2xl text-sm leading-6">
          Who can use this page. Admins add and remove each other here, and there is always at least
          one.{' '}
          <span className="text-fg font-medium">
            Every admin is emailed when this list changes.
          </span>
        </p>
        <Button variant="primary" className="shrink-0" onClick={() => setAdding(true)}>
          <PlusIcon className="size-4" />
          Add an admin
        </Button>
      </div>

      {resource.error !== null ? (
        <ErrorState subject="the admins" error={resource.error} onRetry={reload} />
      ) : admins === null ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : (
        <>
          <TableContainer aria-label="Admins">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Admin</TableHead>
                  <TableHead className="w-72">Added</TableHead>
                  <TableHead className="w-28">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {admins.map((admin) => (
                  <AdminRow
                    key={admin.userId}
                    admin={admin}
                    removable={!onlyOne}
                    onRemove={() => removing.show(admin)}
                  />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {onlyOne ? (
            <p className="text-fg-subtle text-sm">
              The only admin cannot be removed — somebody must always be able to reach this page.
              Add another first.
            </p>
          ) : null}
        </>
      )}

      <AddAdminDialog open={adding} onOpenChange={setAdding} onAdded={reload} />

      <ConfirmDialog
        open={removing.open}
        onOpenChange={removing.onOpenChange}
        {...removalCopy(target)}
        onConfirm={async () => {
          if (target === null) return;
          await removeAdmin(target, {
            refresh,
            navigate: (href) => router.replace(href),
            reload,
            notify: (title) => toast({ variant: 'success', title }),
          });
        }}
      />
    </div>
  );
}

/** What the remove dialog says — and, for yourself, that the page goes with it. */
export function removalCopy(target: AdminUserPayload | null): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  if (target?.you === true) {
    return {
      title: 'Remove yourself as an admin?',
      description:
        'You lose this page the moment it is done, and are taken back to your organisations. Only another admin can add you again. Every admin is emailed about it.',
      confirmLabel: 'Remove myself',
    };
  }
  return {
    title: target === null ? 'Remove this admin?' : `Remove ${target.email} as an admin?`,
    description:
      'They lose this page from their next request. Every admin, them included, is emailed about it.',
    confirmLabel: 'Remove',
  };
}

function AdminRow({
  admin,
  removable,
  onRemove,
}: {
  admin: AdminUserPayload;
  removable: boolean;
  onRemove: () => void;
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-fg text-sm font-medium">{admin.displayName ?? admin.email}</span>
          {admin.you ? (
            <Badge tone="accent" className="text-xs">
              You
            </Badge>
          ) : null}
        </div>
        {admin.displayName !== null ? (
          <p className="text-fg-subtle text-sm">{admin.email}</p>
        ) : null}
      </TableCell>
      <TableCell className="text-fg-muted text-sm">
        <time dateTime={toIsoString(admin.addedAt)} className="text-fg block">
          {formatAbsoluteTime(admin.addedAt)}
        </time>
        {admin.addedByEmail === null ? (
          // No admin's address to name: an operator ran `npm run admin` at a
          // shell, or the admin who added this one has since deleted their
          // account.
          <span
            className="block"
            title="From the command line, or by an account that no longer exists."
          >
            by an operator
          </span>
        ) : (
          <span className="block">by {admin.addedByEmail}</span>
        )}
      </TableCell>
      <TableCell>
        {removable ? (
          <div className="flex justify-end">
            <Button
              variant="danger-outline"
              size="sm"
              aria-label={admin.you ? 'Remove yourself as an admin' : `Remove ${admin.email}`}
              onClick={onRemove}
            >
              Remove
            </Button>
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/* ── Adding one ────────────────────────────────────────────────────────────── */

export function AddAdminDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md">
        {/* Inside the content, which unmounts on close: every opening starts
            from an empty field, not the last address tried. */}
        <AddAdminFlow
          onBusyChange={setBusy}
          onClose={() => onOpenChange(false)}
          onAdded={onAdded}
        />
      </DialogContent>
    </Dialog>
  );
}

function AddAdminFlow({
  onBusyChange,
  onClose,
  onAdded,
}: {
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setProblem(null);
    setError(null);
    const outcome = await addAdmin(email);
    setBusy(false);
    onBusyChange(false);
    if (!outcome.ok) {
      setProblem(outcome.problem);
      setError(outcome.error);
      return;
    }
    toast({ variant: 'success', title: `${outcome.admin.email} is now an admin` });
    onAdded();
    onClose();
  }

  return (
    <AddAdminForm
      email={email}
      onEmailChange={(next) => {
        setEmail(next);
        setProblem(null);
      }}
      problem={problem}
      error={error}
      busy={busy}
      onCancel={onClose}
      onSubmit={submit}
    />
  );
}

/**
 * The form itself, with everything it shows handed in — so what a refusal
 * looks like beside the field is pinned by its test without a browser.
 */
export function AddAdminForm({
  email,
  onEmailChange,
  problem,
  error,
  busy,
  onCancel,
  onSubmit,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  /** The server's sentence about the address, said beside the field. */
  problem: string | null;
  /** Any other failure, said for the form. */
  error: unknown;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>Add an admin</DialogTitle>
        <DialogDescription>
          An admin can give any organisation a free plan, issue and revoke promo codes, and add and
          remove admins — you included. Every admin is emailed when this list changes.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Field
          label="Email address"
          error={problem}
          hint="The address they sign in to xecret with. They must have signed in once, and verified it."
        >
          <Input
            type="email"
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
            placeholder="ada@example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
        </Field>
        {error !== null && error !== undefined ? (
          <AdminFailure error={error} title="Nobody was added" />
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Make them an admin
        </Button>
      </DialogFooter>
    </form>
  );
}
