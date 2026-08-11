'use client';

import { useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
import { formatAbsoluteTime } from '@/lib/format';
import { PageHeader } from '@/components/layout';
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
  useToast,
} from '@/components/ui';
import type { Organization, OrganizationResponse } from '@/components/projects/types';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { ErrorState, FormSkeleton } from './resource-states';
import { isOrgAdmin, useOrganization } from './session';

const NAME_MAX_LENGTH = 100;

/**
 * Organisation settings: one editable field, and one that never will be.
 *
 * Members, roles, tokens and the audit log are specified in the API contract but
 * are not implemented — they land in Phases 7 and 8 — so this screen does not
 * pretend to offer them. A disabled "Members" tab would be a promise the product
 * cannot keep today.
 */
export function OrganizationSettingsScreen({ orgSlug }: { orgSlug: string }) {
  const membership = useOrganization(orgSlug);
  const organization = useApiResource<OrganizationResponse>(apiPath.org(orgSlug));

  const loaded = organization.data?.organization;
  const canManage = membership !== null && isOrgAdmin(membership.role);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Organisation settings"
        description="Who this organisation is, and the identifier every consumer of it depends on."
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
            onSaved={organization.reload}
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
        </div>
      ) : null}
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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError(new Error('Enter an organisation name.'));
      return;
    }

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
            <p className="mt-1.5 text-xs">
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
            <Field label="Organisation name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={NAME_MAX_LENGTH}
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
                <Button type="submit" variant="primary" loading={saving}>
                  Save changes
                </Button>
              </div>
            ) : (
              <p className="text-fg-subtle text-[0.8125rem]">
                Only an owner or admin can change these.
              </p>
            )}
          </CardContent>
        </form>
      </Card>
    </>
  );
}
