import * as z from 'zod/mini';
import type { User } from '@xecret/db/repositories';

/**
 * The request schema and response shape of the account's own profile.
 *
 * Small, and separate from `resources.ts` because it is a different contract:
 * everything there is addressed by slug inside an organisation, and this is the
 * one record that belongs to a person rather than to a tenant.
 *
 * The same rules as the other schema files: the body is a `strictObject` with a
 * fixed unknown-field message, and the serialiser lists its fields, so a column
 * added to `users` later cannot reach a client by accident.
 */

const UNEXPECTED_FIELD = 'The request contains a field this endpoint does not accept.';
const NON_EMPTY_PATCH = 'Provide at least one field to update.';

/**
 * How long a name may be.
 *
 * `users.display_name` is unconstrained `text`, so this is the only limit there
 * is. Set above the 100 that bounds an organisation name because this one is not
 * only chosen here: it is seeded from whatever Google or Apple holds, and a
 * ceiling that rejected a name somebody already has would make the field
 * unsavable for the accounts least likely to understand why.
 */
export const DISPLAY_NAME_MAX_LENGTH = 120;

/**
 * A name, trimmed, or `null` to go back to being identified by email address.
 *
 * Nullable rather than "send an empty string": clearing a field and leaving it
 * alone have to be different requests, and `''` is neither — it is a name of no
 * characters, which is what the `minLength` below refuses. The distinction is
 * the same one `descriptionSchema` draws in `resources.ts`.
 *
 * Trimmed before the length checks, so " " is an empty name rather than a
 * one-character one, and so a name cannot be padded past the ceiling.
 */
const displayNameSchema = z.nullable(
  z
    .string()
    .check(
      z.trim(),
      z.minLength(1, 'A name cannot be blank. Leave it empty to go back to your email address.'),
      z.maxLength(
        DISPLAY_NAME_MAX_LENGTH,
        `A name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
      ),
    ),
);

/**
 * Changing the account's own profile.
 *
 * Only the display name, deliberately. The email address and the verified flag
 * are the identity provider's and are re-mirrored on every sign-in — accepting
 * them here would be accepting a change this system cannot keep.
 */
export const accountPatchSchema = z
  .strictObject({ displayName: z.optional(displayNameSchema) }, UNEXPECTED_FIELD)
  .check(z.refine((patch) => Object.keys(patch).length > 0, { message: NON_EMPTY_PATCH }));

/** What `GET /api/auth/me` and the profile patch both say about the account. */
export interface AccountProfilePayload {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

/** The columns a client may know about itself, listed rather than spread. */
export function toAccountProfile(user: User): AccountProfilePayload {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}
