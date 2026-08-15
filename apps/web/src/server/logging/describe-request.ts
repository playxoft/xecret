/**
 * Turning a request into a sentence.
 *
 * ── Why the message is prose and not a label ──
 * `request completed` is a label. It tells a reader nothing they could not get
 * from `method` and `status`, and it makes every line in the stream look
 * identical until you expand it. What an operator scanning a log actually needs
 * is the *action*: "Revealed the secret DATABASE_URL in acme/api/production" is
 * a fact about the system; "request completed" is a fact about the framework.
 *
 * So each route maps to a verb and an object, and the completion line reads as
 * a sentence in the tense the outcome deserves:
 *
 *   200 → Revealed the secret DATABASE_URL in acme/api/production
 *   403 → Refused to reveal the secret DATABASE_URL in acme/api/production
 *   500 → Failed to reveal the secret DATABASE_URL in acme/api/production
 *
 * ── `event` is what dashboards group on ──
 * Prose is for humans and changes when somebody improves the wording. A panel
 * counting "secret reveals per hour" must not break because a sentence was
 * rephrased, so every line also carries a stable `event` key — `secret.reveal`
 * — and that is what queries, alerts and grouping use. The two have different
 * jobs and neither can do the other's.
 *
 * ── The mapping lives here, not in the handlers ──
 * A handler that had to declare its own description would be a handler that can
 * forget to, and the first one that forgot would emit `request completed`
 * again. Deriving it from the method and the path means every route — including
 * one added tomorrow — produces something, and the fallback still names the
 * method and the path rather than saying nothing.
 */

/** A path segment that lands in a message is attacker-controlled; bound it. */
const MAX_SEGMENT = 64;

export interface RequestAction {
  /**
   * Stable grouping key, e.g. `secret.reveal`.
   *
   * Mirrors the audit log's action names where an equivalent exists, so
   * "what the API was asked to do" and "what was recorded" line up.
   */
  event: string;
  /** Past tense, capitalised — starts a success sentence. "Revealed". */
  past: string;
  /** Bare infinitive, lowercase — follows "Refused to" / "Failed to". "reveal". */
  base: string;
  /** What was acted on. "the secret DATABASE_URL in acme/api/production". */
  object: string;
}

function action(event: string, past: string, base: string, object: string): RequestAction {
  return { event, past, base, object };
}

/** One path segment, decoded and bounded. */
function segment(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape is somebody probing, not a caller. Keep the raw form
    // so the line still shows what was sent.
    decoded = raw;
  }
  return decoded.length > MAX_SEGMENT ? `${decoded.slice(0, MAX_SEGMENT)}…` : decoded;
}

/** "acme/api/production", omitting the levels the path did not reach. */
function scopeOf(parts: readonly (string | undefined)[]): string {
  const named = parts.filter((part): part is string => part !== undefined && part !== '');
  return named.join('/');
}

function inScope(what: string, parts: readonly (string | undefined)[]): string {
  const scope = scopeOf(parts);
  return scope === '' ? what : `${what} in ${scope}`;
}

/**
 * Describes what a request was asking for.
 *
 * Pure, and driven only by the method and the path — no database, no principal.
 * That is what lets the route wrapper call it before authentication has run, so
 * a request rejected at the door still says what it was rejected from doing.
 */
export function describeRequest(method: string, path: string): RequestAction {
  const verb = method.toUpperCase();
  const parts = path
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(segment);

  const [head, ...rest] = parts;

  switch (head) {
    case 'auth':
      return describeAuth(verb, rest);
    case 'cli':
      return describeCli(verb, rest);
    case 'invitations':
      return describeInvitationExchange(verb, rest);
    case 'tokens':
      return verb === 'DELETE'
        ? action('token.revoke_self', 'Revoked', 'revoke', 'the calling token itself')
        : action('token.read_self', 'Described', 'describe', 'the calling token itself');
    case 'orgs':
      return describeOrgs(verb, rest);
    default:
      return unknown(verb, path);
  }
}

function unknown(verb: string, path: string): RequestAction {
  // Still a sentence, and still names the thing. A route with no entry above is
  // a gap in this file, not a reason to fall back to "request completed".
  return action('http.request', 'Served', 'serve', `${verb} ${segment(path)}`);
}

