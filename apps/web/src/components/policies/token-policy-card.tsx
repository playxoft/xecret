'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

import { MAX_TOKEN_LIFETIME_DAYS, tokenPolicyIsActive } from '@xecret/core/policy';
import type { TokenPolicy } from '@xecret/core/policy';
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
  Checkbox,
  Field,
  Input,
  Label,
  Skeleton,
  useToast,
} from '@/components/ui';
import { ChangeError, PlanLock } from '@/components/plans/plan-notice';
import { planName } from '@/components/plans/plan-copy';
import {
  fieldProblemsUnder,
  parseTokenPolicyDraft,
  sameTokenPolicy,
  tokenPolicyBlocked,
  tokenPolicyDraftOf,
} from './policy-form';
import type { TokenPolicyDraft } from './policy-form';
import type { FeatureStatus, OrgPoliciesResponse } from './types';

/**
 * The organisation's token policy (P19 §6, `tokenIpAllowlist`, Pro and above).
 *
 * Two rules every *new* service token is held to: name the addresses it may be
 * used from, and expire within a cap — which also caps the expiry a CLI device
 * login is issued with. A token minted before the rule keeps working; the
 * Tokens page marks it, so it can be replaced deliberately rather than broken
 * in the middle of somebody's deploy.
 *
 * ── A form, not two switches ──
 * The policy is stored whole — `PATCH` takes both fields together — and the cap
 * is a number somebody types, so the two are edited together and saved with one
 * button. A switch takes effect when flipped (see `Switch`), and a switch next
 * to a Save button is two conventions arguing about when the change happens.
 *
 * ── Who may, and the plan ──
 * Owners and admins edit; everybody else reads it, because the people held to a
 * rule should be able to see it. *Tightening* needs the plan; loosening and
 * switching off never do, and a downgrade switches nothing off — so a rule that
 * is on stays drawn and stays switchable off, with the plan named beside
 * whatever cannot be turned back on.
 */
export function TokenPolicyCard({
  orgSlug,
  policies,
  error,
  onRetry,
  canManage,
  onSaved,
}: {
  orgSlug: string;
  /** `null` while loading, and on failure. */
  policies: OrgPoliciesResponse | null;
  error: unknown;
  onRetry: () => void;
  canManage: boolean;
  onSaved: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Token policy</CardTitle>
        <CardDescription>
          Rules every new service token is held to when it is minted. Tokens minted before a rule
          keep working, and the Tokens page marks them so they can be replaced.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error !== null ? (
          <Alert tone="danger" title="The token policy could not be loaded">
            <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
              Try again
            </Button>
          </Alert>
        ) : policies === null ? (
          <div
            aria-busy="true"
            aria-label="Loading the token policy"
            className="flex flex-col gap-2"
          >
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : (
          // Keyed on what is stored, so a save that changed it reseeds the form
          // from the server's answer rather than keeping what was typed.
          <TokenPolicyForm
            key={JSON.stringify(policies.tokens)}
            orgSlug={orgSlug}
            stored={policies.tokens}
            feature={policies.features.tokenIpAllowlist}
            canManage={canManage}
            onSaved={onSaved}
          />
        )}
      </CardContent>
    </Card>
  );
}

