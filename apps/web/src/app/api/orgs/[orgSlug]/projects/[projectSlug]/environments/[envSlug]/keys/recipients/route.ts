import { json } from '@/server/http';
import { authenticatedRoute } from '@/server/route';
import { sealingRecipients } from '@/server/env-keys-service';
import { resolveEnvironmentPath } from '@/server/tenancy';

/**
 * Who this environment's key may be sealed to, and who already holds it.
 *
 * ── Why a read endpoint belongs in a write-only corner of the API ──
 * Every other route under `…/keys` *consumes* a grant set. None of them could
 * produce one, and a browser cannot invent what it needs to: a grant for
 * somebody is built from **their** X25519 public key, and there was no way to
 * learn one. Rotation, the queued key shares and an admin widening access were
 * therefore not merely awkward from a client — they were impossible to attempt.
 * This is the missing half.
 *
 * ── What it discloses ──
 * Public keys, to a caller who already holds `secret.read` on the environment.
 * Both columns behind them (`user_keys.enc_public_key`,
 * `service_tokens.public_key`) are stored in the clear because they are public,
 * and a public key lets its holder *give* a key away, never take one.
 *
 * The gate is `secret.read` rather than `environment.update`, matching `POST
 * …/keys/grants` exactly: this returns precisely the set of principals that
 * endpoint will accept a grant for, and a directory gated more tightly than the
 * write it feeds would leave every queued share unfulfillable by the people who
 * actually hold the key. That is not a hypothetical — the queue exists because
 * whoever *changed* the access usually does not hold it.
 *
 * ── Not audited ──
 * §7 audits mutations, decryptions and denials. This is none of the three: it
 * produces no plaintext and changes nothing, and the acts it enables —
 * `envkey.granted`, `envkey.rotated` — are each recorded where they happen. The
 * denial path is still recorded, because `authorize` throws and the route
 * wrapper flushes it.
 */

interface Params {
  orgSlug: string;
  projectSlug: string;
  envSlug: string;
}

export const GET = authenticatedRoute<Params>(async ({ params, principal, services }) => {
  const scope = await resolveEnvironmentPath(principal, params, services);
  return json(await sealingRecipients(scope, services, principal));
});
