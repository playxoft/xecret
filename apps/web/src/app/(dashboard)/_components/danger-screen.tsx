'use client';

import { useMemo, useState } from 'react';

import { api, errorMessage, isApiError } from '@/lib/api';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@/components/ui';
import { apiPath } from '../_lib/paths';
import { useApiResource } from '../_lib/use-api-resource';
import { isOrgAdmin, useSession } from './session';

/**
 * The Danger zone: the two deletions, together and clearly fenced.
 *
 * Both follow the product's destructive-action contract — type the identifier,
 * then confirm — and neither trusts the client: the server re-checks the
 * confirmation, the permission, and (for the account) whether any organisation
 * would be stranded. Everything here is a soft delete server-side; what makes
 * it "danger" is that nothing on these screens can undo it.
 */

interface ProjectListItem {
  name: string;
  slug: string;
  environmentCount: number;
}

export function DangerScreen() {
  return (
    <div className="flex flex-col gap-6">
      <DeleteProjectCard />
      <DeleteAccountCard />
    </div>
  );
}

function DeleteProjectCard() {
  const { organizations } = useSession();
  const { toast } = useToast();

  // Deleting requires `project.delete`, which developers and viewers never
  // hold — offering their organisations here would only manufacture 404s.
  const adminOrgs = useMemo(
    () => organizations.filter((organization) => isOrgAdmin(organization.role)),
    [organizations],
  );

  const [orgSlug, setOrgSlug] = useState(adminOrgs[0]?.slug ?? '');
  const [projectSlug, setProjectSlug] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  const projects = useApiResource<{ projects: ProjectListItem[] }>(
    orgSlug === '' ? null : apiPath.projects(orgSlug),
  );

  async function deleteProject() {
    try {
      await api.delete(apiPath.project(orgSlug, projectSlug), { confirm: confirmText.trim() });
      toast({ variant: 'success', title: `Deleted ${projectSlug}` });
      setProjectSlug('');
      setConfirmText('');
      setProblem(null);
      projects.reload();
    } catch (cause) {
      setProblem(cause);
    }
  }

  if (adminOrgs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Delete a project</CardTitle>
          <CardDescription>
            Only an organisation owner or admin can delete projects, and you are neither in any of
            yours.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const readyToConfirm = projectSlug !== '' && confirmText.trim() === projectSlug;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Delete a project</CardTitle>
          <CardDescription>
            Hides the project and every environment and secret beneath it, immediately, for
            everyone. Applications reading those secrets fail at their next deploy — which is later,
            when this is hardest to connect to its cause.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {problem !== null ? (
            <Alert tone="danger" title="The project was not deleted">
              <p>{errorMessage(problem)}</p>
              {isApiError(problem) && problem.requestId ? (
                <p className="mt-1.5 text-xs">
                  Request id: <code className="font-mono select-all">{problem.requestId}</code>
                </p>
              ) : null}
            </Alert>
          ) : null}

          {adminOrgs.length > 1 ? (
            <Field label="Organisation">
              <Select
                value={orgSlug}
                onValueChange={(value) => {
                  setOrgSlug(value);
                  setProjectSlug('');
                  setConfirmText('');
                }}
              >
                <SelectTrigger aria-label="Organisation">
                  <SelectValue placeholder="Choose an organisation" />
                </SelectTrigger>
                <SelectContent>
                  {adminOrgs.map((organization) => (
                    <SelectItem key={organization.slug} value={organization.slug}>
                      {organization.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          <Field label="Project">
            <Select value={projectSlug} onValueChange={setProjectSlug}>
              <SelectTrigger aria-label="Project" disabled={projects.data === null}>
                <SelectValue
                  placeholder={projects.loading ? 'Loading projects…' : 'Choose a project'}
                />
              </SelectTrigger>
              <SelectContent>
                {(projects.data?.projects ?? []).map((project) => (
                  <SelectItem key={project.slug} value={project.slug}>
                    {project.name} ({project.slug})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {projectSlug !== '' ? (
            <Field
              label={`Type "${projectSlug}" to confirm`}
              hint="The slug, exactly — the step that cannot happen by accident."
            >
              <Input
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                className="font-mono"
                autoComplete="off"
              />
            </Field>
          ) : null}

          <div>
            <Button variant="danger" disabled={!readyToConfirm} onClick={() => setConfirming(true)}>
              Delete project…
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${projectSlug}?`}
        description="Every environment and secret in it disappears from every listing, every pull, and every CI pipeline immediately."
        confirmLabel="Delete project"
        onConfirm={deleteProject}
      />
    </>
  );
}

function DeleteAccountCard() {
  const { user, organizations } = useSession();

  const [confirmText, setConfirmText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  async function deleteAccount() {
    setDeleting(true);
    try {
      await api.delete(apiPath.account(), { confirm: confirmText.trim() });
      // The response cleared both cookies and every session is revoked. A full
      // document load, not a router push, for the same reason `lib/api.ts`
      // uses one on a 401: every RSC payload the router has cached was
      // rendered for an account that no longer exists, and nothing rendered
      // for it may survive the navigation.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- see above
      window.location.assign('/sign-in');
    } catch (cause) {
      setDeleting(false);
      setProblem(cause);
    }
  }

  const soleMemberships = organizations.length;

  return (
    <>
      <Card className="border-danger/40">
        <CardHeader>
          <CardTitle>Delete this account</CardTitle>
          <CardDescription>
            Organisations where you are the only member are deleted with you; the{' '}
            {soleMemberships === 1 ? 'organisation' : `${soleMemberships} organisations`} you belong
            to lose your membership. Every session and CLI token is revoked. This is final: the same
            sign-in can never reopen this account.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {problem !== null ? (
            <Alert tone="danger" title="The account was not deleted">
              <p>{errorMessage(problem)}</p>
              {isApiError(problem) && problem.code === 'conflict' ? (
                <p className="mt-1.5 text-xs">
                  Ownership moves on the Members screen of that organisation.
                </p>
              ) : null}
            </Alert>
          ) : null}

          <Alert tone="warning" title="If you are the only owner of a shared organisation">
            The deletion is refused until you hand ownership to someone else — removing the only
            owner would strand everyone still inside.
          </Alert>

          <Field
            label={`Type your email (${user.email}) to confirm`}
            hint="The address, exactly as shown."
          >
            <Input
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
              inputMode="email"
            />
          </Field>

          <div>
            <Button
              variant="danger"
              disabled={confirmText.trim().toLowerCase() !== user.email.toLowerCase()}
              onClick={() => setConfirming(true)}
            >
              Delete my account…
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this account forever?"
        description="Your solo organisations and their secrets become unreachable, your memberships end, and every device is signed out. There is no undo and no restore."
        confirmLabel={deleting ? 'Deleting…' : 'Delete my account'}
        onConfirm={deleteAccount}
      />
    </>
  );
}
