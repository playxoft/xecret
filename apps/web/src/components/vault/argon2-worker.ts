import { nobleArgon2idProvider } from '@xecret/core/crypto/client';
import type { Argon2idParams, Bytes } from '@xecret/core/crypto/client';

/**
 * Argon2id, off the main thread.
 *
 * ── Why this file exists ──
 * At the production parameters (64 MiB, t=3) pure-JS Argon2id costs the better
 * part of a second. On the main thread that is not a slow spinner, it is a
 * frozen one: the event loop does not turn, so the "Securing your vault…" state
 * paints once and then stops animating, and nothing the user clicks is
 * acknowledged until the derivation finishes. Here it is a promise that resolves
 * while the page keeps running.
 *
 * ── One worker per derivation ──
 * The caller in `argon2.ts` constructs a worker, sends one message, and
 * terminates it. That is not an oversight about pooling. Derivations happen at
 * setup, at unlock, at a passphrase change and at a recovery — four moments in a
 * session, not a hot path — and a worker that dies immediately is a worker whose
 * copy of the passphrase bytes dies with it, which a pooled one would not be.
 * There is no request id below for the same reason: there is only ever one.
 *
 * The password is *copied* into this worker by structured clone rather than
 * transferred. Transferring would detach the caller's buffer, and
 * `deriveStretchedKey` wipes that buffer in a `finally` — `fill` on a detached
 * array throws, which would turn a successful derivation into an exception.
 */

interface DeriveRequest {
  password: Bytes;
  salt: Bytes;
  params: Argon2idParams;
}

export type DeriveResponse =
  | { ok: true; key: Bytes }
  | { ok: false; message: string }
  // Sent unprompted the moment this module has evaluated. The caller waits for
  // it before posting work, so that a worker which fails to load — a chunk that
  // 404s behind a stale deployment, a CSP that refuses it — is discovered as a
  // silent worker rather than as a derivation that never resolves.
  | { ok: 'ready' };

/**
 * The two globals this file needs from `DedicatedWorkerGlobalScope`, declared
 * locally.
 *
 * The alternative is adding `"webworker"` to `lib` in `tsconfig.json`, which
 * cannot be scoped to one file and which collides with `"dom"` on dozens of
 * shared names. Two lines of structural typing buys the same safety without
 * changing what every other module in the application is compiled against.
 */
const scope = self as unknown as {
  postMessage: (message: DeriveResponse) => void;
  addEventListener: (type: 'message', listener: (event: { data: DeriveRequest }) => void) => void;
};

scope.addEventListener('message', (event) => {
  const { password, salt, params } = event.data;

  nobleArgon2idProvider(password, salt, params).then(
    (key) => {
      password.fill(0);
      scope.postMessage({ ok: true, key });
    },
    (cause: unknown) => {
      password.fill(0);
      // The message is the *class* of failure, never a value. `parseKdfParams`
      // and the noble implementation both throw with parameter detail in them,
      // which is safe, but nothing here inspects which — a worker that decided
      // what was quotable would be one more place to get that judgement wrong.
      scope.postMessage({
        ok: false,
        message: cause instanceof Error ? cause.name : 'Argon2idFailure',
      });
    },
  );
});

scope.postMessage({ ok: 'ready' });
