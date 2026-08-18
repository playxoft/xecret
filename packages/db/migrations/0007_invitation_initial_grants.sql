-- Invitation-time access selection (deny-by-default membership).
--
-- The inviter chooses which projects and environments the new member may
-- reach; acceptance copies the selection into access_grants and writes an
-- explicit `none` for every other project the organisation has at that
-- moment. The column is a jsonb snapshot of ids — a request in transit, not
-- live authority; authority only ever lives in access_grants.
--
-- NULL (every existing row) preserves the old behaviour: role defaults apply.
-- Additive only; nothing dropped, nothing rewritten.

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS initial_grants jsonb;
