import { isProductionDeployment } from '@/server/bindings';
import { errors } from '@/server/errors';
import { json } from '@/server/http';
import { mailerFrom } from '@/server/mail';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';
import { ARCHIVE_EMAIL_MAX_BYTES, surveyVaultArchive } from '@/server/vault-archive-service';
import { requireUserPrincipal } from '@/server/vault-service';

/**
 * What a vault reset would do with the escape archive, asked before anybody
 * confirms (P23, owner decision in round 1 of PR #121): whether the archive can
 * be emailed, and if not, why.
 *
 *  - `resettable: false` — this production deployment cannot send mail, and a
 *    vault is never reset without its archive for a reason the person did not
 *    choose. The reset screen says so and offers nothing to confirm.
 *  - `archive.deliverable: false` — the archive is too large to email, or
 *    (outside production) there is no mail. The reset screen says so before
 *    the person signs in again, and the reset goes ahead only with the box
 *    "Reset without the emailed archive" ticked.
 *
 * Sized in SQL from the same rows the archive would hold, without loading a
 * ciphertext (`surveyVaultArchive`); the estimate is an upper bound.
 *
 * `allowLocked`, like the reset: everybody who needs it is locked out. It
 * reveals counts and a size of the caller's own vault — nothing secret, and
 * nothing a stolen session could not read off the reset screen. Rate limited
 * on its own `RL_LOGIN` key, because each call runs the survey's queries.
 */
export const GET = authenticatedRoute(
  async ({ principal, services }) => {
    const user = requireUserPrincipal(principal);
    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['vault_reset_preflight', user.user.id]));

    const mailer = mailerFrom(services.env);
    const survey = await surveyVaultArchive(services.db, user.user.id, {
      mailConfigured: mailer !== null,
    });
    if (survey === null) throw errors.notFound('no vault to reset');

    return json({
      resettable: mailer !== null || !isProductionDeployment(services.env),
      archive: {
        deliverable: survey.undeliverable === null,
        reason: survey.undeliverable,
        estimatedBytes: survey.estimatedBytes,
        maxBytes: ARCHIVE_EMAIL_MAX_BYTES,
        environmentCount: survey.environments.length,
        secretCount: survey.secretCount,
      },
    });
  },
  { allowLocked: true },
);
