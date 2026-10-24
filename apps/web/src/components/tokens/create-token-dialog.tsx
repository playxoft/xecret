'use client';

import { useState } from 'react';

import { MAX_TOKEN_LIFETIME_DAYS } from '@xecret/core/policy';
import type { TokenPolicy } from '@xecret/core/policy';
import { errorMessage, isApiError } from '@/lib/api';
import { pluralize } from '@/lib/format';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
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
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui';
import { LevelToggle, SERVICE_TOKEN_LEVELS } from '@/components/members/level-toggle';
import {
  fieldProblemsUnder,
  parseTokenScope,
  tokenScopeDraftFor,
} from '@/components/policies/policy-form';
import type { TokenScopeDraft } from '@/components/policies/policy-form';
import type { ProjectListResponse, ProjectResponse } from '@/components/projects/types';
import { useVaultKeys } from '@/components/vault';
import { mintServiceToken, TokenKeyUnavailableError } from './token-keys';
import type { MintedServiceToken } from './token-keys';

export interface CreateTokenDialogProps {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  /**
   * The organisation's token policy, as the token listing reported it — or
   * `null` while that listing has not loaded.
   *
   * Read for the form's starting point and its checks: an allowlist the policy
   * requires is a required field, and a lifetime cap is pre-filled and enforced.
   * `null` asks nothing locally, and the server's refusal still arrives, under
   * the field it is about, if the policy turns out to require something.
   */
  tokenPolicy: TokenPolicy | null;
}

/** The two fields the token policy governs, keyed as the server's 422 names them. */
type ScopeField = 'ipAllowlist' | 'expiresAt';

/**
 * Mints service tokens, then shows them exactly once.
 *
 * The scope pickers are the security control wearing a form: every token is
 * pinned to one project and **one** environment at mint time, and nothing
 * later can widen it. Selecting several environments therefore mints several
 * tokens — one per environment, each individually revocable — rather than one
 * broad credential, which is the difference between rotating a leaked staging
 * token and rotating away production's too. Read-only is the default and the
 * widening to `write` is a choice made here, visibly, not a field somebody
 * forgets.
 *
 * The reveal step is deliberately terminal — closing it discards the values
 * forever, and the dialog says so before it happens, not after. Under
 * end-to-end encryption that terminality acquired teeth: the token string now
 * carries the credential *and* the X25519 key that opens the environment (spec
 * §13.1), so a value lost here is lost cryptographically, not merely
 * administratively. `token-keys.ts` decides which half goes where; this file
 * remains a form.
 */
export function CreateTokenDialog({
  orgSlug,
  open,
  onOpenChange,
  onCreated,
  tokenPolicy,
}: CreateTokenDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent>
        <CreateTokenFlow
          orgSlug={orgSlug}
          onOpenChange={onOpenChange}
          onSubmittingChange={setSubmitting}
          onCreated={onCreated}
          tokenPolicy={tokenPolicy}
        />
      </DialogContent>
    </Dialog>
  );
}

interface MintOutcome {
  minted: MintedServiceToken[];
  /** Environment slugs whose mint failed, in selection order. */
  failed: string[];
}

