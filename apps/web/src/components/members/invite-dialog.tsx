'use client';

import { useEffect, useState } from 'react';

import { canAssignRole } from '@xecret/core/authz';
import type { OrgRole } from '@xecret/core/authz';
import { generateInviteFragment, zeroize } from '@xecret/core/crypto/client';
import type { Bytes, InviteFragment } from '@xecret/core/crypto/client';
import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  fetchEnvironmentKeys,
  invitePublicKey,
  grantsPath,
  openEnvironmentKeys,
  sealInviteGrant,
} from '@/components/envkeys';
import { useVaultKeys } from '@/components/vault';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  CopyButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from '@/components/ui';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES_DESCENDING } from './types';
import type { InviteResponse } from './types';

/** What the access tree needs to draw one project and its environments. */
interface ProjectAccessOption {
  name: string;
  slug: string;
  environments: { name: string; slug: string; isProduction: boolean }[];
}

export interface InviteDialogProps {
  orgSlug: string;
  /** The caller's role — bounds which roles the dialog offers at all. */
  viewerRole: OrgRole;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reloads whatever lists the new invitation should appear in. */
  onInvited: () => void;
}

/**
 * Invites a colleague, then shows the acceptance link exactly once.
 *
 * The two steps are one dialog on purpose. When mail is configured the link is
 * a belt-and-braces copy of what just landed in an inbox; when it is not —
 * self-hosted installs may run without a mail provider — the link is the only
 * delivery there is, and closing the dialog discards it forever. The dialog
 * says which of the two situations the inviter is in rather than letting them
 * guess.
 *
 * The role menu offers nothing above the caller's own role — the same
 * hierarchy the server enforces. Rendering `Owner` to an admin and letting the
 * request fail would be showing a control that is really an error message.
 *
 * ── Two artefacts, and why they must travel apart ──
 * Every environment ticked below is end-to-end encrypted, so the invitee needs
 * its key — and they have no account yet, so there is no public key to seal it
 * to. The flow instead mints a **one-off keypair from a 128-bit fragment** (spec
 * §10): the public half is uploaded with the invitation, the grants are sealed
 * to it, and the fragment itself never reaches the server in any request.
 *
 * That leaves the inviter holding two things at the end: the link, which the
 * email already carries, and the fragment, which nothing carries. Sending both
 * down one channel collapses the design into a single secret — an inbox
 * compromise would then be enough. So the final step shows them separately, says
 * plainly that they must go by different routes, and does not offer a button
 * that sends them together.
 */
export function InviteDialog({
  orgSlug,
  viewerRole,
  open,
  onOpenChange,
  onInvited,
}: InviteDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent>
        <InviteFlow
          orgSlug={orgSlug}
          viewerRole={viewerRole}
          onOpenChange={onOpenChange}
          onSubmittingChange={setSubmitting}
          onInvited={onInvited}
        />
      </DialogContent>
    </Dialog>
  );
}

