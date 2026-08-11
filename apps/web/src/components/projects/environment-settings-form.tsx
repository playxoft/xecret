'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { pluralize } from '@/lib/format';
import { apiPath, appPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Field,
  Input,
  Separator,
  useToast,
} from '@/components/ui';
import type { EnvironmentDetail } from './types';

export interface EnvironmentSettingsFormProps {
  orgSlug: string;
  projectSlug: string;
  environment: EnvironmentDetail;
  /** Hidden for roles that certainly cannot use it. The server still decides. */
  canManage: boolean;
  onChanged: () => void;
}

const NAME_MAX_LENGTH = 100;
const SORT_ORDER_MAX = 10_000;

/**
 * Everything that can be changed about an environment, and the two things that
 * cannot.
 *
 * The slug is immutable and says so. The Env Data Key is not exposed at all —
 * there is no operation here that touches it, because destroying it is
 * cryptographic erasure of every value ever written in this environment,
 * including in every backup taken since, and that is not a button.
 */
export function EnvironmentSettingsForm({
  orgSlug,
  projectSlug,
  environment,
  canManage,
  onChanged,
}: EnvironmentSettingsFormProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState(environment.name);
  const [sortOrder, setSortOrder] = useState(String(environment.sortOrder));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reclassifying, setReclassifying] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const path = apiPath.environment(orgSlug, projectSlug, environment.slug);

  async function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    const trimmed = name.trim();
    const order = Number.parseInt(sortOrder, 10);

    if (trimmed.length === 0) {
      setError(new Error('Enter an environment name.'));
      return;
    }
    if (!Number.isInteger(order) || order < 0 || order > SORT_ORDER_MAX) {
      setError(new Error(`Display order must be a whole number between 0 and ${SORT_ORDER_MAX}.`));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.patch(path, { name: trimmed, sortOrder: order });
      toast({ variant: 'success', title: 'Environment updated' });
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  async function setProduction(next: boolean) {
    await api.patch(path, { isProduction: next });
    setReclassifying(false);
    toast({
      variant: 'success',
      title: next
        ? `${environment.name} is now production`
        : `${environment.name} is no longer production`,
      description: next
        ? 'Only admins and members with an explicit grant can read it.'
        : 'Every developer in this organisation can now read and write it.',
    });
    onChanged();
  }

  async function deleteEnvironment() {
    // The server refuses a production delete unless the slug is echoed back, and
    // accepts the field on any environment. Sending it only where it is required
    // keeps the client's rule identical to the server's.
    await api.delete(path, environment.isProduction ? { confirm: environment.slug } : undefined);
    toast({ variant: 'success', title: `Deleted ${environment.name}` });
    router.push(appPath.project(orgSlug, projectSlug));
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      {error !== null ? (
        <Alert tone="danger" title="That change was not saved">
          <p>{errorMessage(error)}</p>
          {isApiError(error) && error.requestId ? (
            <p className="mt-1.5 text-xs">
              Request id: <code className="font-mono select-all">{error.requestId}</code>
            </p>
          ) : null}
        </Alert>
      ) : null}

      <Card>
        <form onSubmit={saveDetails} noValidate>
          <CardHeader>
            <CardTitle>Details</CardTitle>
            <CardDescription>How this environment is named and ordered.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field label="Name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={NAME_MAX_LENGTH}
                autoComplete="off"
                disabled={!canManage}
              />
            </Field>

            <Field
              label="Slug"
              hint="Immutable. It is what xecret run --env takes, what .xecret.yaml records, and what every URL to this environment contains — so a rename would break every consumer that is not redeployed at the same instant."
            >
              <Input value={environment.slug} readOnly disabled className="font-mono" />
            </Field>

            <Field
              label="Display order"
              hint="Lower numbers come first, everywhere environments are listed."
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={SORT_ORDER_MAX}
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value)}
                className="max-w-28"
                disabled={!canManage}
              />
            </Field>

            {canManage ? (
              <div>
                <Button type="submit" variant="primary" loading={saving}>
                  Save changes
                </Button>
              </div>
            ) : null}
          </CardContent>
        </form>
      </Card>

      {canManage ? (
        <Card className="border-production-line">
          <CardHeader>
            <CardTitle>Classification</CardTitle>
            <CardDescription>
              {environment.isProduction
                ? 'This environment is marked production, so it is deny-by-default: only admins and members holding an explicit grant can read or write its secrets.'
                : 'This environment is not marked production. Every developer in the organisation can read and write its secrets.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-fg-muted text-sm leading-6">
              {environment.isProduction
                ? 'Removing the mark grants every developer in this organisation immediate access to the secrets already stored here. No data moves and no permission is granted individually — a boolean simply reads false, and a whole environment becomes readable.'
                : `Adding the mark takes access away from everybody below admin, including whoever is reading this, until an admin grants it back explicitly. This environment currently holds ${pluralize(environment.secretCount, 'secret')}.`}
            </p>
            <Separator className="my-4" />
            <Button
              variant={environment.isProduction ? 'danger' : 'secondary'}
              onClick={() => setReclassifying(true)}
            >
              {environment.isProduction ? 'Remove the production mark' : 'Mark as production'}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {canManage ? (
        <Card className="border-danger-line">
          <CardHeader>
            <CardTitle>Delete this environment</CardTitle>
            <CardDescription>
              Its {pluralize(environment.secretCount, 'secret')} stop being reachable. Anything
              already running keeps working until its next deploy.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete environment
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/*
        Both directions of the production flag are confirmed with the typed
        phrase, because both are the same size of mistake seen from opposite
        sides: removing the mark hands every developer the secrets that are
        already there, and adding it locks out everyone who was using them. The
        server gates the change at admin level for the same reason.
      */}
      <ConfirmDialog
        strength="production"
        confirmPhrase={environment.slug}
        open={reclassifying}
        onOpenChange={setReclassifying}
        title={
          environment.isProduction
            ? `Stop treating ${environment.name} as production?`
            : `Treat ${environment.name} as production?`
        }
        description={
          environment.isProduction
            ? 'Every developer in this organisation will be able to read and write these secrets immediately.'
            : 'Everybody below admin loses access to these secrets immediately, including you if you are not an admin.'
        }
        confirmLabel={environment.isProduction ? 'Remove the mark' : 'Mark as production'}
        confirmVariant={environment.isProduction ? 'danger' : 'primary'}
        onConfirm={() => setProduction(!environment.isProduction)}
      >
        <Alert tone="info" title="This change is recorded">
          The audit log keeps both values, so “when did production stop being production, and who
          did it?” stays answerable.
        </Alert>
      </ConfirmDialog>

      {environment.isProduction ? (
        <ConfirmDialog
          strength="production"
          confirmPhrase={environment.slug}
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${environment.name}?`}
          description={`This is a production environment holding ${pluralize(environment.secretCount, 'secret')}.`}
          confirmLabel="Delete environment"
          onConfirm={deleteEnvironment}
        >
          <EnvironmentDeleteNote />
        </ConfirmDialog>
      ) : (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${environment.name}?`}
          description={`It holds ${pluralize(environment.secretCount, 'secret')}.`}
          confirmLabel="Delete environment"
          onConfirm={deleteEnvironment}
        >
          <EnvironmentDeleteNote />
        </ConfirmDialog>
      )}
    </div>
  );
}

function EnvironmentDeleteNote() {
  return (
    <Alert tone="info" title="The values are hidden, not destroyed">
      The environment&apos;s data key stays exactly where it is, so this is reversible by an
      operator. Destroying the key — which would make every value unreadable, in every backup ever
      taken — is a separate, deliberate operation that this screen does not offer.
    </Alert>
  );
}
