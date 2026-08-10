import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL enums are additive-only: values can be appended without a table
 * rewrite, but never removed. Chosen over check constraints so the type flows
 * into TypeScript automatically.
 */

export const orgRoleEnum = pgEnum('org_role', ['owner', 'admin', 'developer', 'viewer']);

export const memberStatusEnum = pgEnum('member_status', ['active', 'suspended']);

export const keyStatusEnum = pgEnum('key_status', ['active', 'retired', 'compromised']);

export const accessLevelEnum = pgEnum('access_level', ['none', 'read', 'write', 'admin']);

export const actorTypeEnum = pgEnum('actor_type', ['user', 'cli_token', 'service_token', 'system']);

export const auditOutcomeEnum = pgEnum('audit_outcome', ['success', 'denied', 'error']);
