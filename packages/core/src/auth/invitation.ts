/**
 * Invitation policy — how long an offer to join an organisation stands, and how
 * its lifecycle is read.
 *
 * The token itself comes from `generateToken('invitation')` in `tokens.ts` and
 * is stored hashed, like every other credential. What lives here is the pure
 * policy around it, kept in core so the API, the UI copy and the tests all
 * answer "is this invitation still good?" with the same function instead of
 * three re-implementations that drift.
 */

/**
 * How long an invitation stands: seven days.
 *
 * Long enough to survive a weekend and an inbox backlog; short enough that a
 * mail account compromised months later does not come with a standing door into
 * an organisation. An expired invitation costs one click to re-send, so erring
 * short is cheap.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function invitationExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_MS);
}

/** The columns of an invitation row that decide its state. */
export interface InvitationLifecycle {
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

/**
 * Reads an invitation's state from its row.
 *
 * Precedence mirrors `evaluateSession`: the explicit endings win over the
 * implicit one, so an invitation that was revoked *and* has since expired reads
 * as revoked — the fact that somebody withdrew it is the more informative of
 * the two, and the one the audit trail records. Only a `pending` invitation can
 * be accepted or revoked; every other state is final.
 */
export function invitationState(record: InvitationLifecycle, now: Date): InvitationState {
  if (record.acceptedAt !== null) return 'accepted';
  if (record.revokedAt !== null) return 'revoked';
  if (record.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}
