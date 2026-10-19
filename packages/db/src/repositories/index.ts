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

export {
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  FieldConflictError,
  QuotaExceededError,
  RepositoryError,
} from './shared';
export type { Executor, RepositoryErrorCode, Transaction } from './shared';

export {
  findUserByEmail,
  findUserById,
  findUserByWorkosId,
  isUniqueViolation,
  softDeleteUser,
  touchLastLogin,
  updateUserProfile,
  upsertUserFromWorkosIdentity,
} from './users';
export type { IdentityLinkOutcome, UpsertedUser, User, UserProfilePatch } from './users';

export {
  createSession,
  deleteExpiredSessions,
  deleteSpentSignInConfirmations,
  findSessionByTokenHash,
  findSessionFreshAuth,
  listUserSessions,
  lockSessions,
  markSessionUnlocked,
  revokeAllUserSessions,
  revokeSession,
  revokeSessionForSignOut,
  sessionLookupQuery,
  spendSignInConfirmation,
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
  findRetainedRecoveryWrap,
  listRetainedVaults,
  loadRetainedVault,
  purgeExpiredRetainedVaults,
  countRetainedRecoveryFailure,
  restoreRetainedGrants,
  retainVaultForReset,
} from './retained-vaults';
export type {
  PurgedRetainedVault,
  RestoredGrantSeed,
  RestoreResult,
  RestoreSkipReason,
  RestoreTarget,
  RetainedGrantRecord,
  RetainedVaultMaterial,
  RetainedVaultReceipt,
  RetainedVaultSummary,
} from './retained-vaults';

export {
  listArchiveGrants,
  listArchiveSecrets,
  loadArchiveVault,
  measureArchiveSecrets,
} from './vault-archive';
export { VAULT_RETENTION_DAYS, VAULT_RETENTION_MS } from '../schema/retained-vaults';
export type {
  ArchiveGrantRecord,
  ArchiveSecretMeasure,
  ArchiveSecretRecord,
  ArchiveVaultRecord,
} from './vault-archive';

export {
  changePassphrase,
  completeRecovery,
  createVault,
  deleteVault,
  enrollPasskey,
  findRecoveryWrap,
  findVaultKeys,
  hasVault,
  listPasskeys,
  loadVault,
  recordRecoveryAttempt,
  recordUnlockAttempt,
  regenerateRecoveryCodes,
  removePasskey,
  resetVault,
  setAutoLockMinutes,
  touchPasskeyUsage,
} from './vault';
export type {
  ChangePassphraseParams,
  CompleteRecoveryParams,
  CreateVaultParams,
  EnrollPasskeyParams,
  PasskeyRecord,
  RecoveryWrapMatch,
  RecoveryWrapSeed,
  VaultKeyRecord,
  VaultRecord,
} from './vault';

export {
  attemptPinUnlock,
  disablePinPepper,
  listPinPeppers,
  mintPinPepper,
  pinDeviceQuery,
  pinDevicesQuery,
  revokeAllPinPeppers,
} from './vault-pin';
export type { MintPinPepperParams, PinAttemptOutcome, PinDeviceRecord } from './vault-pin';

