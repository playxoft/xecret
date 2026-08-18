/**
 * `curl -fsSL https://xecret.playxoft.com/install.sh | sh`
 *
 * A redirect to the canonical script in the repository, not a copy of it.
 * Serving a second copy from the Worker would create two installers that
 * drift; the `-L` in every documented invocation follows the redirect. The
 * script itself verifies the release checksum before unpacking anything —
 * that, not this URL, is the security boundary of `curl | sh`.
 */

const CANONICAL_INSTALLER =
  'https://raw.githubusercontent.com/playxoft/xecret/main/scripts/install-cli.sh';

export function GET(): Response {
  return Response.redirect(CANONICAL_INSTALLER, 302);
}
