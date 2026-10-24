import type { SecretPolicy, TokenPolicy } from '@xecret/core/policy';

/**
 * The organisation-policy payloads, as `GET /api/orgs/{org}/policies` returns
 * them (P19 §6, §8). Mirrors `OrgPoliciesPayload` in `server/schemas/policies.ts`,
 * restated here for the reason every client type file gives: the server module
 * drags zod and the repository types into a browser bundle.
 *
 * The two policies themselves are `@xecret/core/policy`'s own types, because
 * that module is what the dashboard, the CLI and the server all evaluate them
 * with — a second definition here would be a second answer to "what does the
 * policy say".
 */

/** Whether the plan includes a feature, and the cheapest plan that would. */
export interface FeatureStatus {
  enabled: boolean;
  upgradeTo: string | null;
}

export interface OrgPoliciesResponse {
  tokens: TokenPolicy;
  secrets: SecretPolicy;
  /** What the plan includes, so a settings screen can say why a control is locked. */
  features: {
    tokenIpAllowlist: FeatureStatus;
    secretPolicy: FeatureStatus;
    disableEnvExport: FeatureStatus;
    newIpReadAlerts: FeatureStatus;
  };
  updatedAt: string | null;
}

/** `PATCH /api/orgs/{org}/policies`: either policy, whole, or both. Answers the same shape. */
export interface OrgPoliciesPatch {
  tokens?: TokenPolicy;
  secrets?: SecretPolicy;
}
