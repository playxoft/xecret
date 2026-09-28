'use client';

import { useId, useState } from 'react';

import { actionsForBase, CUSTOM_ROLE_FLOOR, ROLE_ACCESS_DEFAULTS } from '@xecret/core/authz';
import type { AccessLevel, Action, OrgRole } from '@xecret/core/authz';
import {
  CUSTOM_ROLE_NAME_MAX_LENGTH,
  customRoleNameProblem,
  normalizeCustomRoleName,
} from '@xecret/core/validation';
import { api, errorMessage, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import {
  Alert,
  Button,
  Checkbox,
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
  useToast,
} from '@/components/ui';
import { ACCESS_LEVEL_LABELS, ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/components/members/types';
import type { CustomRole } from '@/components/members/types';
import { ACTION_GROUPS, ACTION_LABELS } from './labels';

const LEVELS: readonly AccessLevel[] = ['none', 'read', 'write', 'admin'];

export interface RoleDialogProps {
  orgSlug: string;
  /** The role being edited, or `null` to define a new one. */
  role: CustomRole | null;
  /**
   * The bases the viewer may define a role on, from their session authority
   * (`canDefineCustomRole`). The base menu offers these and nothing else.
   */
  definableBaseRoles: readonly OrgRole[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/**
 * Defines a custom role, or edits one.
 *
 * ── What the form says, and why in this order ──
 * A name, the built-in role it narrows, what holders may do, and — optionally
 * — a cap on how far their access reaches. The base comes before the actions
 * because it bounds them: only the base's own actions are listed, since a
 * custom role can only take away, and ticking something the base cannot do
 * would grant nothing. A new role starts with every one of the base's actions
 * ticked — the whole of the base — so defining one reads as deciding what to
 * take away, which is what it is.
 *
 * "See who is in the organisation" is always ticked and cannot be unticked:
 * every member holds it, and the rest of the product uses it to ask whether
 * somebody is a member at all (`CUSTOM_ROLE_FLOOR`).
 *
 * The server measures every save against the viewer's authority and — for an
 * edit — against everybody holding the role; a refusal is shown in its own
 * words above the buttons.
 */
export function RoleDialog(props: RoleDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {/* One component down, so the form is seeded afresh from the role on
            every open — Radix unmounts a closed dialog's content. */}
        <RoleForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The form inside `RoleDialog`. Exported so a render test can draw it inside a
 * bare `Dialog` — the dialog's content is portalled, and a server render has no
 * portal to draw into.
 *
 * The base menu is `definableBaseRoles` exactly. Whoever sees Edit may define
 * on every base below owner — an owner or an admin who holds no custom role —
 * so an existing role's base is always among them.
 */
export function RoleForm({
  orgSlug,
  role,
  definableBaseRoles: bases,
  onOpenChange,
  onSaved,
}: Omit<RoleDialogProps, 'open'>) {
  const { toast } = useToast();
  const formId = useId();

  const [name, setName] = useState(role?.name ?? '');
  const [baseRole, setBaseRole] = useState<OrgRole>(
    role?.baseRole ?? (bases.includes('developer') ? 'developer' : (bases[0] ?? 'viewer')),
  );
  const [actions, setActions] = useState<ReadonlySet<Action>>(
    new Set(role?.allowedActions ?? actionsForBase(role?.baseRole ?? baseRole)),
  );
  const [capped, setCapped] = useState(role?.accessCeiling != null);
  const [ceiling, setCeiling] = useState<{ nonProduction: AccessLevel; production: AccessLevel }>(
    role?.accessCeiling ?? ROLE_ACCESS_DEFAULTS[role?.baseRole ?? baseRole],
  );
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const available = new Set(actionsForBase(baseRole));

  function changeBase(next: OrgRole) {
    const previous = new Set(actionsForBase(baseRole));
    const possible = actionsForBase(next);
    setBaseRole(next);
    setActions((current) => {
      // Keep what is still possible on the new base and drop the rest: an
      // action the base cannot perform would grant nothing, and the server
      // refuses a list that names one.
      const kept = new Set([...current].filter((action) => possible.includes(action)));
      // A new role starts as the whole of its base, so raising the base on
      // one ticks what the higher base adds. An existing role's list is a
      // decision somebody made, and is not widened behind their back.
      if (role === null) {
        for (const action of possible) if (!previous.has(action)) kept.add(action);
      }
      return kept;
    });
    if (!capped) setCeiling(ROLE_ACCESS_DEFAULTS[next]);
  }

  function toggle(action: Action, on: boolean) {
    setActions((current) => {
      const next = new Set(current);
      if (on) next.add(action);
      else next.delete(action);
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    // The rules the server holds a name to, said before the request is made.
    const normalised = normalizeCustomRoleName(name);
    const problem = customRoleNameProblem(normalised);
    if (problem !== null) {
      setNameError(problem);
      return;
    }

    const body = {
      name: normalised,
      baseRole,
      // The floor is kept by the engine whatever the list says; sending it
      // makes the stored list say so too.
      allowedActions: [
        ...new Set([...CUSTOM_ROLE_FLOOR, ...[...actions].filter((a) => available.has(a))]),
      ],
      accessCeiling: capped ? ceiling : null,
    };

    setSubmitting(true);
    setError(null);
    setNameError(null);
    try {
      if (role === null) await api.post(apiPath.roles(orgSlug), body);
      else await api.patch(apiPath.role(orgSlug, role.id), body);
      toast({
        variant: 'success',
        title: role === null ? `Created ${normalised}` : `Saved ${normalised}`,
      });
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      // A problem with the name — taken, or refused by the rules — belongs to
      // the name field, which the server says by naming it; everything else —
      // a refusal, the plan — is about the form as a whole.
      const onName = isApiError(cause)
        ? cause.fields.find((problem) => problem.field === 'name')
        : undefined;
      if (onName !== undefined) setNameError(onName.message);
      else setError(cause);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form id={formId} onSubmit={handleSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>{role === null ? 'New role' : `Edit ${role.name}`}</DialogTitle>
        <DialogDescription>
          A custom role narrows a built-in role: holders keep what you tick below and lose the rest.
          It can never give anybody more than the built-in role it is based on.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex max-h-[65dvh] flex-col gap-5 overflow-y-auto">
        <Field
          label="Name"
          error={nameError}
          hint={`Shown beside the member's built-in role. ${name.length} of ${CUSTOM_ROLE_NAME_MAX_LENGTH} characters.`}
        >
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
            maxLength={CUSTOM_ROLE_NAME_MAX_LENGTH}
            placeholder="Deployer"
            autoComplete="off"
            disabled={submitting}
            autoFocus
          />
        </Field>

        <Field label="Based on" hint={ROLE_DESCRIPTIONS[baseRole]}>
          <Select
            value={baseRole}
            onValueChange={(next) => changeBase(next as OrgRole)}
            disabled={submitting}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {bases.map((base) => (
                <SelectItem key={base} value={base}>
                  {ROLE_LABELS[base]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-fg mb-1 text-sm font-medium">What holders may do</legend>
          {ACTION_GROUPS.map((group) => {
            const offered = group.actions.filter((action) => available.has(action));
            if (offered.length === 0) return null;
            return (
              <fieldset key={group.label} className="border-line rounded-lg border">
                <legend className="text-fg-muted px-1.5 text-sm font-medium">{group.label}</legend>
                {offered.map((action) => {
                  const floor = CUSTOM_ROLE_FLOOR.includes(action);
                  return (
                    <label
                      key={action}
                      className="border-line-subtle flex cursor-pointer items-center gap-2.5 px-3 py-1.5 [&:not(:first-of-type)]:border-t"
                    >
                      <Checkbox
                        checked={floor || actions.has(action)}
                        disabled={floor || submitting}
                        onCheckedChange={(checked) => toggle(action, checked === true)}
                      />
                      <span className="text-sm">
                        {ACTION_LABELS[action]}
                        {floor ? <span className="text-fg-subtle"> — always included</span> : null}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            );
          })}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-fg mb-1 text-sm font-medium">Access ceiling</legend>
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={capped}
              disabled={submitting}
              onCheckedChange={(checked) => setCapped(checked === true)}
              className="mt-0.5"
            />
            <span className="text-sm">
              Cap how far holders reach, whatever they are granted
              <span className="text-fg-subtle block">
                Every level a holder resolves to — explicit grants included — is held at or below
                this. It never raises anything. Use it for &ldquo;can never touch production&rdquo;.
              </span>
            </span>
          </label>
          {capped ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Other environments">
                <Select
                  value={ceiling.nonProduction}
                  onValueChange={(next) =>
                    setCeiling((current) => ({ ...current, nonProduction: next as AccessLevel }))
                  }
                  disabled={submitting}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {ACCESS_LEVEL_LABELS[level]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Production environments">
                <Select
                  value={ceiling.production}
                  onValueChange={(next) =>
                    setCeiling((current) => ({ ...current, production: next as AccessLevel }))
                  }
                  disabled={submitting}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {ACCESS_LEVEL_LABELS[level]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          ) : null}
        </fieldset>

        {role !== null && (role.holderCount ?? 0) > 0 ? (
          <Alert tone="info">
            {role.holderCount === 1 ? 'One member holds' : `${role.holderCount} members hold`} this
            role, and a change applies to them at once. Widening it — more actions, a higher ceiling
            — is refused if any of them holds access grants beyond your own.
          </Alert>
        ) : null}

        {error !== null ? (
          <Alert tone="danger" title="That role was not saved">
            {errorMessage(error)}
          </Alert>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {role === null ? 'Create role' : 'Save changes'}
        </Button>
      </DialogFooter>
    </form>
  );
}
