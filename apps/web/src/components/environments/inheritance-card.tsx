'use client';

import { useState } from 'react';

import { cheapestPlanWithFeature } from '@xecret/core/entitlements';
import { api } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
import { useApiResource } from '@/app/(dashboard)/_lib/use-api-resource';
import { planName } from '@/components/plans/plan-copy';
import { ChangeError } from '@/components/plans/plan-notice';
import type {
  EnvironmentChangeResponse,
  EnvironmentDetail,
  ProjectResponse,
} from '@/components/projects/types';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from '@/components/ui';
import { childrenOf, environmentName, inheritanceChain, parentOptions } from './inheritance';
import { protectionCrossingWarning } from './protection-crossing';

/**
 * What this environment inherits from (P19 §1, `secretReferencing`).
 *
 * ── What inheriting means, said where it is chosen ──
 * An environment with a parent receives every value the parent holds, for each
 * key it does not hold itself — its own values always win. Resolution happens
 * where the values are read: `xecret run` and `xecret pull` walk the chain on
 * the reader's own machine, opening each environment's key as they go. Nothing
 * is copied, and nothing on the server learns a value. The secret table on the
 * environment's own page lists only what it holds itself, which is why this
 * card says so: a person looking there for an inherited `DATABASE_URL` and not
 * finding it should already know where it comes from.
 *
 * ── Who may, and what the plan says ──
 * `environment.update` on this environment — the administrative act that also
 * reclassifies it as production, because it changes what every reader receives
 * — and the server additionally asks that the person can read the parent.
 * Setting a parent needs the `secretReferencing` feature; *clearing* one never
 * does, and an organisation that downgraded keeps every parent it set. The
 * dashboard cannot know the organisation's entitlements in advance — support
 * can raise them — so the selector is offered and a plan refusal comes back
 * through `ChangeError`, naming the plan that would allow it.
 *
 * ── What the menu leaves out, and what it only disables ──
 * Itself, always. Everything else is drawn, and the ones that cannot be chosen
 * — not end-to-end encrypted, already inheriting from this one, or too deep —
 * are disabled with the reason beside them: see `inheritance.ts`. The server's
 * own refusal still reaches the person in its own words, because the listing
 * this works from can be a moment out of date.
 */
