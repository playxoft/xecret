/**
 * The repository layer: every query xecret makes, in one place.
 *
 * Two rules hold across all of it, and both are checked by the tests in this
 * directory rather than left to review:
 *
 *  1. **Every tenant-scoped query filters on `org_id`**, even when the caller
 *     has already checked. Where a table has no `org_id` of its own —
 *     `environments`, `secrets`, `secret_versions` — the filter is reached
 *     through an explicit join, and that join *is* the isolation boundary
 *     (threat T2). A "simplification" that drops it removes the boundary.
 *  2. **Credentials never come back out.** No listing function selects a
 *     `token_hash`, and that is achieved with explicit column lists rather than
 *     by discarding fields afterwards — a column that is never selected cannot
 *     be logged by accident (threat T6).
 *
 * Functions take an `Executor` rather than holding a connection, so the same
 * function works standalone and inside a transaction. The caller owns the
 * transaction boundary; a repository never opens one behind the caller's back.
 */

export { clampPageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, RepositoryError } from './shared';
export type { Executor, RepositoryErrorCode, Transaction } from './shared';

export {
  findUserByEmail,
  findUserByFirebaseUid,
  findUserById,
  isUniqueViolation,
  softDeleteUser,
  touchLastLogin,
  upsertUserFromIdentity,
} from './users';
export type { User } from './users';

export {
  createSession,
  deleteExpiredSessions,
  findSessionByTokenHash,
  listUserSessions,
  lockSessions,
  markSessionUnlocked,
  revokeAllUserSessions,
  revokeSession,
  sessionLookupQuery,
  touchSession,
  userSessionsQuery,
} from './sessions';
export type {
  AuthenticatedSession,
  CreateSessionParams,
  SessionDevice,
  SessionUser,
} from './sessions';

export {
  consumePinReset,
  createPinReset,
  deleteExpiredPinResets,
  deletePin,
  findPinForUser,
  hasPin,
  recordPinAttempt,
  rehashPin,
  setAutoLockMinutes,
  upsertPin,
} from './pins';
export type { CreatePinResetParams, PinRecord, PinResetRecord } from './pins';

export {
  countOrganizationsCreatedBy,
  findOrganizationById,
  findOrganizationBySlug,
  generateUniqueOrgSlug,
  isOrgSlugAvailable,
  listOrganizationsForUser,
  orgSlugCandidate,
  organizationsCreatedByQuery,
  organizationsForUserQuery,
  personalOrgSlugSeed,
  provisionOrganization,
  softDeleteOrganization,
  updateOrganization,
} from './organizations';
export type {
  CreatedOrganizations,
  Environment,
  Organization,
  OrganizationMembership,
  OrganizationPatch,
  Project,
  ProvisionedOrganization,
  ProvisionOrganizationParams,
} from './organizations';

export {
  accountMembershipSummary,
  addMember,
  findMembership,
  findMemberWithUser,
  listGrantsForMember,
  listGrantsForOrganization,
  listMembers,
  loadAuthorizationContext,
  memberGrantsQuery,
  membersPageQuery,
  membershipQuery,
  reinstateMember,
  removeAccessGrant,
  removeMember,
  suspendMember,
  toAuthorizationContext,
  updateMemberRole,
  upsertAccessGrant,
  wouldStrandOrganization,
} from './membership';
export type {
  AccessGrantParams,
  AccountMembership,
  AddMemberParams,
  AuthorizationContext,
  AuthorizationContextParams,
  MemberGrant,
  MemberListEntry,
  MemberPage,
  MemberRecord,
  MemberRef,
  MemberStatus,
  OwnershipChange,
  RemoveAccessGrantParams,
  UpdateMemberRoleParams,
} from './membership';

export {
  createProject,
  findProjectById,
  findProjectBySlug,
  listProjects,
  restoreProject,
  softDeleteProject,
  updateProject,
} from './projects';
export type {
  CreateProjectParams,
  PageRequest,
  ProjectListItem,
  ProjectPage,
  ProjectRecord,
  UpdateProjectParams,
} from './projects';

export {
  createEnvironment,
  findEnvironmentById,
  findEnvironmentBySlug,
  listEnvironments,
  listEnvironmentsForOrganization,
  loadEnvironmentKeyChain,
  softDeleteEnvironment,
  toBytes,
  toCipherAlgorithm,
  UnsupportedAlgorithmError,
  updateEnvironment,
  withinOrganization,
} from './environments';
export type {
  CreateEnvironmentParams,
  EnvironmentKeyChain,
  EnvironmentRecord,
  OrganizationEnvironment,
  UpdateEnvironmentParams,
} from './environments';

export {
  addSecretVersion,
  countSecrets,
  createSecret,
  findSecretByName,
  getSecretVersion,
  listSecretVersions,
  listSecrets,
  loadEnvironmentSecrets,
  restoreSecret,
  softDeleteSecret,
  updateSecretMetadata,
  writerColumns,
} from './secrets';
export type {
  AddSecretVersionParams,
  CreateSecretParams,
  SecretListItem,
  SecretMaterial,
  SecretPage,
  SecretRecord,
  SecretVersionPage,
  SecretVersionSummary,
  SecretWriterRef,
  UpdateSecretMetadataParams,
} from './secrets';

export {
  acceptInvitation,
  createInvitation,
  deleteExpiredInvitations,
  findInvitationByToken,
  findInvitationByTokenHash,
  invitationClaimQuery,
  listInvitations,
  pendingInvitationsQuery,
  revokeInvitation,
  seatUsage,
} from './invitations';
export type {
  AcceptedInvitation,
  AcceptInvitationParams,
  CreateInvitationParams,
  InvitationClaim,
  InvitationListEntry,
  InvitationRecord,
  IssuedInvitation,
  SeatUsage,
} from './invitations';

export {
  consumeCliAuthCode,
  consumeCliAuthCodeByValue,
  createCliAuthCode,
  deleteExpiredCliAuthCodes,
} from './cli-auth';
export type { CliAuthCodeGrant, CreateCliAuthCodeParams, IssuedCliAuthCode } from './cli-auth';

export {
  createCliToken,
  createServiceToken,
  findCliTokenByHash,
  findCliTokenById,
  findServiceTokenByHash,
  isIpAllowed,
  listCliTokens,
  listServiceTokens,
  revokeAllCliTokensForUser,
  revokeCliToken,
  revokeServiceToken,
  touchCliTokenUsage,
  touchServiceTokenUsage,
} from './tokens';
export type {
  CliTokenPrincipal,
  CliTokenSummary,
  CreateCliTokenParams,
  CreateServiceTokenParams,
  IssuedToken,
  ServiceTokenPrincipal,
  ServiceTokenSummary,
} from './tokens';

export { appendAuditEvents, clampAuditRange, MAX_AUDIT_RANGE_DAYS, queryAuditLogs } from './audit';
export type { AuditCursor, AuditLogFilter, AuditLogRecord, AuditPage, AuditWindow } from './audit';
