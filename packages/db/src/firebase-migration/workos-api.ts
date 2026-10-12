import { WORKOS_USER_ID_PATTERN } from '@xecret/core/auth';

/**
 * The handful of WorkOS User Management calls the user import needs, over plain
 * `fetch`.
 *
 * Not the `@workos-inc/node` SDK, on purpose: this is a one-off operator tool,
 * the SDK belongs to the application's sign-in path (WS-2), and an SDK added
 * for a script is a dependency the Worker then has to be checked against. The
 * endpoints and field names were verified against https://workos.com/docs
 * (`reference/authkit/user`, `reference/authkit/authentication/password`) on
 * 2026-10-12.
 *
 * ── What never leaves this module ──
 * A request body. Errors carry the HTTP status, WorkOS's error `code`, and its
 * message with every secret this call sent redacted out of it — never the
 * request, and never a URL that contains an address.
 */

export const WORKOS_API_BASE_URL = 'https://api.workos.com';

/** The fields of a WorkOS User this tool reads. */
export interface WorkosUserSummary {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly externalId: string | null;
}

export interface CreateWorkosUserInput {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly externalId?: string;
  /** A PHC string; see `firebaseScryptPhc`. Sent with `password_hash_type: 'firebase-scrypt'`. */
  readonly firebaseScryptHash?: string;
}

export type PasswordAuthResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly status: number; readonly code: string | null };