export function InheritanceCard({
  orgSlug,
  projectSlug,
  environment,
  canManage,
  onChanged,
}: {
  orgSlug: string;
  projectSlug: string;
  environment: EnvironmentDetail;
  /** Whether the viewer holds `environment.update`. The server still decides. */
  canManage: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  // The project listing, for the siblings: each one's name, mode and parent.
  // The environment's own detail carries its parent's slug and nothing else.
  const project = useApiResource<ProjectResponse>(apiPath.project(orgSlug, projectSlug));

  const [choice, setChoice] = useState<string>('');
  const [confirming, setConfirming] = useState<'set' | 'clear' | null>(null);
  const [error, setError] = useState<unknown>(null);
  /**
   * A production environment about to inherit from one that is not: the
   * server's warning, naming who could then change production's values, and
   * the parent the person chose. See `protection-crossing.ts`.
   */
  const [crossing, setCrossing] = useState<{ next: string; warning: string } | null>(null);

  const environments = project.data?.environments ?? [];
  const parent = environment.parent ?? null;
  const e2ee = environment.encryptionMode === 'e2ee';
  const chain = inheritanceChain(
    // The detail is fresher than the listing for this one environment — it is
    // what `onChanged` re-reads — so its own parent is taken from there.
    environments.map((entry) => (entry.slug === environment.slug ? { ...entry, parent } : entry)),
    environment.slug,
  );
  const children = childrenOf(environments, environment.slug);
  const options = parentOptions(environments, environment.slug);
  const chosen = options.find((option) => option.slug === choice) ?? null;
  const plan = cheapestPlanWithFeature('secretReferencing');

  async function change(next: string | null, confirmCrossesProtection = false) {
    setError(null);
    try {
      await api.put<EnvironmentChangeResponse>(
        apiPath.environmentParent(orgSlug, projectSlug, environment.slug),
        { parent: next, ...(confirmCrossesProtection ? { confirmCrossesProtection: true } : {}) },
      );
      toast({
        variant: 'success',
        title:
          next === null
            ? `${environment.name} no longer inherits`
            : `${environment.name} now inherits from ${environmentName(environments, next)}`,
        description:
          next === null
            ? 'From its next read, it receives only the values it holds itself.'
            : 'From its next read, every key it does not hold itself comes from there.',
      });
      setChoice('');
      setCrossing(null);
      onChanged();
      void project.reload();
    } catch (cause) {
      // Production inheriting from an environment that is not: asked again, in
      // the server's words, before anything is changed.
      const warning = protectionCrossingWarning(cause);
      if (warning !== null && next !== null && !confirmCrossesProtection) {
        setCrossing({ next, warning });
        return;
      }
      // Kept on the card rather than thrown back into the dialog: a plan
      // refusal is rendered with its upgrade target by `ChangeError`, which the
      // confirmation's own one-line error slot cannot do.
      setError(cause);
    }
  }

  const confirmTitle =
    confirming === 'clear'
      ? `Stop ${environment.name} inheriting?`
      : `Make ${environment.name} inherit from ${chosen?.name ?? 'this environment'}?`;
  const confirmDescription =
    confirming === 'clear'
      ? `Every key ${environment.name} does not hold itself stops resolving to ${environmentName(environments, parent ?? '')}’s value. Anything reading such a key — xecret run, CI — finds it missing from its next read.`
      : `Every key ${environment.name} does not hold itself resolves to ${chosen?.name ?? 'its'} value from the next read — in xecret run, in CI, everywhere this environment is pulled. Its own values are unaffected and still win.`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inheritance</CardTitle>
        <CardDescription>
          Inherit every value from another environment of this project, and set here only what
          differs. This environment’s own values always win over inherited ones.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {error !== null ? <ChangeError error={error} /> : null}

        {!e2ee ? (
          <Alert tone="info" title="Inheritance needs end-to-end encryption">
            This environment uses server-side encryption, which predates inheritance. Only an
            end-to-end encrypted environment can inherit, or be inherited from, because the values
            are resolved on the reader’s own machine with each environment’s key.
          </Alert>
        ) : project.error !== null ? (
          <Alert tone="danger" title="The other environments could not be loaded">
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => void project.reload()}
            >
              Try again
            </Button>
          </Alert>
        ) : project.data === null ? (
          <div aria-busy="true" aria-label="Loading inheritance" className="flex flex-col gap-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 text-sm leading-6">
              {parent === null ? (
                <p className="text-fg-muted">
                  Inherits from nothing — every value it holds is its own.
                </p>
              ) : (
                <p className="text-fg-muted">
                  Inherits from{' '}
                  <span className="text-fg font-medium">
                    {environmentName(environments, parent)}
                  </span>
                  {chain.length > 1 ? (
                    <>
                      , which inherits from{' '}
                      {chain.slice(1).map((slug, index) => (
                        <span key={slug}>
                          {index > 0 ? ', then ' : null}
                          <span className="text-fg font-medium">
                            {environmentName(environments, slug)}
                          </span>
                        </span>
                      ))}
                    </>
                  ) : null}
                  . The nearest environment that holds a key wins.
                </p>
              )}
              {children.length > 0 ? (
                <p className="text-fg-muted">
                  Inherited by{' '}
                  <span className="text-fg font-medium">
                    {children.map((child) => child.name).join(', ')}
                  </span>
                  , so a change to a value here reaches {children.length === 1 ? 'it' : 'them'} too,
                  for every key {children.length === 1 ? 'it does' : 'they do'} not hold.
                </p>
              ) : null}
              <p className="text-fg-subtle">
                <code className="font-mono">xecret run</code> and{' '}
                <code className="font-mono">xecret pull</code> resolve the chain on your machine.
                This environment’s page lists only the values it holds itself.
              </p>
            </div>

            {canManage ? (
              <div className="flex flex-col gap-3">
                <Field
                  label={parent === null ? 'Inherit from' : 'Change the parent'}
                  hint={
                    plan === null
                      ? 'Clearing a parent never needs a plan.'
                      : `Setting a parent is part of the ${planName(plan)} plan and above; clearing one never needs a plan.`
                  }
                >
                  <Select value={choice} onValueChange={setChoice}>
                    <SelectTrigger aria-label={`Parent environment for ${environment.name}`}>
                      <SelectValue placeholder="Choose an environment" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((option) => (
                        <SelectItem
                          key={option.slug}
                          value={option.slug}
                          disabled={option.unavailable !== null || option.slug === parent}
                        >
                          {option.name}
                          {option.isProduction ? ' · production' : ''}
                          {option.slug === parent
                            ? ' — the current parent'
                            : option.unavailable !== null
                              ? ` — ${option.unavailable}`
                              : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                {options.length === 0 ? (
                  <p className="text-fg-subtle text-sm">
                    This project has no other environment to inherit from.
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    disabled={chosen === null || chosen.unavailable !== null}
                    onClick={() => setConfirming('set')}
                  >
                    {chosen === null ? 'Inherit' : `Inherit from ${chosen.name}`}
                  </Button>
                  {parent !== null ? (
                    <Button variant="secondary" onClick={() => setConfirming('clear')}>
                      Stop inheriting
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-fg-subtle text-sm">
                Only an owner or admin can change what this environment inherits from.
              </p>
            )}
          </>
        )}
      </CardContent>

      {/* Production asks for its slug, as every other change to what production
          serves does: a new parent changes every value production resolves for
          a key it does not hold, from the very next deploy. */}
      {environment.isProduction ? (
        <ConfirmDialog
          strength="production"
          confirmPhrase={environment.slug}
          open={confirming !== null}
          onOpenChange={(open) => (open ? undefined : setConfirming(null))}
          title={confirmTitle}
          description={confirmDescription}
          confirmLabel={confirming === 'clear' ? 'Stop inheriting' : 'Inherit'}
          confirmVariant="primary"
          onConfirm={() => change(confirming === 'clear' ? null : choice)}
        />
      ) : (
        <ConfirmDialog
          open={confirming !== null}
          onOpenChange={(open) => (open ? undefined : setConfirming(null))}
          title={confirmTitle}
          description={confirmDescription}
          confirmLabel={confirming === 'clear' ? 'Stop inheriting' : 'Inherit'}
          confirmVariant="primary"
          onConfirm={() => change(confirming === 'clear' ? null : choice)}
        />
      )}

      {/* The second question, asked only when the server says the link crosses
          production's protection — with its sentence, which names the people
          who could then change production's values. */}
      <ConfirmDialog
        open={crossing !== null}
        onOpenChange={(open) => (open ? undefined : setCrossing(null))}
        title={`${environment.name} would inherit from an environment that is not production`}
        description={crossing?.warning ?? ''}
        confirmLabel="Inherit anyway"
        confirmVariant="danger"
        onConfirm={() => (crossing === null ? undefined : change(crossing.next, true))}
      />
    </Card>
  );
}