function CreateTokenFlow({
  orgSlug,
  onOpenChange,
  onSubmittingChange,
  onCreated,
  tokenPolicy,
}: {
  orgSlug: string;
  onOpenChange: (open: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
  onCreated: () => void;
  tokenPolicy: TokenPolicy | null;
}) {
  const projects = useApiResource<ProjectListResponse>(apiPath.projects(orgSlug));
  const vault = useVaultKeys();

  const [name, setName] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [environmentSlugs, setEnvironmentSlugs] = useState<ReadonlySet<string>>(new Set());
  const [accessLevel, setAccessLevel] = useState<'read' | 'write'>('read');
  // Seeded once, from the policy as it stood when the dialog opened: the cap is
  // pre-filled and the allowlist marked required. Radix unmounts a closed
  // dialog's content, so the next opening reads the policy afresh.
  const [scope, setScope] = useState<TokenScopeDraft>(() => tokenScopeDraftFor(tokenPolicy));
  const [scopeErrors, setScopeErrors] = useState<Partial<Record<ScopeField, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MintOutcome | null>(null);

  const requiresAllowlist = tokenPolicy?.requireIpAllowlist === true;
  const lifetimeCap = tokenPolicy?.maxLifetimeDays ?? null;

  function patchScope(change: Partial<TokenScopeDraft>) {
    setScope((current) => ({ ...current, ...change }));
    setScopeErrors({});
  }

  // The environment list follows the chosen project.
  const project = useApiResource<ProjectResponse>(
    projectSlug === '' ? null : apiPath.project(orgSlug, projectSlug),
  );

  function setBusy(busy: boolean) {
    setSubmitting(busy);
    onSubmittingChange(busy);
  }

  function toggleEnvironment(slug: string, checked: boolean) {
    setEnvironmentSlugs((current) => {
      const next = new Set(current);
      if (checked) next.add(slug);
      else next.delete(slug);
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    if (name.trim() === '' || projectSlug === '' || environmentSlugs.size === 0) {
      setFormError('Name the token and choose a project and at least one environment.');
      return;
    }

    // ── The token policy, asked before anything exists ──
    // The same `checkServiceTokenAgainstPolicy` the server refuses with, so the
    // sentences match — but here they arrive under their fields before a token
    // is minted. A token cannot be un-minted, and a batch of five refused one by
    // one after the first had already been issued is the worst way to learn the
    // allowlist was required.
    const parsedScope = parseTokenScope(scope, tokenPolicy, new Date());
    if (!parsedScope.ok) {
      setScopeErrors(parsedScope.errors);
      setFormError(null);
      return;
    }

    setBusy(true);
    setFormError(null);
    setScopeErrors({});

    // One token per environment, sequentially — each mint is a separate
    // audited act against the mutation rate limit. A mid-batch failure still
    // reveals what was minted: those tokens exist and will never be shown
    // again, so hiding them behind the error would destroy them.
    const minted: MintedServiceToken[] = [];
    const failed: string[] = [];
    // The cause itself rather than its sentence, so a 422 naming `ipAllowlist`
    // or `expiresAt` can be put back under the field it is about.
    let firstFailure: unknown = null;
    for (const environmentSlug of environmentSlugs) {
      try {
        minted.push(
          await mintServiceToken({
            orgSlug,
            projectSlug,
            environmentSlug,
            name: name.trim(),
            accessLevel,
            ipAllowlist: parsedScope.scope.ipAllowlist,
            ...(parsedScope.scope.expiresAt === null
              ? {}
              : { expiresAt: parsedScope.scope.expiresAt }),
            // No `encryptionMode`. This screen's project listing is a cache, and
            // a cache that answered `server` for an `e2ee` environment used to
            // mint a keyless token and report it as a success. `mintServiceToken`
            // reads the environment's own key state instead — one request, at the
            // only moment the answer matters.
            vault,
          }),
        );
      } catch (cause) {
        failed.push(environmentSlug);
        // The first failure's story; later ones are usually the same.
        firstFailure ??= cause;
      }
    }

    setBusy(false);

    if (minted.length === 0) {
      // A policy refusal the local check could not see — the policy changed
      // while the dialog was open, or the listing had not loaded — goes under
      // its field. Anything else is the form's.
      const fields = isApiError(firstFailure) ? fieldProblemsUnder(firstFailure.fields, '') : {};
      const scoped: Partial<Record<ScopeField, string>> = {
        ...(fields['ipAllowlist'] === undefined ? {} : { ipAllowlist: fields['ipAllowlist'] }),
        ...(fields['expiresAt'] === undefined ? {} : { expiresAt: fields['expiresAt'] }),
      };
      if (Object.keys(scoped).length > 0) {
        setScopeErrors(scoped);
        return;
      }
      setFormError(
        firstFailure === null
          ? 'No tokens could be created.'
          : // A refusal raised here, before anything was minted, is a fixed
            // sentence of this module's own — safe to show, and the only one
            // that says *why* (a locked vault, a key nobody shared).
            firstFailure instanceof TokenKeyUnavailableError
            ? firstFailure.message
            : errorMessage(firstFailure),
      );
      return;
    }

    onCreated();
    setOutcome({ minted, failed });
  }

  if (outcome !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {outcome.minted.length === 1 ? 'Copy the token now' : 'Copy the tokens now'}
          </DialogTitle>
          <DialogDescription>
            This is the only time they will be shown. Only a hash is stored, and for an end-to-end
            encrypted environment the string also carries the key that decrypts it — which exists
            nowhere else. Closing this dialog discards the values forever; losing one means minting
            a new token.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          {outcome.failed.length > 0 ? (
            <Alert tone="danger" title="Some environments failed">
              No token was created for: {outcome.failed.join(', ')}. The ones below were.
            </Alert>
          ) : null}

          {outcome.minted.some((issued) => !issued.keyShared) ? (
            <Alert tone="danger" title="One token has no key yet">
              It authenticates but decrypts nothing until somebody shares this environment&apos;s
              key with it. Copy it anyway — this is still the only time it is shown — then open the
              environment&apos;s key panel and share or rotate.
            </Alert>
          ) : null}

          {outcome.minted.map((issued) => (
            <div key={issued.serviceToken.id} className="flex flex-col gap-1">
              <p className="text-fg-muted text-sm font-medium">
                {issued.serviceToken.projectSlug}/{issued.serviceToken.environmentSlug}
                {issued.keyShared ? null : (
                  <span className="text-fg-subtle"> &mdash; no key shared</span>
                )}
              </p>
              <div className="border-line bg-canvas-inset flex items-center gap-2 rounded-lg border px-3 py-2">
                <code className="text-fg min-w-0 flex-1 truncate font-mono text-sm">
                  {issued.token}
                </code>
                <CopyButton
                  value={issued.token}
                  label={`Copy the token for ${issued.serviceToken.environmentSlug}`}
                />
              </div>
            </div>
          ))}

          <p className="text-fg-subtle text-sm">
            Put each one in its pipeline&apos;s secret store as{' '}
            <code className="font-mono">XECRET_TOKEN</code>. Each token reaches its one environment
            and nothing else, and each is revoked on its own.
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>New service token</DialogTitle>
        <DialogDescription>
          A CI credential, pinned to exactly one project and environment. Selecting several
          environments mints one token per environment. It acts as itself — never as a person — and
          every read it makes is audited.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <Field label="Name" hint="Where it lives, e.g. github-actions-deploy.">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="github-actions-deploy"
            maxLength={100}
            autoComplete="off"
            autoFocus
          />
        </Field>

        <Field label="Project">
          <Select
            value={projectSlug}
            onValueChange={(next) => {
              setProjectSlug(next);
              setEnvironmentSlugs(new Set());
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose a project" />
            </SelectTrigger>
            <SelectContent>
              {(projects.data?.projects ?? []).map((entry) => (
                <SelectItem key={entry.slug} value={entry.slug}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Environments"
          hint="One token per ticked environment, each pinned to that environment alone."
        >
          {projectSlug === '' ? (
            <p className="text-fg-subtle text-sm">Choose a project first.</p>
          ) : (
            <div className="border-line flex flex-col gap-0 rounded-lg border">
              {(project.data?.environments ?? []).map((environment) => (
                <label
                  key={environment.slug}
                  className="border-line-subtle flex cursor-pointer items-center gap-2.5 px-3 py-2 [&:not(:first-child)]:border-t"
                >
                  <Checkbox
                    checked={environmentSlugs.has(environment.slug)}
                    onCheckedChange={(checked) =>
                      toggleEnvironment(environment.slug, checked === true)
                    }
                    aria-label={`Mint a token for ${environment.name}`}
                  />
                  <span className="flex items-center gap-2 text-sm">
                    {environment.name}
                    {environment.isProduction ? <Badge tone="production">Production</Badge> : null}
                  </span>
                </label>
              ))}
            </div>
          )}
        </Field>

        <Field
          label="Access"
          hint={
            accessLevel === 'read'
              ? 'Reads secrets. The right level for builds and deploys.'
              : 'Also writes secrets — for pipelines that rotate credentials. Cannot delete.'
          }
        >
          {/* The same capsule the member screens grant with, so one vocabulary
              covers every level in the product. Two segments, not three:
              `admin` is not a level a service token can hold — the engine's
              service-token allowlist tops out at `write` — and `clearable`
              is off, because a token with no level is not a credential and a
              gesture whose result this screen would drop is a control that
              looks broken. */}
          <div>
            <LevelToggle
              level={accessLevel}
              disabled={submitting}
              scopeLabel="this token"
              levels={SERVICE_TOKEN_LEVELS}
              clearable={false}
              onSelect={(next) => {
                if (next === 'read' || next === 'write') setAccessLevel(next);
              }}
            />
          </div>
        </Field>

        {/* The two fields the organisation's token policy governs (P19 §6).
            Available on every plan, as they always were on the API: what the
            plan buys is the organisation-wide *requirement*, which the hints
            below state where it applies. */}
        <Field
          label="IP allowlist"
          optional={!requiresAllowlist}
          error={scopeErrors.ipAllowlist ?? null}
          hint={
            requiresAllowlist
              ? 'Required by this organisation’s token policy: every service token names the addresses it may be used from. Addresses or CIDR ranges, separated by commas or new lines.'
              : 'Addresses or CIDR ranges, separated by commas or new lines. A request from anywhere else is refused. Leave it empty to allow any address.'
          }
        >
          <Textarea
            value={scope.ipAllowlist}
            onChange={(event) => patchScope({ ipAllowlist: event.target.value })}
            rows={2}
            placeholder="203.0.113.4, 198.51.100.0/24"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono"
            disabled={submitting}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            {/* Outside the `Field` below, which gives its id to the first
                control inside it — two controls in one field would share an
                id and a label. */}
            <Checkbox
              id="token-expires"
              checked={scope.expires}
              // A cap means the token must expire; offering to switch that off
              // would offer a token the server is about to refuse.
              disabled={submitting || lifetimeCap !== null}
              onCheckedChange={(checked) => patchScope({ expires: checked === true })}
            />
            <Label htmlFor="token-expires">This token expires</Label>
          </div>
          {scope.expires ? (
            <Field
              label="Expires after, in days"
              error={scopeErrors.expiresAt ?? null}
              hint={
                lifetimeCap !== null
                  ? `This organisation’s token policy caps a service token’s life at ${pluralize(lifetimeCap, 'day')}.`
                  : 'Counted from now. The pipeline using it stops working on that day, so put the date somewhere a person will see it.'
              }
              className="max-w-64"
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={lifetimeCap ?? MAX_TOKEN_LIFETIME_DAYS}
                value={scope.expiresInDays}
                onChange={(event) => patchScope({ expiresInDays: event.target.value })}
                disabled={submitting}
              />
            </Field>
          ) : scopeErrors.expiresAt !== undefined ? (
            <p className="text-danger-text text-sm leading-5">{scopeErrors.expiresAt}</p>
          ) : (
            <p className="text-fg-subtle text-sm leading-5">It works until somebody revokes it.</p>
          )}
        </div>

        {formError ? <Alert tone="danger">{formError}</Alert> : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {environmentSlugs.size > 1 ? `Create ${environmentSlugs.size} tokens` : 'Create token'}
        </Button>
      </DialogFooter>
    </form>
  );
}
