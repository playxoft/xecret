'use client';

import { useSession } from '@/app/(dashboard)/_components/session';

/**
 * Who wrote a secret or a version.
 *
 * ── Why this shows an id and not a name ──
 * The API answers with a user id, and there is no endpoint that turns one into a
 * person: `GET /api/orgs/{orgSlug}/members` is specified but not implemented —
 * it lands in Phase 7. So the honest options are an id or nothing, and an id is
 * useful: it is stable, it is greppable against the audit log, and it
 * distinguishes two authors from each other.
 *
 * The one identity the browser *can* resolve is the viewer's own, from
 * `/api/auth/me`, and "you" is by far the most common answer on a small team —
 * so that case is spelled out and the rest carry the id's leading characters,
 * with the whole value in the title for copying. Inventing a display name here,
 * or showing "Unknown", would be worse than either.
 */
export function Actor({
  userId,
  serviceTokenId = null,
}: {
  userId: string | null;
  /** Set instead of `userId` when the write came from a CI service token. */
  serviceTokenId?: string | null;
}) {
  const { user } = useSession();

  if (serviceTokenId !== null) {
    // A CI write. The token's id is stable and greppable against the audit log
    // and the token list; its display name lives on the tokens page.
    return (
      <span className="text-fg-subtle" title={`Service token ${serviceTokenId}`}>
        CI token
      </span>
    );
  }

  if (userId === null) {
    // Unreachable while the writer CHECK holds; rendered honestly if it ever is.
    return <span className="text-fg-subtle">—</span>;
  }

  if (userId === user.id) {
    return <span className="text-fg-muted">you</span>;
  }

  return (
    <span className="text-fg-subtle font-mono" title={`Member ${userId}`}>
      {userId.slice(0, 8)}
    </span>
  );
}
