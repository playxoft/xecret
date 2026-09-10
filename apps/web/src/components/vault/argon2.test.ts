import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  argon2idProvider,
  argon2WorkersUnavailable,
  setArgon2WorkerFactory,
  WORKER_DERIVE_TIMEOUT_MS,
  WORKER_READY_TIMEOUT_MS,
} from './argon2';
import type { Argon2WorkerFactory } from './argon2';

/**
 * What `argon2.ts` decides, tested without a bundler.
 *
 * ── Why this file exists ──
 * The module had no tests at all, and the reason was structural rather than
 * neglect: `new Worker(new URL('./argon2-worker.ts', import.meta.url))` is a
 * bundler instruction, and under Vitest there is no bundler to emit the chunk.
 * The construction throws, the provider falls back to `@noble/hashes`, and every
 * decision in the file goes unobserved — which meant the untested surface was
 * not "worker plumbing" but *when the vault gives up on a worker, whether it
 * remembers, and which failures are the worker's fault rather than the
 * infrastructure's*. A wrong answer to the last one turns a rejected parameter
 * set into a silent fallback that derives a different key.
 *
 * So the construction is a named seam and everything above it is exercised
 * against a fake worker. Nothing here instantiates a real one, and nothing here
 * pretends to: the assertion is about the decision, and the decision is the part
 * that has consequences.
 *
 * ── Why Argon2id runs for real on the fallback path ──
 * Because "falls back" is only meaningful if the fallback produces a usable key.
 * The parameters are the smallest the implementation accepts, so the honest test
 * costs milliseconds rather than the second a real unlock spends.
 */

const PASSWORD = new TextEncoder().encode('correct horse battery staple');
const SALT = new Uint8Array(16).fill(7);

/**
 * Below the OWASP floor `deriveStretchedKey` enforces, and deliberately.
 *
 * The raw provider accepts what it is given — the floor is checked one level up,
 * where a passphrase is involved — and what is under test here is which provider
 * runs, not whether the parameters are strong enough. The production set costs
 * about a second per derivation in pure JavaScript, and this file falls back to
 * the real implementation five times.
 */
const PARAMS = { alg: 'argon2id', v: 19, m: 8192, t: 1, p: 1, len: 32 } as const;

/** A worker that never existed: construction itself throws. */
const unconstructable: Argon2WorkerFactory = () => {
  throw new Error('no bundler emitted the chunk');
};

/**
 * A fake worker driven by a script.
 *
 * `messages` are delivered to the `message` listener as soon as it is attached
 * (a real worker's `ready` arrives asynchronously, so `queueMicrotask` matches
 * the ordering rather than beating it). `errorAfterAttach` fires the `error`
 * listener instead. `silent` attaches nothing, which is what a chunk that never
 * loads looks like from here.
 */
function scriptedWorker(script: { messages?: unknown[]; error?: boolean; silent?: boolean }): {
  factory: Argon2WorkerFactory;
  terminated: () => number;
  posted: () => unknown[];
} {
  let terminations = 0;
  const posts: unknown[] = [];

  const factory: Argon2WorkerFactory = () => {
    const listeners = new Map<string, ((event: unknown) => void)[]>();

    const worker = {
      addEventListener(type: string, listener: (event: unknown) => void) {
        const bucket = listeners.get(type) ?? [];
        bucket.push(listener);
        listeners.set(type, bucket);

        if (script.silent === true) return;

        queueMicrotask(() => {
          if (type === 'error' && script.error === true) {
            listener({});
            return;
          }
          if (type !== 'message') return;
          for (const message of script.messages ?? []) listener({ data: message });
        });
      },
      postMessage(value: unknown) {
        posts.push(value);
      },
      terminate() {
        terminations += 1;
      },
    };

    return worker as unknown as Worker;
  };

  return { factory, terminated: () => terminations, posted: () => posts };
}

afterEach(() => {
  setArgon2WorkerFactory(null);
  vi.useRealTimers();
});