function TokenPolicyForm({
  orgSlug,
  stored,
  feature,
  canManage,
  onSaved,
}: {
  orgSlug: string;
  stored: TokenPolicy;
  feature: FeatureStatus;
  canManage: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<TokenPolicyDraft>(() => tokenPolicyDraftOf(stored));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [capError, setCapError] = useState<string | null>(null);

  const parsed = parseTokenPolicyDraft(draft);
  const next = parsed.ok ? parsed.policy : null;
  const changed = next === null || !sameTokenPolicy(stored, next);
  const blocked = next !== null && tokenPolicyBlocked(stored, next, feature);

  /**
   * A rule that is off, on a plan that does not include the policy, cannot be
   * switched on — so its checkbox is drawn, locked. One that is *on* is never
   * locked: switching it off is a loosening, and loosening never needs a plan.
   */
  const allowlistLocked =
    !feature.enabled && !stored.requireIpAllowlist && !draft.requireIpAllowlist;
  const capLocked = !feature.enabled && stored.maxLifetimeDays === null && !draft.capLifetime;
  const nothingOn = !tokenPolicyIsActive(stored);

  function patch(change: Partial<TokenPolicyDraft>) {
    setDraft((current) => ({ ...current, ...change }));
    setCapError(null);
    setError(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !canManage) return;

    const result = parseTokenPolicyDraft(draft);
    if (!result.ok) {
      setCapError(result.message);
      return;
    }
    if (tokenPolicyBlocked(stored, result.policy, feature)) return;

    setSaving(true);
    setError(null);
    try {
      await api.patch<OrgPoliciesResponse>(apiPath.policies(orgSlug), { tokens: result.policy });
      toast({
        variant: 'success',
        title: 'Token policy saved',
        description: 'It applies to every service token minted from now on.',
      });
      onSaved();
    } catch (cause) {
      // A refused cap belongs under the cap; anything else is the card's.
      const fields = isApiError(cause) ? fieldProblemsUnder(cause.fields, 'tokens') : {};
      if (fields['maxLifetimeDays'] !== undefined) setCapError(fields['maxLifetimeDays']);
      else setError(cause);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-4">
      {error !== null ? <ChangeError error={error} title="The token policy was not saved" /> : null}

      {!feature.enabled ? (
        nothingOn ? (
          <PlanLock what="Setting a token policy" upgradeTo={feature.upgradeTo} />
        ) : (
          // The downgraded case. Said plainly, because "why can I switch this
          // off but not back on?" has exactly this answer.
          <p className="text-fg-subtle text-sm leading-5">
            This organisation’s plan no longer includes the token policy. The rules below stay
            enforced, and you can loosen them or switch them off;{' '}
            {feature.upgradeTo === null
              ? 'tightening them is not part of this plan.'
              : `tightening them again needs the ${planName(feature.upgradeTo)} plan.`}
          </p>
        )
      ) : null}

      <PolicyCheckRow
        id="token-policy-allowlist"
        label="Require an IP allowlist"
        description="Every new service token must name the addresses or ranges it may be used from. A request from anywhere else is refused, so a token copied out of a CI provider is useless outside it."
        checked={draft.requireIpAllowlist}
        disabled={!canManage || saving || allowlistLocked}
        onCheckedChange={(checked) => patch({ requireIpAllowlist: checked })}
      />

      <PolicyCheckRow
        id="token-policy-cap"
        label="Cap how long a token lives"
        description="Every new service token must expire within the cap, and a CLI device login is issued with an expiry no later than it. A credential that cannot outlive a quarter cannot be forgotten for a year."
        checked={draft.capLifetime}
        disabled={!canManage || saving || capLocked}
        onCheckedChange={(checked) => patch({ capLifetime: checked })}
      >
        {draft.capLifetime ? (
          <Field
            label="Longest lifetime, in days"
            error={capError}
            hint={`From 1 to ${MAX_TOKEN_LIFETIME_DAYS} days.`}
            className="mt-3 max-w-56"
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_TOKEN_LIFETIME_DAYS}
              value={draft.maxLifetimeDays}
              onChange={(event) => patch({ maxLifetimeDays: event.target.value })}
              disabled={!canManage || saving}
            />
          </Field>
        ) : null}
      </PolicyCheckRow>

      <p className="text-fg-subtle text-sm leading-5">
        Checked when a token is minted, never when it is used: enforcing at use would break every
        pipeline in the organisation the moment a box was ticked. Setting an allowlist or an expiry
        on a single token stays available on every plan.
      </p>

      {blocked && !nothingOn ? (
        <PlanLock what="Tightening the token policy" upgradeTo={feature.upgradeTo} />
      ) : null}

      {canManage ? (
        <div>
          <Button type="submit" variant="primary" loading={saving} disabled={!changed || blocked}>
            Save token policy
          </Button>
        </div>
      ) : (
        <p className="text-fg-subtle text-sm">
          Only an owner or admin can change the token policy.
        </p>
      )}
    </form>
  );
}

/**
 * One rule: a checkbox, what it does, and whatever it needs beneath it.
 *
 * The bordered row the SSO card's switches sit in, with a checkbox rather than
 * a switch, because these rows belong to a form that is saved as a whole.
 */
export function PolicyCheckRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
  children,
}: {
  id: string;
  label: string;
  description: ReactNode;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="border-line rounded-lg border p-3.5">
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          className="mt-0.5"
          aria-describedby={`${id}-description`}
        />
        <div className="min-w-0 flex-1">
          <Label htmlFor={id}>{label}</Label>
          <p id={`${id}-description`} className="text-fg-muted mt-1 text-sm leading-5">
            {description}
          </p>
          {children}
        </div>
      </div>
    </div>
  );
}
