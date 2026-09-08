export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfCookie,
  generateCsrfToken,
  isSafeMethod,
  verifyCsrf,
} from './csrf';
export type { CsrfRejection, CsrfResult } from './csrf';

export {
  clearedSessionCookie,
  evaluateSession,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
  SESSION_TOUCH_INTERVAL_MS,
  serializeCookie,
  sessionCookie,
  sessionExpiryFrom,
  shouldTouchSession,
} from './session';
export type { CookieOptions, SessionRecord } from './session';

export { generateToken, hashToken, isWellFormedToken, TOKEN_PREFIXES, verifyToken } from './tokens';
export type { GeneratedToken, TokenKind } from './tokens';

export { INVITATION_TTL_MS, invitationExpiryFrom, invitationState } from './invitation';
export type { InvitationLifecycle, InvitationState } from './invitation';

export {
  CLI_AUTH_CODE_TTL_MS,
  cliAuthCodeExpiryFrom,
  computePkceChallenge,
  PKCE_CHALLENGE_PATTERN,
  PKCE_VERIFIER_PATTERN,
  verifyPkce,
} from './pkce';

export {
  AUTO_LOCK_MINUTES_OPTIONS,
  DEFAULT_AUTO_LOCK_MINUTES,
  UNLOCK_VERIFIER_BYTES,
  VAULT_FREE_ATTEMPTS,
  VAULT_LOCKOUT_BASE_MS,
  VAULT_LOCKOUT_MAX_MS,
  VAULT_UNLOCK_MS,
  clearedUnlockFailures,
  evaluateUnlockLockout,
  hashUnlockVerifier,
  isAutoLockMinutes,
  isVaultUnlocked,
  nextUnlockFailure,
  unlockVerifierMatches,
  vaultUnlockExpiryFrom,
} from './vault';
export type { AutoLockMinutes, UnlockAttemptState, UnlockLockout } from './vault';

export { IdentityVerificationError } from './types';
export type {
  IdentityProvider,
  Session,
  SessionRejection,
  SessionResolution,
  VerifiedIdentity,
} from './types';