export class WorkosApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | null,
    detail: string | null,
  ) {
    super(
      `WorkOS ${operation} failed: HTTP ${status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'WorkosApiError';
  }
}

export interface WorkosUsersApiOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Waits between 429 retries. Injected so tests do not sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the part of a WorkOS User object this tool relies on. */
export function parseWorkosUser(value: unknown): WorkosUserSummary {
  if (!isRecord(value)) throw new Error('WorkOS returned a user that is not an object.');
  const { id, email, email_verified: emailVerified, external_id: externalId } = value;
  if (typeof id !== 'string' || !WORKOS_USER_ID_PATTERN.test(id)) {
    throw new Error('WorkOS returned a user without a valid id.');
  }
  if (typeof email !== 'string' || typeof emailVerified !== 'boolean') {
    throw new Error(`WorkOS user ${id} is missing email or email_verified.`);
  }
  if (externalId !== undefined && externalId !== null && typeof externalId !== 'string') {
    throw new Error(`WorkOS user ${id} has a non-string external_id.`);
  }
  return { id, email, emailVerified, externalId: externalId ?? null };
}

/** Replaces each secret in `text`. Longest first, so a secret containing another goes whole. */
export function redact(text: string, secrets: readonly string[]): string {
  return [...secrets]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;

export function createWorkosUsersApi(options: WorkosUsersApiOptions) {
  const baseUrl = options.baseUrl ?? WORKOS_API_BASE_URL;
  const doFetch = options.fetch ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /**
   * One call, retried on 429. Errors are built by {@link failure}, which names
   * a path template rather than the real path (it can hold an address) and
   * scrubs the call's secrets out of whatever WorkOS says back.
   */
  async function call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<{ status: number; json: unknown }> {
    for (let attempt = 0; ; attempt += 1) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      // Every endpoint takes the key as a bearer token except password
      // authentication, which takes it in the body as `client_secret`.
      if (!body || !('client_secret' in body))
        headers['Authorization'] = `Bearer ${options.apiKey}`;
      if (body) headers['Content-Type'] = 'application/json';
      const response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS)
            : 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
        await sleep(wait);
        continue;
      }
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json };
    }
  }

  function failure(operation: string, status: number, json: unknown, secrets: readonly string[]) {
    const record = isRecord(json) ? json : {};
    const code =
      typeof record['code'] === 'string'
        ? record['code']
        : typeof record['error'] === 'string'
          ? record['error']
          : null;
    const rawMessage =
      typeof record['message'] === 'string'
        ? record['message']
        : typeof record['error_description'] === 'string'
          ? record['error_description']
          : null;
    const detail = rawMessage === null ? null : redact(rawMessage, secrets).slice(0, 300);
    return new WorkosApiError(operation, status, code, detail);
  }

  async function getOrNull(operation: string, path: string): Promise<WorkosUserSummary | null> {
    const { status, json } = await call('GET', path, null);
    if (status === 404) return null;
    if (status !== 200) throw failure(operation, status, json, []);
    return parseWorkosUser(json);
  }

  return {
    /** `GET /user_management/users/{id}`; null when there is no such user. */
    getUser(id: string): Promise<WorkosUserSummary | null> {
      return getOrNull(
        'GET /user_management/users/{id}',
        `/user_management/users/${encodeURIComponent(id)}`,
      );
    },

    /** `GET /user_management/users/external_id/{external_id}`; null when nobody holds it. */
    getUserByExternalId(externalId: string): Promise<WorkosUserSummary | null> {
      return getOrNull(
        'GET /user_management/users/external_id/{external_id}',
        `/user_management/users/external_id/${encodeURIComponent(externalId)}`,
      );
    },

    /**
     * `GET /user_management/users?email=…`; null when nobody holds the address.
     *
     * WorkOS keeps addresses unique per environment, so more than one match is
     * not a choice to make here: it is an error.
     */
    async findUserByEmail(email: string): Promise<WorkosUserSummary | null> {
      const operation = 'GET /user_management/users?email={email}';
      const { status, json } = await call(
        'GET',
        `/user_management/users?email=${encodeURIComponent(email)}&limit=2`,
        null,
      );
      if (status !== 200) throw failure(operation, status, json, [email]);
      const data = isRecord(json) ? json['data'] : undefined;
      if (!Array.isArray(data)) throw new Error('WorkOS list users returned no data array.');
      if (data.length > 1) throw new Error('WorkOS returned more than one user for one address.');
      return data.length === 0 ? null : parseWorkosUser(data[0]);
    },

    /** `POST /user_management/users`. */
    async createUser(input: CreateWorkosUserInput): Promise<WorkosUserSummary> {
      const operation = 'POST /user_management/users';
      const body: Record<string, unknown> = {
        email: input.email,
        email_verified: input.emailVerified,
      };
      if (input.firstName !== undefined) body['first_name'] = input.firstName;
      if (input.lastName !== undefined) body['last_name'] = input.lastName;
      if (input.externalId !== undefined) body['external_id'] = input.externalId;
      // The address too: not a secret, but the caller names the user by uid,
      // and an operator's terminal is not where addresses need repeating.
      const secrets: string[] = [input.email];
      if (input.firebaseScryptHash !== undefined) {
        body['password_hash'] = input.firebaseScryptHash;
        body['password_hash_type'] = 'firebase-scrypt';
        // The whole string, and each `$`-separated field of it, so an error
        // that quotes only the hash or only the signer key is scrubbed too.
        secrets.push(input.firebaseScryptHash, ...input.firebaseScryptHash.split(/[$,=]/));
      }
      const { status, json } = await call('POST', '/user_management/users', body);
      if (status !== 200 && status !== 201) throw failure(operation, status, json, secrets);
      return parseWorkosUser(json);
    },

    /** `DELETE /user_management/users/{id}`. Deleting a user that is already gone is fine. */
    async deleteUser(id: string): Promise<void> {
      const operation = 'DELETE /user_management/users/{id}';
      const { status, json } = await call(
        'DELETE',
        `/user_management/users/${encodeURIComponent(id)}`,
        null,
      );
      if (status !== 200 && status !== 202 && status !== 204 && status !== 404) {
        throw failure(operation, status, json, []);
      }
    },

    /**
     * Whether the API key and `clientId` belong to the same WorkOS environment.
     *
     * A WorkOS key does not say which environment it is for — the current
     * format is `sk_` and base64 of `key_<id>,<secret>` — but the authenticate
     * endpoint does tell a key and a client from different environments apart.
     * This sends a code that cannot be valid: a matching pair is refused for the
     * code (`invalid_grant`), a mismatched one for the client
     * (`invalid_client`). Nothing is created. Observed 2026-10-12 against both
     * xecret environments in every pairing.
     */
    async checkClientPairing(
      clientId: string,
    ): Promise<'same-environment' | 'different-environment'> {
      const operation = 'POST /user_management/authenticate (environment check)';
      const { status, json } = await call('POST', '/user_management/authenticate', {
        client_id: clientId,
        client_secret: options.apiKey,
        grant_type: 'authorization_code',
        code: 'xecret-migration-environment-check',
      });
      const error = failure(operation, status, json, [options.apiKey]);
      if (status === 400 && error.code === 'invalid_grant') return 'same-environment';
      if ((status === 400 || status === 401) && error.code === 'invalid_client') {
        return 'different-environment';
      }
      throw error;
    },

    /**
     * `POST /user_management/authenticate` with `grant_type: 'password'`.
     *
     * A refusal is a result, not an exception: the self-test expects one. Only
     * a response that is neither a success nor a client error throws.
     */
    async authenticateWithPassword(args: {
      clientId: string;
      email: string;
      password: string;
    }): Promise<PasswordAuthResult> {
      const operation = 'POST /user_management/authenticate (password)';
      const { status, json } = await call('POST', '/user_management/authenticate', {
        client_id: args.clientId,
        client_secret: options.apiKey,
        grant_type: 'password',
        email: args.email,
        password: args.password,
      });
      if (status === 200) {
        const user = isRecord(json) ? json['user'] : undefined;
        return { ok: true, userId: parseWorkosUser(user).id };
      }
      if (status >= 400 && status < 500) {
        const error = failure(operation, status, json, [args.password, options.apiKey]);
        return { ok: false, status, code: error.code };
      }
      throw failure(operation, status, json, [args.password, options.apiKey]);
    },
  };
}

export type WorkosUsersApi = ReturnType<typeof createWorkosUsersApi>;
