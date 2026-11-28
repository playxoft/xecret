'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { ORGANIZATION_NAME_MAX_LENGTH } from '@xecret/core/validation';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatAbsoluteTime } from '@/lib/format';
import { PageHeader } from '@/components/layout';
import { DeleteOrganizationCard, SingleSignOnCard } from '@/components/organizations';
import { PolicyCards } from '@/components/policies/policy-cards';
import { RolesCard } from '@/components/roles/roles-card';
import { WebhooksCard } from '@/components/webhooks/webhooks-card';
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
import { canAdminister, useOrganization, useSession } from './session';
import { SettingsLayout } from './settings-layout';
import { organizationSettingsSections } from './settings-sections';

/**
 * An organisation's settings: who it is, the rules and notifications that
 * apply across it, what it pays, and the two acts that change which
 * organisations exist.
 *
 * Each section is a route under `/app/{org}/settings` in the shared settings
 * frame — see `settings-sections.ts` for the list and who is shown which. This
 * module holds the frame's header and the sections that were cards on the one
 * page it replaces; billing and the plans keep their own screens.
 *
 * Creating and deleting still sit in the same area deliberately. They are the
 * two ends of an organisation's life, and somebody tidying up one organisation
 * is often about to start another, so "New organisation" is in the area's
 * header, on every section.
 */
export function OrganizationSettingsLayout({
  orgId,
  children,
}: {
  orgId: string;
  children: ReactNode;
}) {
  const membership = useOrganization(orgId);
  // The create dialog belongs to the shell, which is what has to refresh after
  // one is created — see `SessionValue.createOrganization`. This screen used to
  // mount a third copy of it, underneath the shell's two.
  const { createOrganization } = useSession();
  const groups = useMemo(
    () => organizationSettingsSections(orgId, membership),
    [orgId, membership],
  );

  return (
    <SettingsLayout
      label="Organisation settings"
      groups={groups}
      header={
        <PageHeader
          size="lg"
          title="Organisation settings"
          description="Who this organisation is, the identifier every consumer of it depends on, and the rules and notifications that apply across it."
          actions={
            <Button variant="secondary" onClick={createOrganization}>
              <PlusIcon className="size-4" />
              New organisation
            </Button>
          }
        />
      }
    >
      {children}
    </SettingsLayout>
  );
}

/**
 * The organisation as the API describes it, for the two sections that need
 * more than the session knows — its created date, and the name as stored —
 * with the loading and failure states every section of it shares.
 */
function WithOrganization({
  orgId,
  children,
}: {
  orgId: string;
  children: (organization: Organization, reload: () => void) => ReactNode;
}) {
  const organization = useApiResource<OrganizationResponse>(apiPath.org(orgId));
  const loaded = organization.data?.organization;

  if (organization.loading && organization.data === null) return <FormSkeleton />;
  if (organization.error !== null) {
    return (
      <ErrorState
        subject="this organisation"
        error={organization.error}
        onRetry={organization.reload}
      />
    );
  }
  return loaded ? <>{children(loaded, () => void organization.reload())}</> : null;
}

