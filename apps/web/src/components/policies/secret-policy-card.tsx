'use client';

import { useState } from 'react';

import { SECRET_POLICY_LIMITS } from '@xecret/core/policy';
import type { SecretPolicy, SecretPolicyScope } from '@xecret/core/policy';
import { api, isApiError } from '@/lib/api';
import { apiPath } from '@/app/(dashboard)/_lib/paths';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui';
import { ChangeError, PlanLock } from '@/components/plans/plan-notice';
import { planName } from '@/components/plans/plan-copy';
import {
  fieldProblemsUnder,
  parseSecretPolicyDraft,
  sameSecretPolicy,
  secretPolicyBlocked,
  secretPolicyDraftOf,
  storedSecretPolicyProblem,
  withDefaultRules,
} from './policy-form';
import type { SecretPolicyDraft, SecretPolicyField } from './policy-form';
import { PolicyCheckRow } from './token-policy-card';
import type { FeatureStatus, OrgPoliciesResponse } from './types';

const SCOPES: ReadonlyArray<{ value: SecretPolicyScope; label: string }> = [
  { value: 'all', label: 'Every environment' },
  { value: 'production', label: 'Production environments only' },
];

/**
 * The organisation's secret naming and strength policy (P19 §8, `secretPolicy`,
 * Team and above).
 *
 * ── What the card has to say plainly ──
 * Who enforces each rule, because they are not the same party and pretending
 * otherwise would be a promise the product cannot keep. Names are plaintext, so
 * the **server** holds every new name to the pattern — a create, a rename, an
 * import, a promotion — and no client can get past it. Values are never seen by
 * the server, so the **value** rules are enforced by the clients that hold the
 * plaintext, the dashboard and the CLI, before they encrypt: a modified client
 * could skip them, and nothing on the server could tell. And a rule switched on
 * today does not make yesterday's secrets unreadable — they are marked in their
 * environment, and the next change to each is held to it.
 *
 * ── The plan ──
 * Switching the policy on, or changing it while it is on, needs the plan.
 * Switching it off, or preparing the rules while it is off, never does — and an
 * organisation that downgraded keeps its policy enforced, with the controls to
 * switch it off still in reach.
 */
