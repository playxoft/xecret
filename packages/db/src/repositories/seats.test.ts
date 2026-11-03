import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashToken } from '@xecret/core/auth';
import { createTestDatabase, TEST_DATABASE_TIMEOUT_MS } from '../testing/pglite';
import type { TestDatabase } from '../testing/pglite';
import {
  acceptInvitation,
  createInvitation,
  joinOrganizationJustInTime,
  seatUsage,
} from './invitations';
import { RepositoryError } from './shared';

/**
 * Filling an organisation's seats through invitations, against a real
 * database — because the seat check is a count taken under a row lock, and
 * what it counts is a property of predicates evaluated against rows.
 *
 * ── The rule ──
 * Seated members plus open invitations may not exceed `seat_limit`. An open
 * invitation is a seat already promised, so a new invitation is refused when
 * none is left to promise. Accepting one is not a new claim: it turns a
 * promised seat into a held one, so the invitation being accepted must not be
 * counted against its own acceptance — otherwise the last seat an organisation
 * has can be promised and never filled.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, TEST_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  await t.close();
});

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `seat-${id.slice(0, 8)}@example.com`;
  await t.pg.query(
    `insert into users (id, workos_user_id, email, email_verified) values ($1, $2, $3, true)`,
    [id, `user_${id.slice(0, 8)}`, email],
  );
  return { id, email };
}

/** An organisation holding `seatLimit` seats, its founder seated in one of them. */
async function seedOrg(seatLimit: number): Promise<{ orgId: string; ownerId: string }> {
  const owner = await seedUser();
  const orgId = randomUUID();
  await t.pg.query(
    `insert into organizations (id, name, slug, created_by, seat_limit) values ($1, 'Acme', $2, $3, $4)`,
    [orgId, `seats-${orgId.slice(0, 8)}`, owner.id, seatLimit],
  );
  await t.pg.query(
    `insert into org_members (id, org_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), orgId, owner.id],
  );
  return { orgId, ownerId: owner.id };
}

async function invite(orgId: string, invitedBy: string) {
  const person = await seedUser();
  const issued = await createInvitation(t.db, {
    orgId,
    email: person.email,
    role: 'developer',
    invitedBy,
  });
  return { person, token: issued.token };
}

async function accept(person: { id: string; email: string }, token: string) {
  return acceptInvitation(t.db, {
    tokenHash: await hashToken(token),
    userId: person.id,
    userEmail: person.email,
  });
}

describe('filling the last seats through invitations', () => {
  it('seats everybody invited into the seats there were, the last one included', async () => {
    const { orgId, ownerId } = await seedOrg(3);
    const first = await invite(orgId, ownerId);
    const second = await invite(orgId, ownerId);

    // Every seat is spoken for: one held, two promised.
    expect(await seatUsage(t.db, orgId, new Date())).toEqual({
      members: 1,
      pendingInvitations: 2,
      seatLimit: 3,
    });

    await accept(first.person, first.token);
    await accept(second.person, second.token);

    expect(await seatUsage(t.db, orgId, new Date())).toEqual({
      members: 3,
      pendingInvitations: 0,
      seatLimit: 3,
    });
  });

  it('refuses an invitation past the last seat, counting the ones already promised', async () => {
    const { orgId, ownerId } = await seedOrg(3);
    await invite(orgId, ownerId);
    await invite(orgId, ownerId);

    const refused = invite(orgId, ownerId);
    await expect(refused).rejects.toBeInstanceOf(RepositoryError);
    await expect(refused).rejects.toMatchObject({ code: 'seatLimit' });
  });

  /**
   * The same rule for the just-in-time join (SSO): somebody invited into the
   * last seat who then arrives through the organisation's single sign-on takes
   * the seat they were promised, and their invitation is revoked as they join.
   */
  it('admits through single sign-on somebody invited into the last seat, and only them', async () => {
    const { orgId, ownerId } = await seedOrg(2);
    await t.pg.query(
      `update organizations set workos_org_id = $2, workos_client_id = 'client_test', jit_join_enabled = true
        where id = $1`,
      [orgId, `org_01T${orgId.replaceAll('-', '').slice(0, 20)}`],
    );
    const invited = await invite(orgId, ownerId);
    const stranger = await seedUser();

    // The one seat left is promised to the invitee: a stranger cannot take it…
    expect(
      await joinOrganizationJustInTime(t.db, { orgId, userId: stranger.id, role: 'viewer' }),
    ).toEqual({ outcome: 'no-seat' });

    // …and the invitee, arriving through SSO instead of the link, can.
    const joined = await joinOrganizationJustInTime(t.db, {
      orgId,
      userId: invited.person.id,
      role: 'viewer',
    });
    expect(joined.outcome).toBe('joined');
    expect(await seatUsage(t.db, orgId, new Date())).toEqual({
      members: 2,
      pendingInvitations: 0,
      seatLimit: 2,
    });
  });

  it('still refuses an acceptance the seats cannot hold — a limit lowered after the invitation', async () => {
    const { orgId, ownerId } = await seedOrg(3);
    const invited = await invite(orgId, ownerId);
    await t.pg.query(`update organizations set seat_limit = 1 where id = $1`, [orgId]);

    await expect(accept(invited.person, invited.token)).rejects.toMatchObject({
      code: 'seatLimit',
    });
    expect((await seatUsage(t.db, orgId, new Date())).members).toBe(1);
  });
});