/** General — the name, the id that can never change, and who you are here. */
export function OrganizationGeneralSettings({ orgId }: { orgId: string }) {
  const membership = useOrganization(orgId);
  const { refresh } = useSession();
  const canManage = canAdminister(membership, 'org.update');

  return (
    <WithOrganization orgId={orgId}>
      {(loaded, reload) => (
        <div className="flex flex-col gap-6">
          <OrganizationForm
            orgId={orgId}
            organization={loaded}
            canManage={canManage}
            onSaved={() => {
              reload();
              // The switcher and the breadcrumb read the name from the session,
              // not from this screen's resource — so a rename that only reloaded
              // the latter would leave the old name in the sidebar until the
              // next full navigation.
              void refresh();
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
                  <dd className="text-fg">
                    <span className="capitalize">{loaded.role ?? 'unknown'}</span>
                    {membership?.authority.customRole ? (
                      <> · {membership.authority.customRole.name}</>
                    ) : null}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 py-2">
                  <dt className="text-fg-muted">Created</dt>
                  <dd className="text-fg">{formatAbsoluteTime(loaded.createdAt)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      )}
    </WithOrganization>
  );
}

/** Roles — the custom roles that narrow a built-in one. */
export function OrganizationRolesSettings({ orgId }: { orgId: string }) {
  return <RolesCard orgId={orgId} organization={useOrganization(orgId)} />;
}

/** Single sign-on — the identity provider, and the two policies that lean on it. */
export function OrganizationSingleSignOnSettings({ orgId }: { orgId: string }) {
  return <SingleSignOnCard orgId={orgId} organization={useOrganization(orgId)} />;
}

/**
 * Policies — the organisation's rulebook (P19 §6, §8): which service tokens may
 * be minted, and which secret names and values may be written. Read by every
 * member, because every client that writes enforces it; changed by owners and
 * admins.
 */
export function OrganizationPoliciesSettings({ orgId }: { orgId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <PolicyCards orgId={orgId} organization={useOrganization(orgId)} />
    </div>
  );
}

/**
 * Webhooks — where changes are announced (P19 §5), and the one section here
 * that sends anything out of xecret.
 */
export function OrganizationWebhooksSettings({ orgId }: { orgId: string }) {
  return <WebhooksCard orgId={orgId} organization={useOrganization(orgId)} />;
}

/**
 * Danger zone — deleting the organisation.
 *
 * `org.delete` is the single action an admin is denied (`roles.ts`), so the
 * card is drawn for an owner and nobody else — and an owner never holds a
 * custom role, so asking the capability and asking "owner?" agree. Anybody else
 * is not shown the section at all; one who arrives at its address anyway is
 * told who can, rather than shown an empty page.
 */
export function OrganizationDangerSettings({ orgId }: { orgId: string }) {
  const membership = useOrganization(orgId);
  const { refresh } = useSession();

  if (!canAdminister(membership, 'org.delete')) {
    return (
      <Alert tone="info" title="Only an owner can delete this organisation">
        <p>
          Deleting it hides every project, environment and secret inside it for every member, so it
          is kept to the people who own it.
        </p>
      </Alert>
    );
  }

  return (
    <WithOrganization orgId={orgId}>
      {(loaded) => <DeleteOrganizationCard organization={loaded} onDeleted={refresh} />}
    </WithOrganization>
  );
}

/**
 * Whether the name field holds something other than the saved name, read the
 * way a save sends it — trimmed. Save is offered only while this is true: a
 * rename to the name it already has would change nothing and still be audited
 * as one.
 */
export function organizationNameChanged(saved: string, draft: string): boolean {
  return draft.trim() !== saved;
}

/**
 * Rendered only once the organisation has loaded, so the input's initial value
 * is the stored name rather than an empty string corrected by an effect a render
 * later. That ordering matters beyond tidiness: a field that is briefly empty is
 * a field a fast typist can start editing before it is overwritten.
 *
 * ── The saved name is this form's own ──
 * Held here, and moved to what was sent the moment a save succeeds, rather than
 * read from the reloaded organisation: the reload lands a beat after the save
 * does, and for that beat a Save button compared against the old name would be
 * offering to send the new one again.
 */
export function OrganizationForm({
  orgId,
  organization,
  canManage,
  onSaved,
}: {
  orgId: string;
  organization: Organization;
  canManage: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saved, setSaved] = useState(organization.name);
  const [name, setName] = useState(organization.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const trimmed = name.trim();
  const isEmpty = trimmed.length === 0;
  const changed = organizationNameChanged(saved, name);
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
    if (saving || !changed || isEmpty || tooLong) return;

    setSaving(true);
    setError(null);
    try {
      await api.patch(apiPath.org(orgId), { name: trimmed });
      setSaved(trimmed);
      // The field holds what was sent, so a name saved with stray spaces does
      // not read as an edit the moment it is saved.
      setName(trimmed);
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
              label="Organisation ID"
              hint="Fixed for the life of the organisation. It is what every dashboard address, the API and the CLI name this organisation by, and what people enter to sign in with single sign-on. The name above can change freely, and does not have to be unique."
            >
              <Input value={organization.id} readOnly className="font-mono select-all" />
            </Field>

            {canManage ? (
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  loading={saving}
                  disabled={!changed || isEmpty || tooLong}
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
