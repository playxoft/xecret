/**
 * `curl -fsSL https://xecret.playxoft.com/skill.sh | sh`
 *
 * A redirect to the canonical script in the repository, not a copy of it —
 * the same arrangement as `/install.sh`, for the same reason: serving a second
 * copy from the Worker would create two installers that drift, and every
 * documented invocation carries `-L`.
 *
 * The script this points at downloads `/skill.md`, which is the actual
 * document and is served straight from `public/`. There is one copy of the
 * skill, and this route does not hold it.
 */

const CANONICAL_INSTALLER =
  'https://raw.githubusercontent.com/playxoft/xecret/main/scripts/install-skill.sh';

export function GET(): Response {
  return Response.redirect(CANONICAL_INSTALLER, 302);
}