function InviteFlow({
  orgSlug,
  viewerRole,
  onOpenChange,
  onSubmittingChange,
  onInvited,
}: {
  orgSlug: string;
  viewerRole: OrgRole;
  onOpenChange: (open: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
  onInvited: () => void;
}) {
  const { toast } = useToast();
  const vault = useVaultKeys();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('developer');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** Set after a successful invite; flips the dialog to the two-artefact step. */
  const [issued, setIssued] = useState<InviteResponse | null>(null);
  /**
   * The invite fragment, once one has been minted.
   *
   * Held only for as long as this dialog shows it. It is not in the invitation
   * response, not in any request body, and not in `localStorage` — the whole of
   * the two-channel design is that the server has never seen it.
   */
  const [fragment, setFragment] = useState<InviteFragment | null>(null);
  /**
   * Environments whose key could not be sealed to the invitation.
   *
   * Named rather than swallowed: the invitation still works and the person still
   * joins, but they will land with no key for these and will wait on a teammate.
   * Saying which ones is the difference between a known gap and a mystery.
   */
  const [unsealed, setUnsealed] = useState<readonly string[]>([]);

  /**
   * The access tree, and the selection — **empty by default, deliberately**.
   * An invitation grants exactly what is ticked here and nothing else: the
   * server writes an explicit `none` for every unticked project at
   * acceptance, so an unticked invitee can open the dashboard and see no
   * projects at all until somebody grants them one.
   */
  const [projects, setProjects] = useState<ProjectAccessOption[] | null>(null);
  const [projectsError, setProjectsError] = useState(false);
  const [wholeProjects, setWholeProjects] = useState<ReadonlySet<string>>(new Set());
  const [environments, setEnvironments] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const list = await api.get<{ projects: { name: string; slug: string }[] }>(
          apiPath.projects(orgSlug),
        );
        const options = await Promise.all(
          list.projects.map(async (project) => {
            const detail = await api.get<{
              environments: { name: string; slug: string; isProduction: boolean }[];
            }>(apiPath.environments(orgSlug, project.slug));
            return { ...project, environments: detail.environments };
          }),
        );
        if (!cancelled) setProjects(options);
      } catch {
        // The tree failing to load must not block inviting — but it must not
        // silently degrade to "invite with access to everything" either. The
        // submit path below refuses until the tree has loaded.
        if (!cancelled) setProjectsError(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  const envKey = (projectSlug: string, environmentSlug: string) =>
    `${projectSlug}/${environmentSlug}`;

  function toggleWholeProject(projectSlug: string, checked: boolean) {
    setWholeProjects((current) => {
      const next = new Set(current);
      if (checked) next.add(projectSlug);
      else next.delete(projectSlug);
      return next;
    });
  }

  function toggleEnvironment(projectSlug: string, environmentSlug: string, checked: boolean) {
    setEnvironments((current) => {
      const next = new Set(current);
      const key = envKey(projectSlug, environmentSlug);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  const selectionCount =
    wholeProjects.size +
    [...environments].filter((key) => !wholeProjects.has(key.slice(0, key.indexOf('/')))).length;

  const offeredRoles = ROLES_DESCENDING.filter((candidate) => canAssignRole(viewerRole, candidate));

  function setBusy(busy: boolean) {
    setSubmitting(busy);
    onSubmittingChange(busy);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const trimmed = email.trim();
    if (trimmed.length === 0 || !trimmed.includes('@')) {
      setFieldError('Enter the email address to invite.');
      return;
    }

    // The selection *is* the access. Submitting before the tree has loaded
    // would silently send an empty selection the inviter never confirmed.
    if (projects === null) {
      setFormError(
        projectsError
          ? 'The project list could not be loaded, so access cannot be selected. Reload and try again.'
          : 'The project list is still loading — one moment.',
      );
      return;
    }

    // Whole-project ticks, plus environment ticks not already covered by one.
    const grants = [
      ...[...wholeProjects].map((projectSlug) => ({
        projectSlug,
        environmentSlug: null as string | null,
      })),
      ...[...environments]
        .map((key) => {
          const separator = key.indexOf('/');
          return {
            projectSlug: key.slice(0, separator),
            environmentSlug: key.slice(separator + 1),
          };
        })
        .filter((entry) => !wholeProjects.has(entry.projectSlug)),
    ];

    setBusy(true);
    setFormError(null);

    // ── The invitation's own keypair ──
    // Minted before the request, because the public half travels *with* the
    // invitation and the grants sealed afterwards name the invitation's id. The
    // fragment is generated here and stays here: it is never a field of this
    // body, or of any other.
    const minted = generateInviteFragment();

    try {
      const response = await api.post<InviteResponse>(apiPath.members(orgSlug), {
        email: trimmed,
        role,
        grants,
        invitePublicKey: await invitePublicKey(minted.seed),
      });

      // Sealed one environment at a time, because a grant names its recipient
      // and never its resource — a batch on the invitation body would carry no
      // unambiguous statement of which environment each belonged to, and a key
      // filed under the wrong environment looks exactly like a working grant
      // until somebody tries to use it.
      const failures = await sealInviteGrants({
        orgSlug,
        vault,
        invitationId: response.invitation.id,
        fragmentSeed: minted.seed,
        targets: grantTargets(grants, projects),
      });

      onInvited();
      setFragment(minted);
      setUnsealed(failures);
      setIssued(response);
      toast({
        variant: 'success',
        title: `Invited ${trimmed}`,
        ...(response.emailSent ? { description: 'They have been emailed a link to join.' } : {}),
      });
    } catch (cause) {
      // The seed is wiped on the failure path only. On success it is held for as
      // long as the dialog is showing the fragment to a person — that display is
      // the entire delivery mechanism for the second channel.
      zeroize(minted.seed);
      if (isApiError(cause) && cause.code === 'conflict') {
        // Either the address already belongs to a member, or the seat limit is
        // full — the server's message says which, and both are addressed to
        // the address field's owner, not to the form at large.
        setFormError(cause.message);
      } else {
        setFormError('The invitation could not be created. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (issued !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Invitation sent — now send the second half</DialogTitle>
          <DialogDescription>
            {issued.emailSent
              ? `${issued.invitation.email} has been emailed the link. The code below did not go with it, and must not.`
              : `Email is not configured for this deployment, so both halves below are the only copies — deliver them yourself, over two different channels.`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex max-h-[60dvh] flex-col gap-4 overflow-y-auto">
          <section className="flex flex-col gap-2">
            <h3 className="text-fg text-sm font-medium">1. The link</h3>
            <div className="border-line bg-canvas-inset flex items-center gap-2 rounded-lg border px-3 py-2">
              <code className="text-fg min-w-0 flex-1 truncate text-sm">{issued.inviteUrl}</code>
              <CopyButton value={issued.inviteUrl} label="Copy invitation link" />
            </div>
            <p className="text-fg-subtle text-sm">
              {issued.emailSent
                ? 'Already emailed. Works once, expires in 7 days, and only signs in the invited address.'
                : 'Works once, expires in 7 days, and only signs in the invited address.'}
            </p>
          </section>

          {fragment !== null ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-fg text-sm font-medium">
                2. The key code — send this separately
              </h3>
              <div className="border-line bg-canvas-inset flex items-center gap-2 rounded-lg border px-3 py-2">
                <code className="text-fg min-w-0 flex-1 font-mono text-sm break-all select-all">
                  {fragment.displayForm}
                </code>
                <CopyButton value={fragment.displayForm} label="Copy the key code" />
              </div>

              <Alert tone="warning" title="Send this over a different channel from the link">
                <p>
                  Together they unlock the environments you ticked. Apart, each is useless: the link
                  proves who they are and decrypts nothing, and this code decrypts and proves
                  nothing. Sending both by email would collapse the two into one — a compromised
                  inbox would then be enough.
                </p>
                <p className="mt-2">
                  Message it, say it on a call, hand it over in person. Anything but the same place
                  the link went.
                </p>
              </Alert>

              <p className="text-fg-subtle text-sm">
                This code exists only in this browser and has never been sent to the server. Closing
                this dialog discards it for good — if it is lost, the invitation still works and a
                teammate shares the keys afterwards instead.
              </p>
            </section>
          ) : null}

          {unsealed.length > 0 ? (
            <Alert tone="warning" title="Some environments could not be pre-shared">
              <p>
                The invitation is valid and they will join normally, but they will hold no key for{' '}
                {unsealed.join(', ')} until somebody who does shares it. That is the ordinary
                pending-share flow, and their teammates will see the prompt.
              </p>
            </Alert>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            I have sent both
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>Invite a member</DialogTitle>
        <DialogDescription>
          They join with the role you choose and access to exactly the projects and environments you
          tick below — nothing else. Both can be changed per member afterwards.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <Field label="Email" error={fieldError}>
          <Input
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setFieldError(null);
            }}
            placeholder="colleague@example.com"
            autoComplete="off"
            autoFocus
          />
        </Field>

        <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
          <Select value={role} onValueChange={(next) => setRole(next as OrgRole)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {offeredRoles.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {ROLE_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-fg text-sm font-medium">Access</legend>
          <p className="text-fg-subtle text-sm">
            Nothing is selected by default, and the invitation grants exactly what you tick — every
            unticked project stays completely inaccessible to them, including projects created later
            inside a partially-granted one. Ticked items get the role&apos;s normal level; you can
            adjust per-item levels on their member page after they join.
          </p>

          {projectsError ? (
            <Alert tone="danger">The project list could not be loaded. Close and retry.</Alert>
          ) : projects === null ? (
            <div aria-busy="true" aria-label="Loading projects" className="flex flex-col gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : projects.length === 0 ? (
            <p className="text-fg-subtle text-sm">
              This organisation has no projects yet — the member will join with access to nothing,
              which is also what they get by default.
            </p>
          ) : (
            <div className="border-line max-h-64 overflow-y-auto rounded-lg border">
              {projects.map((project) => {
                const whole = wholeProjects.has(project.slug);
                return (
                  <div
                    key={project.slug}
                    className="border-line-subtle px-3 py-2 [&:not(:last-child)]:border-b"
                  >
                    <label className="flex cursor-pointer items-center gap-2.5">
                      <Checkbox
                        checked={whole}
                        onCheckedChange={(checked) =>
                          toggleWholeProject(project.slug, checked === true)
                        }
                        aria-label={`Entire project ${project.name}`}
                      />
                      <span className="text-fg text-sm font-medium">{project.name}</span>
                      <span className="text-fg-subtle text-sm">entire project</span>
                    </label>

                    <div className="mt-1.5 flex flex-col gap-1 pl-7">
                      {project.environments.map((environment) => {
                        const checked =
                          whole || environments.has(envKey(project.slug, environment.slug));
                        return (
                          <label
                            key={environment.slug}
                            className={
                              whole
                                ? 'flex items-center gap-2.5 opacity-60'
                                : 'flex cursor-pointer items-center gap-2.5'
                            }
                          >
                            <Checkbox
                              checked={checked}
                              disabled={whole}
                              onCheckedChange={(next) =>
                                toggleEnvironment(project.slug, environment.slug, next === true)
                              }
                              aria-label={`${project.name} ${environment.name}`}
                            />
                            <span className="text-fg-muted text-sm">{environment.name}</span>
                            {environment.isProduction ? (
                              <Badge tone="production">Production</Badge>
                            ) : null}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {projects !== null && projects.length > 0 && selectionCount === 0 ? (
            <Alert tone="warning">
              Nothing is ticked — they will join with <strong>no access to any project</strong>{' '}
              until someone grants them access on their member page.
            </Alert>
          ) : null}
        </fieldset>

        {formError ? <Alert tone="danger">{formError}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          Send invitation
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Which environments the ticked access actually covers.
 *
 * A whole-project tick means every environment in it; an environment tick means
 * that one. Expanded here rather than sent as-is because a grant is sealed per
 * environment — there is no such thing as a project-level key.
 */
function grantTargets(
  grants: readonly { projectSlug: string; environmentSlug: string | null }[],
  projects: readonly ProjectAccessOption[],
): { projectSlug: string; envSlug: string }[] {
  const targets: { projectSlug: string; envSlug: string }[] = [];

  for (const grant of grants) {
    const project = projects.find((entry) => entry.slug === grant.projectSlug);
    if (project === undefined) continue;

    if (grant.environmentSlug === null) {
      for (const environment of project.environments) {
        targets.push({ projectSlug: project.slug, envSlug: environment.slug });
      }
      continue;
    }

    targets.push({ projectSlug: project.slug, envSlug: grant.environmentSlug });
  }

  return targets;
}

/**
 * Seals this environment's key to the invitation, for each ticked environment.
 *
 * Returns the ones that could not be sealed rather than throwing. Every reason
 * for a failure here — the inviter holds no grant on that environment, its key
 * was rotated a moment ago, it is still `server`-mode — leaves the *invitation*
 * perfectly valid: the person joins, and lands owing a key share that the
 * pending queue already records for a teammate to fulfil. Abandoning the whole
 * invitation over one environment would be much worse than naming it.
 *
 * An inviter with a locked vault seals nothing, and that is reported the same
 * way: they can still invite, and every environment simply waits.
 */
async function sealInviteGrants(params: {
  orgSlug: string;
  vault: Parameters<typeof sealInviteGrant>[0]['vault'] | null;
  invitationId: string;
  fragmentSeed: Bytes;
  targets: readonly { projectSlug: string; envSlug: string }[];
}): Promise<string[]> {
  const failed: string[] = [];
  if (params.vault === null) return params.targets.map((target) => target.envSlug);

  for (const target of params.targets) {
    const ref = {
      orgSlug: params.orgSlug,
      projectSlug: target.projectSlug,
      envSlug: target.envSlug,
    };

    try {
      const keys = await fetchEnvironmentKeys(ref);
      // A `server`-mode environment has no client key and needs no grant. Not a
      // failure, and not reported as one.
      if (keys.encryptionMode !== 'e2ee') continue;

      const opened = await openEnvironmentKeys(keys, params.vault);
      if (opened.status !== 'open' || keys.activeEdk === null) {
        failed.push(`${target.projectSlug}/${target.envSlug}`);
        continue;
      }

      const grant = await sealInviteGrant({
        vault: params.vault,
        fragmentSeed: params.fragmentSeed,
        invitationId: params.invitationId,
        environmentId: keys.environmentId,
        edkVersion: keys.activeEdk.version,
        edk: opened.material.edk,
        ehk: opened.material.ehk,
      });

      await api.post(grantsPath(ref), {
        envDataKeyId: keys.activeEdk.id,
        grants: [grant],
      });
    } catch {
      // Nothing from the thrown value is kept — see `lib/api.ts` on bodies.
      failed.push(`${target.projectSlug}/${target.envSlug}`);
    }
  }

  return failed;
}