export function SecretPolicyCard({
  orgSlug,
  policies,
  error,
  onRetry,
  canManage,
  onSaved,
}: {
  orgSlug: string;
  policies: OrgPoliciesResponse | null;
  error: unknown;
  onRetry: () => void;
  canManage: boolean;
  onSaved: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Secret naming and strength</CardTitle>
        <CardDescription>
          A naming rule for keys, and a strength rule for values, applied to every write in the
          environments it covers.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== null ? (
          <Alert tone="danger" title="The secret policy could not be loaded">
            <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
              Try again
            </Button>
          </Alert>
        ) : policies === null ? (
          <div
            aria-busy="true"
            aria-label="Loading the secret policy"
            className="flex flex-col gap-2"
          >
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <SecretPolicyForm
            key={JSON.stringify(policies.secrets)}
            orgSlug={orgSlug}
            stored={policies.secrets}
            feature={policies.features.secretPolicy}
            canManage={canManage}
            onSaved={onSaved}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SecretPolicyForm({
  orgSlug,
  stored,
  feature,
  canManage,
  onSaved,
}: {
  orgSlug: string;
  stored: SecretPolicy;
  feature: FeatureStatus;
  canManage: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<SecretPolicyDraft>(() => secretPolicyDraftOf(stored));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SecretPolicyField, string>>>({});

  const parsed = parseSecretPolicyDraft(draft);
  const next = parsed.ok ? parsed.policy : null;
  const changed = next === null || !sameSecretPolicy(stored, next);
  const blocked = next !== null && secretPolicyBlocked(stored, next, feature);
  const storedProblem = storedSecretPolicyProblem(stored);

  /**
   * Switching the policy on is the one control locked outright on a plan that
   * lacks it. Re-ticking it after unticking a stored policy that is on is a
   * return to what is stored, not a switch-on, so that stays available.
   */
  const enableLocked = !feature.enabled && !stored.enabled && !draft.enabled;
  const editable = canManage && !saving;

  function patch(change: Partial<SecretPolicyDraft>) {
    setDraft((current) => ({ ...current, ...change }));
    setFieldErrors({});
    setError(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !canManage) return;

    // Checked here with the same `validateSecretPolicy` the server runs before
    // it stores a policy, so a pattern that does not compile, or could
    // backtrack, is refused under its own field without a round trip.
    const result = parseSecretPolicyDraft(draft);
    if (!result.ok) {
      setFieldErrors({ [result.field]: result.message });
      return;
    }
    if (secretPolicyBlocked(stored, result.policy, feature)) return;

    setSaving(true);
    setError(null);
    try {
      await api.patch<OrgPoliciesResponse>(apiPath.policies(orgSlug), {
        secrets: result.policy,
      });
      toast({
        variant: 'success',
        title: result.policy.enabled ? 'Secret policy saved' : 'Secret policy is off',
        ...(result.policy.enabled
          ? { description: 'Existing secrets that break it are marked in their environment.' }
          : {}),
      });
      onSaved();
    } catch (cause) {
      // The route names a refused field `secrets.<field>`; those go under the
      // field, and anything else is the card's.
      const fields = isApiError(cause) ? fieldProblemsUnder(cause.fields, 'secrets') : {};
      if (Object.keys(fields).length > 0) setFieldErrors(fields);
      else setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-4">
      {error !== null ? (
        <ChangeError error={error} title="The secret policy was not saved" />
      ) : null}

      {storedProblem !== null ? (
        <Alert tone="warning" title="The stored policy does not pass today’s checks">
          {storedProblem} The server skips a rule it cannot evaluate rather than refusing every
          write over it — fix it here and save.
        </Alert>
      ) : null}

      {!feature.enabled ? (
        stored.enabled ? (
          <p className="text-fg-subtle text-sm leading-5">
            This organisation’s plan no longer includes the secret policy. It stays enforced, and
            you can switch it off;{' '}
            {feature.upgradeTo === null
              ? 'changing it while it is on is not part of this plan.'
              : `changing it while it is on needs the ${planName(feature.upgradeTo)} plan.`}
          </p>
        ) : (
          <PlanLock what="Switching the secret policy on" upgradeTo={feature.upgradeTo} />
        )
      ) : null}

      <Alert tone="info" title="Who enforces which rule">
        <p>
          <span className="text-fg font-medium">Names</span> are checked by the server on every
          write that introduces one — a new secret, a rename, an import, a promotion — so no client
          can get past the naming rule.
        </p>
        <p className="mt-1.5">
          <span className="text-fg font-medium">Values</span> never reach the server in plaintext,
          so the strength rules are checked by the dashboard and the CLI before they encrypt. A
          modified client could skip them, and the server could not tell.
        </p>
        <p className="mt-1.5">
          Secrets that already break a rule keep working and are never blocked on read. They are
          marked in their environment, and the next change to each is held to the rule.
        </p>
      </Alert>

      <PolicyCheckRow
        id="secret-policy-enabled"
        label="Enforce this policy"
        description="When this is off the rules below are kept but not applied, so they can be prepared before anybody is held to them."
        checked={draft.enabled}
        disabled={!editable || enableLocked}
        onCheckedChange={(checked) => patch({ enabled: checked })}
      />

      <Field
        label="Applies to"
        hint="A production-only policy leaves development and staging free to use placeholder values."
        error={fieldErrors.scope ?? null}
      >
        <Select
          value={draft.scope}
          onValueChange={(value) => patch({ scope: value === 'production' ? 'production' : 'all' })}
          disabled={!editable}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPES.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <PolicyCheckRow
        id="secret-policy-names"
        label="Require names to match a pattern"
        description="A regular expression the whole name must match — it is anchored, so [A-Z_]+ means only those characters, not merely one of them. Checked by the server."
        checked={draft.useNamePattern}
        disabled={!editable}
        onCheckedChange={(checked) => patch({ useNamePattern: checked })}
      >
        {draft.useNamePattern ? (
          <Field
            label="Name pattern"
            error={fieldErrors.namePattern ?? null}
            hint={`Up to ${SECRET_POLICY_LIMITS.namePatternMaxLength} characters. A group that repeats and itself repeats, such as (A+)+, is refused: it could stall the server.`}
            className="mt-3"
          >
            <Input
              value={draft.namePattern}
              onChange={(event) => patch({ namePattern: event.target.value })}
              maxLength={SECRET_POLICY_LIMITS.namePatternMaxLength}
              placeholder="[A-Z][A-Z0-9_]*"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              disabled={!editable}
            />
          </Field>
        ) : null}
      </PolicyCheckRow>

      <PolicyCheckRow
        id="secret-policy-entropy"
        label="Require strong values"
        description="An estimate of each value's randomness, in bits. A 32-character random token scores well over 100; password1 scores under 30. Checked by the dashboard and the CLI."
        checked={draft.useEntropy}
        disabled={!editable}
        onCheckedChange={(checked) => patch({ useEntropy: checked })}
      >
        {draft.useEntropy ? (
          <div className="mt-3 flex flex-col gap-4">
            <Field
              label="Minimum entropy, in bits"
              error={fieldErrors.minValueEntropyBits ?? null}
              hint={`From 1 to ${SECRET_POLICY_LIMITS.maxEntropyBits}.`}
              className="max-w-56"
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={SECRET_POLICY_LIMITS.maxEntropyBits}
                value={draft.minValueEntropyBits}
                onChange={(event) => patch({ minValueEntropyBits: event.target.value })}
                disabled={!editable}
              />
            </Field>
            <Field
              label="Only for names containing"
              optional
              error={fieldErrors.entropyAppliesTo ?? null}
              hint="One per line, matched anywhere in the name and ignoring case. Leave it empty to hold every value to the rule — including PORT and NODE_ENV, which is rarely what anybody wants."
            >
              <Textarea
                value={draft.entropyAppliesTo}
                onChange={(event) => patch({ entropyAppliesTo: event.target.value })}
                rows={4}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                disabled={!editable}
              />
            </Field>
          </div>
        ) : null}
      </PolicyCheckRow>

      <Field
        label="Forbidden words"
        optional
        error={fieldErrors.forbiddenSubstrings ?? null}
        hint={`One per line, matched anywhere in a value and ignoring case — the placeholders that reach production more often than anyone admits. At most ${SECRET_POLICY_LIMITS.maxListEntries}. A refusal never says which word matched: the word is part of the value.`}
      >
        <Textarea
          value={draft.forbiddenSubstrings}
          onChange={(event) => patch({ forbiddenSubstrings: event.target.value })}
          rows={4}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          disabled={!editable}
        />
      </Field>

      {blocked && feature.enabled === false && (stored.enabled || draft.enabled) ? (
        <PlanLock
          what={
            stored.enabled
              ? 'Changing the secret policy while it is on'
              : 'Switching the secret policy on'
          }
          upgradeTo={feature.upgradeTo}
        />
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={saving} disabled={!changed || blocked}>
            Save secret policy
          </Button>
          <Button variant="ghost" onClick={() => patch(withDefaultRules(draft))} disabled={saving}>
            Use the defaults
          </Button>
          {changed ? (
            <Button
              variant="ghost"
              onClick={() => patch(secretPolicyDraftOf(stored))}
              disabled={saving}
            >
              Discard changes
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-fg-subtle text-sm">
          Only an owner or admin can change the secret policy.
        </p>
      )}
    </form>
  );
}