function describeAuth(verb: string, rest: readonly string[]): RequestAction {
  const [first, second] = rest;

  if (first === 'session') {
    return verb === 'DELETE'
      ? action('auth.logout', 'Signed', 'sign', 'the user out and revoked their session')
      : action('auth.login', 'Signed', 'sign', 'the user in and issued a new session');
  }

  if (first === 'sessions') {
    return action('auth.sessions', 'Listed', 'list', "the user's active sessions and devices");
  }

  if (first === 'me') {
    return action('auth.me', 'Read', 'read', "the signed-in user's profile and memberships");
  }

  if (first === 'account') {
    return verb === 'DELETE'
      ? action('account.delete', 'Deleted', 'delete', "the signed-in user's account")
      : action('account.update', 'Updated', 'update', "the signed-in user's profile");
  }

  if (first === 'pin') {
    switch (second) {
      case 'unlock':
        return action('auth.pin_unlock', 'Unlocked', 'unlock', 'the session with the account PIN');
      case 'lock':
        return action('auth.pin_lock', 'Locked', 'lock', 'the session');
      case 'reset':
        return rest[2] === 'confirm'
          ? action('auth.pin_reset_confirm', 'Set', 'set', 'a new PIN from a reset link')
          : action('auth.pin_reset', 'Sent', 'send', "a PIN reset link to the account's address");
      default:
        return action('auth.pin_set', 'Set', 'set', "the account's unlock PIN");
    }
  }

  return unknown(verb, `/api/auth/${rest.join('/')}`);
}

function describeCli(verb: string, rest: readonly string[]): RequestAction {
  if (rest[0] === 'authorize') {
    return action('cli.authorize', 'Authorised', 'authorise', 'a CLI device from the browser');
  }
  if (rest[0] === 'token') {
    return action('cli.token', 'Exchanged', 'exchange', 'a CLI authorisation code for a token');
  }
  return unknown(verb, `/api/cli/${rest.join('/')}`);
}

function describeInvitationExchange(verb: string, rest: readonly string[]): RequestAction {
  if (rest[0] === 'accept') {
    return action(
      'invitation.accept',
      'Accepted',
      'accept',
      'an invitation and joined its organisation',
    );
  }
  if (rest[0] === 'lookup') {
    return action('invitation.lookup', 'Looked', 'look', 'up an invitation by its token');
  }
  return unknown(verb, `/api/invitations/${rest.join('/')}`);
}

function describeOrgs(verb: string, rest: readonly string[]): RequestAction {
  const [org, section] = rest;

  if (org === undefined) {
    return verb === 'POST'
      ? action('org.create', 'Created', 'create', 'a new organisation')
      : action('org.list', 'Listed', 'list', "the user's organisations");
  }

  if (section === undefined) {
    switch (verb) {
      case 'PATCH':
      case 'PUT':
        return action('org.update', 'Updated', 'update', `the organisation ${org}`);
      case 'DELETE':
        return action('org.delete', 'Deleted', 'delete', `the organisation ${org}`);
      default:
        return action('org.read', 'Read', 'read', `the organisation ${org}`);
    }
  }

  switch (section) {
    case 'audit':
      return action('audit.read', 'Read', 'read', `the audit log for ${org}`);
    case 'members':
      return describeMembers(verb, org, rest.slice(2));
    case 'invitations':
      return describeInvitations(verb, org, rest.slice(2));
    case 'tokens':
      return describeTokens(verb, org, rest.slice(2));
    case 'projects':
      return describeProjects(verb, org, rest.slice(2));
    default:
      return unknown(verb, `/api/orgs/${rest.join('/')}`);
  }
}

function describeMembers(verb: string, org: string, rest: readonly string[]): RequestAction {
  const [member, sub] = rest;

  if (member === undefined) {
    return verb === 'POST'
      ? action('member.invite', 'Invited', 'invite', `a new member to ${org}`)
      : action('member.list', 'Listed', 'list', `the members of ${org}`);
  }

  if (sub === 'access') {
    return action(
      'member.access_read',
      'Read',
      'read',
      `one member's environment access in ${org}`,
    );
  }
  if (sub === 'grants') {
    return action(
      'member.grants_write',
      'Changed',
      'change',
      `one member's environment grants in ${org}`,
    );
  }

  switch (verb) {
    case 'PATCH':
    case 'PUT':
      return action('member.update', 'Changed', 'change', `one member's role in ${org}`);
    case 'DELETE':
      return action('member.remove', 'Removed', 'remove', `a member from ${org}`);
    default:
      return action('member.read', 'Read', 'read', `one member of ${org}`);
  }
}

function describeInvitations(verb: string, org: string, rest: readonly string[]): RequestAction {
  if (rest.length === 0) {
    return verb === 'POST'
      ? action('invitation.create', 'Invited', 'invite', `a new member to ${org}`)
      : action('invitation.list', 'Listed', 'list', `the pending invitations for ${org}`);
  }
  return action('invitation.revoke', 'Revoked', 'revoke', `a pending invitation to ${org}`);
}

function describeTokens(verb: string, org: string, rest: readonly string[]): RequestAction {
  const [kind, tokenId] = rest;

  if (tokenId !== undefined) {
    return kind === 'cli'
      ? action('token.revoke_cli', 'Signed', 'sign', `a CLI device out of ${org}`)
      : action('token.revoke_service', 'Revoked', 'revoke', `a service token in ${org}`);
  }

  if (kind === 'service') {
    return verb === 'POST'
      ? action('token.mint_service', 'Minted', 'mint', `a new service token for ${org}`)
      : action('token.list_service', 'Listed', 'list', `the service tokens in ${org}`);
  }

  return action('token.list_cli', 'Listed', 'list', `the CLI devices signed in to ${org}`);
}

