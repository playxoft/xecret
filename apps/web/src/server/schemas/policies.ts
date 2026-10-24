import * as z from 'zod/mini';
import { MAX_TOKEN_LIFETIME_DAYS, SECRET_POLICY_LIMITS } from '@xecret/core/policy';
import type { SecretPolicy, TokenPolicy } from '@xecret/core/policy';

/**
 * The request schemas and response shapes of the policy routes (P19 §6–§9):
 * the organisation's token and secret policies, and an environment's two
 * switches.
 *
 * Shape is checked here; meaning — a name pattern that compiles and cannot
 * backtrack, list entries of a sensible size — by `validateSecretPolicy`, which
 * the dashboard runs as well, so a policy the settings screen accepts is one the
 * server stores.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';

const listSchema = z
  .array(z.string().check(z.maxLength(SECRET_POLICY_LIMITS.maxListEntryLength)))
  .check(z.maxLength(SECRET_POLICY_LIMITS.maxListEntries));

export const tokenPolicySchema = z.strictObject(
  {
    requireIpAllowlist: z.boolean(),
    maxLifetimeDays: z.nullable(
      z
        .int()
        .check(
          z.gte(1, 'A lifetime cap is at least one day.'),
          z.lte(
            MAX_TOKEN_LIFETIME_DAYS,
            `A lifetime cap is at most ${MAX_TOKEN_LIFETIME_DAYS} days.`,
          ),
        ),
    ),
  },
  UNEXPECTED_FIELD,
);

export const secretPolicySchema = z.strictObject(
  {
    enabled: z.boolean(),
    scope: z.enum(['all', 'production']),
    namePattern: z.nullable(
      z.string().check(z.maxLength(SECRET_POLICY_LIMITS.namePatternMaxLength)),
    ),
    minValueEntropyBits: z.nullable(z.int()),
    entropyAppliesTo: listSchema,
    forbiddenSubstrings: listSchema,
  },
  UNEXPECTED_FIELD,
);

/** Either policy, whole, or both. Each one given replaces the stored one. */
export const orgPoliciesPatchSchema = z.strictObject(
  {
    tokens: z.optional(tokenPolicySchema),
    secrets: z.optional(secretPolicySchema),
  },
  UNEXPECTED_FIELD,
);

export type OrgPoliciesPatch = z.infer<typeof orgPoliciesPatchSchema>;

/**
 * An environment's switches. Each is optional; one absent is left as it is.
 * `readAlerts: null` restores the default — on for production, off elsewhere.
 */
export const environmentPolicySchema = z.strictObject(
  {
    plaintextExport: z.optional(z.enum(['allowed', 'disabled'])),
    readAlerts: z.optional(z.nullable(z.boolean())),
  },
  UNEXPECTED_FIELD,
);

export type EnvironmentPolicyPatch = z.infer<typeof environmentPolicySchema>;

/** Whether the plan includes a feature, and the cheapest plan that would. */
export interface FeatureStatusPayload {
  enabled: boolean;
  upgradeTo: string | null;
}

/**
 * Everything `GET /api/orgs/{org}/policies` answers.
 *
 * Readable by every member and by service tokens: the clients enforce the value
 * rules before they encrypt, so every client that writes needs the policy, and
 * nothing in it is a secret — it is the organisation's own rulebook.
 */
export interface OrgPoliciesPayload {
  tokens: TokenPolicy;
  secrets: SecretPolicy;
  /** What the plan includes, so a settings screen can say why a control is locked. */
  features: {
    tokenIpAllowlist: FeatureStatusPayload;
    secretPolicy: FeatureStatusPayload;
    disableEnvExport: FeatureStatusPayload;
    newIpReadAlerts: FeatureStatusPayload;
  };
  updatedAt: string | null;
}
