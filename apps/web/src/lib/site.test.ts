import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The origin every canonical URL, the sitemap, `robots.txt` and the JSON-LD
 * `@id` are built from — decided once, during `next build`, from two
 * environment variables.
 *
 * That timing is what makes this worth a suite of its own. Nothing downstream
 * can tell a wrong origin from a right one: a staging build that resolves the
 * production host produces pages that look correct, pass every other test, and
 * are wrong only in a search index, weeks later. So the assertions here are
 * about which environment produces which origin, and about the two shapes of
 * misconfiguration that used to resolve to something plausible instead of
 * failing.
 *
 * `SITE_ORIGIN` is a module-scope const, so each case has to stub the
 * environment and then re-import the module — `vi.resetModules()` before the
 * import, or the second case in a file gets the first case's value out of the
 * module cache.
 */

/** The origin under test. Deliberately not this project's real host: a test
 * that hard-codes the production hostname is a test that passes when somebody
 * reintroduces the production fallback this module exists to have removed. */
const EXAMPLE_ORIGIN = 'https://xecret.example.com';

const LOCALHOST = 'http://localhost:3030';

type Env = { XECRET_PUBLIC_URL?: string; XECRET_ENV?: string };

/**
 * Load a fresh copy of the module under a given environment.
 *
 * `vi.stubEnv(name, undefined)` deletes the variable rather than setting it to
 * the string "undefined", which matters because "unset" is a distinct case from
 * every other value here — it is the one that is allowed to fall back.
 */
async function loadSite(env: Env) {
  vi.resetModules();
  vi.stubEnv('XECRET_PUBLIC_URL', env.XECRET_PUBLIC_URL);
  vi.stubEnv('XECRET_ENV', env.XECRET_ENV);
  return import('./site');
}