function describeProjects(verb: string, org: string, rest: readonly string[]): RequestAction {
  const [project, section] = rest;

  if (project === undefined) {
    return verb === 'POST'
      ? action('project.create', 'Created', 'create', `a new project in ${org}`)
      : action('project.list', 'Listed', 'list', `the projects in ${org}`);
  }

  if (section === undefined) {
    switch (verb) {
      case 'PATCH':
      case 'PUT':
        return action('project.update', 'Updated', 'update', `the project ${org}/${project}`);
      case 'DELETE':
        return action('project.delete', 'Deleted', 'delete', `the project ${org}/${project}`);
      default:
        return action('project.read', 'Read', 'read', `the project ${org}/${project}`);
    }
  }

  if (section !== 'environments') {
    return unknown(verb, `/api/orgs/${org}/projects/${rest.join('/')}`);
  }

  return describeEnvironments(verb, org, project, rest.slice(2));
}

function describeEnvironments(
  verb: string,
  org: string,
  project: string,
  rest: readonly string[],
): RequestAction {
  const [env, section] = rest;

  if (env === undefined) {
    return verb === 'POST'
      ? action('environment.create', 'Created', 'create', `a new environment in ${org}/${project}`)
      : action('environment.list', 'Listed', 'list', `the environments in ${org}/${project}`);
  }

  const scope = scopeOf([org, project, env]);

  if (section === undefined) {
    switch (verb) {
      case 'PATCH':
      case 'PUT':
        return action('environment.update', 'Updated', 'update', `the environment ${scope}`);
      case 'DELETE':
        return action('environment.delete', 'Deleted', 'delete', `the environment ${scope}`);
      default:
        return action('environment.read', 'Read', 'read', `the environment ${scope}`);
    }
  }

  switch (section) {
    case 'pull':
      // The single most sensitive read in the product: one request, every
      // plaintext in the environment. It should be unmistakable in a log.
      return action('secret.pull', 'Decrypted', 'decrypt', `every secret in ${scope}`);
    case 'export':
      return action(
        'secret.export',
        'Exported',
        'export',
        `every secret in ${scope} as a document`,
      );
    case 'import':
      return action('secret.import', 'Imported', 'import', `a document of secrets into ${scope}`);
    case 'secrets':
      return describeSecrets(verb, scope, rest.slice(2));
    default:
      return unknown(verb, `/api/orgs/${org}/projects/${project}/environments/${rest.join('/')}`);
  }
}

function describeSecrets(verb: string, scope: string, rest: readonly string[]): RequestAction {
  const [name, section, version] = rest;

  if (name === undefined) {
    return verb === 'POST'
      ? action('secret.create', 'Wrote', 'write', inScope('a new secret', [scope]))
      : action('secret.list', 'Listed', 'list', inScope('the secrets', [scope]));
  }

  if (section === 'restore') {
    return action(
      'secret.restore',
      'Restored',
      'restore',
      `the secret ${name} in ${scope} to an earlier version`,
    );
  }

  if (section === 'versions') {
    return version === undefined
      ? action(
          'secret.version_list',
          'Listed',
          'list',
          `the version history of the secret ${name} in ${scope}`,
        )
      : action(
          'secret.version_reveal',
          'Revealed',
          'reveal',
          `version ${version} of the secret ${name} in ${scope}`,
        );
  }

  switch (verb) {
    case 'PUT':
    case 'POST':
    case 'PATCH':
      return action(
        'secret.write',
        'Wrote',
        'write',
        `a new version of the secret ${name} in ${scope}`,
      );
    case 'DELETE':
      return action('secret.delete', 'Deleted', 'delete', `the secret ${name} from ${scope}`);
    default:
      return action('secret.reveal', 'Revealed', 'reveal', `the secret ${name} in ${scope}`);
  }
}

/**
 * The completion sentence for an outcome.
 *
 * Three forms rather than one, because "Refused to delete the secret" and
 * "Failed to delete the secret" are different incidents and a reader should not
 * have to check a status code to tell them apart. 401/403/404 are a refusal —
 * the system worked. Other 4xx are a rejection — the request was malformed.
 * 5xx is a failure — something is broken.
 */
export function describeOutcome(request: RequestAction, status: number): string {
  if (status >= 500) return `Failed to ${request.base} ${request.object}`;
  if (status === 401 || status === 403 || status === 404) {
    return `Refused to ${request.base} ${request.object}`;
  }
  if (status >= 400) return `Rejected a request to ${request.base} ${request.object}`;
  return `${request.past} ${request.object}`;
}