describe('provider selection', () => {
  it('derives on this thread when a worker cannot be constructed', async () => {
    setArgon2WorkerFactory(unconstructable);

    const key = await argon2idProvider(PASSWORD, SALT, PARAMS);

    expect(key).toHaveLength(32);
    // Not all zeroes: a provider that "succeeded" without deriving anything is
    // the one failure this whole module could hide, because AES-GCM under a
    // zero key does not complain.
    expect(key.some((byte) => byte !== 0)).toBe(true);
  });

  it('returns the worker’s key when the worker answers', async () => {
    const answer = new Uint8Array(32).fill(9);
    const scripted = scriptedWorker({ messages: [{ ok: 'ready' }, { ok: true, key: answer }] });
    setArgon2WorkerFactory(scripted.factory);

    const key = await argon2idProvider(PASSWORD, SALT, PARAMS);

    expect([...key]).toEqual([...answer]);
    // The password bytes were handed across, and the worker was torn down: it
    // holds a copy of them, and terminating is the only thing that reliably
    // disposes of it.
    expect(scripted.posted()).toHaveLength(1);
    expect(scripted.terminated()).toBe(1);
  });

  it('rethrows a failure the worker reported about itself', async () => {
    // The distinction that matters. An infrastructural failure is answered by
    // deriving here; a *rejection* is the implementation refusing the input, and
    // this thread would refuse it identically. Falling back on one of those would
    // turn "these parameters are wrong" into a silent second attempt.
    const scripted = scriptedWorker({
      messages: [{ ok: 'ready' }, { ok: false, message: 'memoryKiB out of range' }],
    });
    setArgon2WorkerFactory(scripted.factory);

    await expect(argon2idProvider(PASSWORD, SALT, PARAMS)).rejects.toThrow(/memoryKiB/);
    expect(scripted.terminated()).toBe(1);
    // And it is not written off: the worker did its job, which was to say no.
    expect(argon2WorkersUnavailable()).toBe(false);
  });

  it('falls back when a worker errors after announcing itself', async () => {
    const scripted = scriptedWorker({ error: true });
    setArgon2WorkerFactory(scripted.factory);

    const key = await argon2idProvider(PASSWORD, SALT, PARAMS);

    expect(key).toHaveLength(32);
    expect(scripted.terminated()).toBe(1);
    expect(argon2WorkersUnavailable()).toBe(true);
  });
});

describe('the timeouts', () => {
  it('gives up on a worker that never says ready, and derives here instead', async () => {
    vi.useFakeTimers();
    const scripted = scriptedWorker({ silent: true });
    setArgon2WorkerFactory(scripted.factory);

    const pending = argon2idProvider(PASSWORD, SALT, PARAMS);
    await vi.advanceTimersByTimeAsync(WORKER_READY_TIMEOUT_MS);
    vi.useRealTimers();

    const key = await pending;
    expect(key).toHaveLength(32);
    expect(scripted.terminated()).toBe(1);
  });

  it('gives up on a worker that says ready and then never answers', async () => {
    vi.useFakeTimers();
    const scripted = scriptedWorker({ messages: [{ ok: 'ready' }] });
    setArgon2WorkerFactory(scripted.factory);

    const pending = argon2idProvider(PASSWORD, SALT, PARAMS);

    // Past the *ready* deadline and nothing happens: announcing itself moved the
    // worker onto the long clock, which is the whole reason there are two.
    await vi.advanceTimersByTimeAsync(WORKER_READY_TIMEOUT_MS + 1);
    expect(scripted.terminated()).toBe(0);

    await vi.advanceTimersByTimeAsync(WORKER_DERIVE_TIMEOUT_MS);
    vi.useRealTimers();

    const key = await pending;
    expect(key).toHaveLength(32);
    expect(scripted.terminated()).toBe(1);
  });
});

describe('the sticky failure', () => {
  it('stops constructing workers once one has failed', async () => {
    let constructions = 0;
    setArgon2WorkerFactory(() => {
      constructions += 1;
      throw new Error('no bundler emitted the chunk');
    });

    await argon2idProvider(PASSWORD, SALT, PARAMS);
    await argon2idProvider(PASSWORD, SALT, PARAMS);
    await argon2idProvider(PASSWORD, SALT, PARAMS);

    // Once. If the chunk could not be fetched the first time it will not be
    // fetchable on the next unlock either, and paying the ready timeout before
    // every derivation would add three seconds to each of them.
    expect(constructions).toBe(1);
    expect(argon2WorkersUnavailable()).toBe(true);
  });
});