/** The error a given environment produces, or a failure if it produced none. */
async function failureFrom(env: Env): Promise<string> {
  try {
    await loadSite(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the module to refuse this environment, but it resolved an origin');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('an environment that names its origin', () => {
  it('uses the configured URL', async () => {
    const { SITE_ORIGIN } = await loadSite({
      XECRET_PUBLIC_URL: EXAMPLE_ORIGIN,
      XECRET_ENV: 'production',
    });

    expect(SITE_ORIGIN).toBe(EXAMPLE_ORIGIN);
  });

  // The value is copied out of `wrangler.toml` by a shell script, and a URL
  // written by a human in a config file has a trailing slash about half the
  // time. Left in, every canonical would carry a double slash.
  it('strips trailing slashes, however many', async () => {
    const one = await loadSite({ XECRET_PUBLIC_URL: `${EXAMPLE_ORIGIN}/` });
    expect(one.SITE_ORIGIN).toBe(EXAMPLE_ORIGIN);

    const several = await loadSite({ XECRET_PUBLIC_URL: `${EXAMPLE_ORIGIN}///` });
    expect(several.SITE_ORIGIN).toBe(EXAMPLE_ORIGIN);
  });

  // The URL wins over the environment name. `XECRET_ENV` only ever decides what
  // to do in its absence.
  it('does not consult XECRET_ENV when the URL is present', async () => {
    const production = await loadSite({
      XECRET_PUBLIC_URL: EXAMPLE_ORIGIN,
      XECRET_ENV: 'production',
    });
    const development = await loadSite({
      XECRET_PUBLIC_URL: EXAMPLE_ORIGIN,
      XECRET_ENV: 'development',
    });

    expect(production.SITE_ORIGIN).toBe(EXAMPLE_ORIGIN);
    expect(development.SITE_ORIGIN).toBe(EXAMPLE_ORIGIN);
  });

  // A variable exported as empty is how a shell reports "I have nothing for
  // this", and treating it as a value would make the origin the empty string.
  it('treats a blank or whitespace value as unset', async () => {
    expect((await loadSite({ XECRET_PUBLIC_URL: '' })).SITE_ORIGIN).toBe(LOCALHOST);
    expect((await loadSite({ XECRET_PUBLIC_URL: '   ' })).SITE_ORIGIN).toBe(LOCALHOST);
  });

  it('tolerates the whitespace a shell export leaves behind', async () => {
    const { SITE_ORIGIN } = await loadSite({ XECRET_PUBLIC_URL: `  ${EXAMPLE_ORIGIN}\n` });
    expect(SITE_ORIGIN).toBe(EXAMPLE_ORIGIN);
  });
});

describe('an environment that is not a deployment', () => {
  // `next build` on a laptop, the CI bundle-size build and this test runner all
  // arrive here, and localhost is an honest answer for all three.
  it('falls back to localhost when neither variable is set', async () => {
    const { SITE_ORIGIN } = await loadSite({});
    expect(SITE_ORIGIN).toBe(LOCALHOST);
  });

  it('falls back to localhost for the development environment', async () => {
    const { SITE_ORIGIN } = await loadSite({ XECRET_ENV: 'development' });
    expect(SITE_ORIGIN).toBe(LOCALHOST);
  });
});

/**
 * The regression this module was rewritten for.
 *
 * A deployment build that cannot learn its own origin used to fall back to a
 * hard-coded production host, so staging shipped production canonicals. The
 * replacement is a refusal, and a refusal is only useful if it is unmissable —
 * hence assertions on what the message says, not merely that one was thrown.
 */
describe('a deployment build that cannot name its origin', () => {
  it('refuses rather than guessing', async () => {
    await expect(loadSite({ XECRET_ENV: 'production' })).rejects.toThrow(/XECRET_PUBLIC_URL/);
  });

  it('refuses for any environment that is not development', async () => {
    for (const environment of ['production', 'staging', 'preview', 'Development', 'prod']) {
      const message = await failureFrom({ XECRET_ENV: environment });
      expect(message).toContain(`XECRET_ENV is "${environment}"`);
    }
  });

  // The reader is someone whose deploy just stopped. The message has to say
  // which variable to set and which command sets it for them, or they will
  // reach for the fallback that caused the original bug.
  it('names the variable to set and the command that sets it', async () => {
    const message = await failureFrom({ XECRET_ENV: 'staging' });

    expect(message).toContain('XECRET_PUBLIC_URL is not set');
    expect(message).toContain('scripts/deploy-web.sh');
    expect(message).toContain('wrangler.toml');
  });

  // The same throw fires on import for a developer who merely has XECRET_ENV
  // exported in their shell, where it looks like a broken test runner rather
  // than a configuration problem. The message is what closes that gap.
  it('explains the case where the variable came from a shell, not a deploy', async () => {
    const message = await failureFrom({ XECRET_ENV: 'production' });

    expect(message).toContain('shell');
    expect(message).toContain('XECRET_ENV=development');
  });
});

/**
 * A URL that is set but unusable.
 *
 * Both of these used to survive `buildOrigin()` and die — or worse, not die —
 * at `new URL(SITE_ORIGIN)` one line later, with no mention of which variable
 * was at fault.
 */
describe('a configured origin that is not an origin', () => {
  it('rejects a host with no scheme, naming the variable and the shape', async () => {
    const message = await failureFrom({ XECRET_PUBLIC_URL: 'xecret.example.com' });

    expect(message).toContain('XECRET_PUBLIC_URL');
    expect(message).toContain('xecret.example.com');
    expect(message).toMatch(/https:\/\//);
    // The bare `Invalid URL` this replaced named nothing at all.
    expect(message).not.toBe('Invalid URL');
  });

  /**
   * The dangerous one. `new URL('xecret.example.com:8080')` does not throw — it
   * reads `xecret.example.com:` as the scheme and `8080` as the path, so
   * `SITE_HOST` came out as the empty string and `robots.txt` shipped a `Host:`
   * line with nothing after it. A crawler drops that line silently, which is
   * the exact failure the host directive exists to prevent.
   */
  it('rejects a host:port that URL happily misparses as a scheme', async () => {
    const message = await failureFrom({ XECRET_PUBLIC_URL: 'xecret.example.com:8080' });

    expect(message).toContain('XECRET_PUBLIC_URL');
    expect(message).toContain('http or https');
  });

  it('rejects a scheme that is not http or https', async () => {
    const message = await failureFrom({ XECRET_PUBLIC_URL: 'ftp://xecret.example.com' });
    expect(message).toContain('http or https');
  });
});

describe('SITE_HOST', () => {
  it('is the bare hostname, with no scheme and no trailing slash', async () => {
    const { SITE_HOST } = await loadSite({ XECRET_PUBLIC_URL: `${EXAMPLE_ORIGIN}/` });

    expect(SITE_HOST).toBe('xecret.example.com');
  });

  // `robots.txt`'s Host directive admits a hostname and an optional port, so
  // the port has to survive where the scheme must not.
  it('keeps a port when the origin has one', async () => {
    const { SITE_HOST } = await loadSite({ XECRET_PUBLIC_URL: 'https://xecret.example.com:8443' });
    expect(SITE_HOST).toBe('xecret.example.com:8443');

    const local = await loadSite({});
    expect(local.SITE_HOST).toBe('localhost:3030');
  });

  it('never carries a scheme or a slash into the Host directive', async () => {
    const { SITE_HOST } = await loadSite({ XECRET_PUBLIC_URL: EXAMPLE_ORIGIN });

    expect(SITE_HOST).not.toContain('/');
    expect(SITE_HOST).not.toContain(':/');
    expect(SITE_HOST.startsWith('http')).toBe(false);
  });
});

describe('absoluteUrl', () => {
  it('joins a site-relative path onto the origin', async () => {
    const { absoluteUrl } = await loadSite({ XECRET_PUBLIC_URL: EXAMPLE_ORIGIN });

    expect(absoluteUrl('/docs/cli')).toBe(`${EXAMPLE_ORIGIN}/docs/cli`);
  });

  // Callers build these paths from frontmatter and route segments, so both
  // spellings turn up and neither should produce a double slash or a bare join.
  it('tolerates a path given without its leading slash', async () => {
    const { absoluteUrl } = await loadSite({ XECRET_PUBLIC_URL: EXAMPLE_ORIGIN });

    expect(absoluteUrl('docs/cli')).toBe(`${EXAMPLE_ORIGIN}/docs/cli`);
  });

  it('produces the origin plus a slash for the root path', async () => {
    const { absoluteUrl } = await loadSite({ XECRET_PUBLIC_URL: EXAMPLE_ORIGIN });

    expect(absoluteUrl('/')).toBe(`${EXAMPLE_ORIGIN}/`);
  });
});