export {
  accountLockQuery,
  accountOrganizationCeiling,
  countNonSsoAccess,
  countOrganizationsHeldBy,
  findOrganizationById,
  findOrganizationBySlugWithEntitlements,
  findOrgByWorkosOrgId,
  findWorkosHome,
  generateUniqueOrgSlug,
  organizationBySlugWithEntitlementsQuery,
  isOrgSlugAvailable,
  listMemberAddresses,
  listOrganizationsForUser,
  orgSlugCandidate,
  organizationsForUserQuery,
  organizationsHeldByQuery,
  personalOrgSlugSeed,
  provisionOrganization,
  setOrgWorkosOrgId,
  softDeleteOrganization,
  updateOrganization,
  updateOrgSsoSettings,
} from './organizations';
export type {
  AccessOutsideSso,
  Environment,
  HeldOrganizations,
  Organization,
  OrganizationMembership,
  OrganizationPatch,
  OrganizationWithEntitlements,
  OrgSsoSettingsChange,
  OrgSsoSettingsPatch,
  OrgWorkosLink,
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
  listGrantsForMembers,
  listGrantsForOrganization,
  listMembers,
  loadAuthorizationContext,
  loadOrganizationAuthorizationContexts,
  lockOrganization,
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
  wasRemovedFrom,
  wouldStrandOrganization,
} from './membership';
export type {
  AccessGrantParams,
  AccountMembership,
  AddMemberParams,
  AuthorizationContext,
  AuthorizationContextParams,
  MemberChange,
  MemberChangeGuard,
  MemberGrant,
  MemberListEntry,
  MemberPage,
  MemberRecord,
  MemberRef,
  MemberStatus,
  OwnershipChange,
  RemoveAccessGrantParams,
  RoleChangeResult,
  UpdateMemberRoleParams,
  WrittenMemberRecord,
} from './membership';

export {
  createCustomRole,
  deleteCustomRole,
  listCustomRoles,
  setMemberCustomRole,
  toEngineCustomRole,
  updateCustomRole,
} from './custom-roles';
export type {
  CreateCustomRoleParams,
  CustomRoleAssignment,
  CustomRoleCeiling,
  CustomRoleDefinition,
  CustomRoleEdit,
  CustomRoleHolder,
  CustomRoleListEntry,
  CustomRoleRecord,
  DeleteCustomRoleParams,
  MemberCustomRoleChange,
  SetMemberCustomRoleParams,
  UpdateCustomRoleParams,
  UpdatedCustomRole,
} from './custom-roles';

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
  addEnvKeyGrants,
  deleteGrantsForUser,
  canClaimInvitationGrants,
  findGrantForPrincipal,
  findPendingInvitationForGrant,
  initializeEnvironmentKeys,
  listClaimableInvitationGrants,
  listGrantsForEnvironment,
  listMemberSealingKeys,
  listPendingKeyGrants,
  listSealableServiceTokens,
  loadEnvironmentKeyState,
  loadMemberKeyPresence,
  queuePendingKeyGrant,
  readInvitationGrants,
  removeEnvKeyGrant,
  removeMemberGrantsForEnvironment,
  removePendingKeyGrant,
  rotateEnvDataKey,
  setInvitationPublicKey,
} from './env-keys';
export type {
  AddEnvKeyGrantsParams,
  ClaimableInvitationRecord,
  EnvDataKeyRecord,
  EnvironmentKeyState,
  EnvKeyGrantRecord,
  EnvKeyGrantSeed,
  InitializeEnvironmentKeysParams,
  InvitationGrantRecord,
  MemberSealingKeys,
  PendingInvitationForGrant,
  PendingKeyGrantRecord,
  RotateEnvDataKeyParams,
} from './env-keys';

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
  EnvironmentKeyInit,
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
  SecretPayload,
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
  joinOrganizationJustInTime,
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
  JustInTimeJoin,
  SeatUsage,
} from './invitations';

export {
  consumeReauthProof,
  findFreshSignIn,
  issueReauthProof,
  markReauthCodeSent,
  recordFreshSignIn,
  recordReauthMfaPending,
  reserveReauthCodeSend,
  reserveReauthGuess,
} from './reauth';
export type { CodeSendReservation, GuessReservation, Reauthentication } from './reauth';

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

export {
  claimWebhookEvent,
  createFreeSubscription,
  entitlementColumns,
  entitlementsFromRow,
  findSubscription,
  findUsage,
  loadEntitlements,
  recordFetches,
  recordMeteredUnits,
  setBilledSeats,
  subscriptionQuery,
  updateSubscription,
  usageQuery,
} from './subscriptions';
export type {
  SubscriptionEntitlementRow,
  SubscriptionPatch,
  SubscriptionRecord,
  UsageCounterRecord,
} from './subscriptions';
