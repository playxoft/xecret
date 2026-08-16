'use client';

import { useState } from 'react';

import { ORGANIZATION_NAME_MAX_LENGTH } from '@xecret/core/validation';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatAbsoluteTime } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import { CreateOrganizationDialog, DeleteOrganizationCard } from '@/components/organizations';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  PlusIcon,
  useToast,
} from '@/components/ui';
import type { Organization, OrganizationResponse } from '@/components/projects/types';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState, FormSkeleton } from './resource-states';
import { isOrgAdmin, useOrganization, useSession } from './session';

/**
 * Organisation settings: one editable field, one that never will be, and the
 * two acts that change which organisations exist.
 *
 * Creating and deleting sit on the same screen deliberately. They are the two
 * ends of an organisation's life, and the person who has just discovered that
 * the slug is permanent is exactly the person who wants to start over with a
 * different name.
 */
export function OrganizationSettingsScreen({ orgSlug }: { orgSlug: string }) {
  const membership = useOrganization(orgSlug);
  const { refresh } = useSession();
  const organization = useApiResource<OrganizationResponse>(apiPath.org(orgSlug));
  const [creating, setCreating] = useState(false);

  const loaded = organization.data?.organization;
  const canManage = membership !== null && isOrgAdmin(membership.role);
  // Not `isOrgAdmin`: deleting an organisation is the single action an admin is
  // denied (`roles.ts`), so the card is drawn for an owner and nobody else.
  const canDelete = membership?.role === 'owner';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Organisation settings"
        description="Who this organisation is, and the identifier every consumer of it depends on."
        actions={
          <Button variant="secondary" onClick={() => setCreating(true)}>
            <PlusIcon className="size-4" />
            New organisation
          </Button>
        }
      />

      {organization.loading && organization.data === null ? (
        <FormSkeleton />
      ) : organization.error !== null ? (
        <ErrorState
          subject="this organisation"
          error={organization.error}
          onRetry={organization.reload}
        />
      ) : loaded ? (
        <div className="flex max-w-2xl flex-col gap-6">
          <OrganizationForm
            orgSlug={orgSlug}
            organization={loaded}
            canManage={canManage}
            onSaved={() => {
              organization.reload();
              // The switcher and the breadcrumb read the name from the session,
              // not from this screen's resource — so a rename that only reloaded
              // the latter would leave the old name in the sidebar until the
              // next full navigation.
              refresh();
            }}
          />

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="text-sm">
                <div className="border-line-subtle flex justify-between gap-4 border-b py-2">
                  <dt className="text-fg-muted">Your role</dt>
                  <dd className="text-fg capitalize">{loaded.role ?? 'unknown'}</dd>
                </div>
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-fg-muted">Created</dt>
                  <dd className="text-fg">{formatAbsoluteTime(loaded.createdAt)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {canDelete ? <DeleteOrganizationCard organization={loaded} onDeleted={refresh} /> : null}
        </div>
      ) : null}

      <CreateOrganizationDialog open={creating} onOpenChange={setCreating} onCreated={refresh} />
    </div>
  );
}

/**
 * Rendered only once the organisation has loaded, so the input's initial value
 * is the stored name rather than an empty string corrected by an effect a render
 * later. That ordering matters beyond tidiness: a field that is briefly empty is
 * a field a fast typist can start editing before it is overwritten.
 */
function OrganizationForm({
  orgSlug,
  organization,
  canManage,
  onSaved,
}: {
  orgSlug: string;
  organization: Organization;
  canManage: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(organization.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const trimmed = name.trim();
  const isEmpty = trimmed.length === 0;
  /**
   * An organisation created before this limit existed — or by a sign-up that
   * took its name from a long identity-provider profile — can arrive here
   * already over it.
   *
   * `maxLength` on the input stops such a name growing but does not shorten
   * one that is already there, which is the right way round: silently trimming
   * somebody's organisation name because they opened a settings page would be a
   * rename nobody asked for. So the field states the problem and Save stays
   * disabled until it is fixed, and deleting characters is all that is needed.
   */
  const tooLong = trimmed.length > ORGANIZATION_NAME_MAX_LENGTH;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || isEmpty || tooLong) return;

    setSaving(true);
    setError(null);
    try {
      await api.patch(apiPath.org(orgSlug), { name: trimmed });
      toast({ variant: 'success', title: 'Organisation updated' });
      onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {error !== null ? (
        <Alert tone="danger" title="That change was not saved">
          <p>{errorMessage(error)}</p>
          {isApiError(error) && error.requestId ? (
            <p className="mt-1.5 text-sm">
              Request id: <code className="font-mono select-all">{error.requestId}</code>
            </p>
          ) : null}
        </Alert>
      ) : null}

      <Card>
        <form onSubmit={handleSubmit} noValidate>
          <CardHeader>
            <CardTitle>Name</CardTitle>
            <CardDescription>
              Shown in the organisation switcher and on every screen inside it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field
              label="Organisation name"
              error={
                tooLong
                  ? `Shorten this to ${ORGANIZATION_NAME_MAX_LENGTH} characters or fewer.`
                  : null
              }
              hint={`${name.length} of ${ORGANIZATION_NAME_MAX_LENGTH} characters.`}
            >
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={ORGANIZATION_NAME_MAX_LENGTH}
                autoComplete="organization"
                disabled={!canManage}
              />
            </Field>

            <Field
              label="Slug"
              hint="Permanent. It is in every dashboard and API URL, in the .xecret.yaml committed to each repository, and in the CI configuration of everyone who consumes this organisation — so a rename would break all of them the instant it took effect, and the API does not offer one."
            >
              <Input value={organization.slug} readOnly disabled className="font-mono" />
            </Field>

            {canManage ? (
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  loading={saving}
                  disabled={isEmpty || tooLong}
                >
                  Save changes
                </Button>
              </div>
            ) : (
              <p className="text-fg-subtle text-sm">Only an owner or admin can change these.</p>
            )}
          </CardContent>
        </form>
      </Card>
    </>
  );
}
