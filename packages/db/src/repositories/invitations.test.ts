import { describe, expect, it } from 'vitest';
import { hashToken } from '@xecret/core/auth';
import { uuidv7 } from '@xecret/core/ids';
import { createDatabase } from '../client';
import { invitationClaimQuery, pendingInvitationsQuery } from './invitations';

/**
 * Shape tests, like the rest of this directory: no PostgreSQL behind them.
 * What they pin is that the invitation listing is tenant-filtered and never
 * selects the token hash, and that token resolution joins through a live
 * organisation. The transactional paths — supersede-on-reinvite, the seat
 * check under the organisation lock, atomic acceptance — need a real database
 * and belong to the integration pass (see the standing caveat in the plan).
 */

const db = createDatabase({ connectionString: 'postgres://xecret@localhost:5432/xecret' });

const ORG_ID = uuidv7();

describe('listing an organisation’s invitations', () => {
  const query = () => pendingInvitationsQuery(db, ORG_ID).toSQL();

  it('filters on the organisation', () => {
    const { sql, params } = query();

    expect(sql).toContain('"invitations"."org_id" = $1');
    expect(params).toContain(ORG_ID);
  });

  it('returns only open invitations — accepted and revoked rows are history, not state', () => {
    const { sql } = query();

    expect(sql).toContain('"invitations"."accepted_at" is null');
    expect(sql).toContain('"invitations"."revoked_at" is null');
  });

  it('never selects the token hash', () => {
    expect(query().sql).not.toContain('token_hash');
  });

  it('is bounded, because an unbounded tenant listing is a memory ceiling away from an outage', () => {
    expect(query().sql).toContain('limit');
  });
});

describe('resolving a presented invitation token', () => {
  const query = async () => invitationClaimQuery(db, await hashToken('xin_live_example')).toSQL();

  it('matches on the hash of the token, never on the token', async () => {
    const { sql, params } = await query();

    expect(sql).toContain('"invitations"."token_hash" = $1');
    expect(params[0]).toEqual(Buffer.from(await hashToken('xin_live_example')));
  });

  it('joins through a live organisation, so a deleted tenant’s invitations resolve to nothing', async () => {
    const { sql } = await query();

    expect(sql).toContain('inner join "organizations"');
    expect(sql).toContain('"organizations"."deleted_at" is null');
  });

  it('drops a deleted inviter rather than the whole invitation', async () => {
    // A left join: the invitation must still resolve after the inviter leaves,
    // or their departure would strand every invitation they ever sent.
    expect((await query()).sql).toContain('left join "users"');
  });
});
