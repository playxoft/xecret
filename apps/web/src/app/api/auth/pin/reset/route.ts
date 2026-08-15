import { generateToken } from '@xecret/core/auth';
import { createPinReset } from '@xecret/db/repositories';
import { publicOrigin } from '@/server/bindings';
import { mailerFrom } from '@/server/mail';
import { pinResetMail } from '@/server/pin-reset-mail';
import { json } from '@/server/http';
import { errorName } from '@/server/logging';
import { primaryOrgId, requireUserPrincipal } from '@/server/pin-service';
import { enforce, rateLimitKey } from '@/server/rate-limit';
import { authenticatedRoute } from '@/server/route';

/**
 * "I forgot my PIN" — sends a reset link to the account's own address.
 *
 * ── Why this requires a session ──
 * It does not accept an email address, and that removes the whole category of
 * problem a public "forgot" endpoint has: there is no account enumeration
 * oracle, no way to send unsolicited mail to a stranger, and no need for the
 * usual "we have sent a link if that address exists" evasion. The person asking
 * is already signed in — they are locked, not signed out — so the address is
 * already known and already theirs.
 *
 * The link therefore proves one thing, which is exactly the thing needed:
 * control of the mailbox. Combined with the session cookie the requester
 * already holds, that is two independent factors to replace a PIN.
 *
 * ── The mail is sent after the response ──
 * `waitUntil`, not `await`. A Worker gets six outgoing connections and the
 * database has one; making the user watch a spinner while Zoho's API is slow
 * buys nothing, since the answer is the same either way.
 */

export const POST = authenticatedRoute(
  async ({ principal, services, audit, record }) => {
    const user = requireUserPrincipal(principal);

    // ── Keyed on the user alone, in a counter of its own ──
    // The address is deliberately absent from the key. `attemptKey(ip, user)`,
    // which the rest of the login-adjacent routes use, gives every source
    // address its own counter — so somebody holding a stolen session cookie and
    // a pool of proxies could send an unbounded amount of mail to the account's
    // address from our verified sending domain. What a mailbox needs bounded is
    // mail arriving at *it*, which is the user, whoever is asking and from
    // wherever. Since any traffic that would trip an ip+user counter also trips
    // this one, keeping both would add no cover — only the cross-talk below.
    //
    // The `pin_reset` prefix is a distinct counter on the same binding, and it
    // is what makes a forgotten PIN recoverable. Sharing the login counter meant
    // six or seven failed unlock attempts could spend the allowance this
    // endpoint and `/pin/reset/confirm` still need, and the 429 that followed
    // read as though the emailed link itself had failed — during the fifteen
    // minutes the link is alive, with nothing on screen suggesting waiting.
    await enforce(services.env, 'RL_LOGIN', rateLimitKey(['pin_reset', user.user.id]));

    const mailer = mailerFrom(services.env);
    if (mailer === null) {
      // Stated plainly rather than pretending to have sent something. Mail is
      // optional in a self-hosted install (see `mail.ts`), and a user staring at
      // an empty inbox is worse served by a reassuring lie than by being told to
      // ask their operator.
      //
      // 200 with `sent: false`, not 503. This body is not the error envelope,
      // and `lib/api.ts` discards a non-2xx body that is not one — deliberately,
      // since an unexpected body may be a proxy page or a stack trace. So the
      // reason below reached nobody: the client showed "Something went wrong"
      // and the one thing this branch exists to say was lost. The request was
      // handled correctly; `sent` is the outcome, and callers read it.
      //
      // Logged at error level *because* the status is 200. The completion line
      // the route wrapper writes takes its level and its tense from the status,
      // so this request ends with `level: info`, `outcome: success` and a
      // sentence reading "Sent a PIN reset link to the account's address" — a
      // delivery that did not happen, affirmed in the log stream. This line is
      // the correction, and the one an alert on `level:error` can fire on now
      // that the old 503 no longer raises `outcome:server_error`.
      services.log
        .at('POST')
        .error(
          'Mail is not configured on this deployment, so no PIN reset link was sent — every ' +
            'reset request here fails the same way, and an account that has forgotten its PIN ' +
            'cannot get back in without an operator',
          { reason: 'mail_not_configured' },
        );

      return json({
        sent: false,
        reason:
          'Email is not configured for this deployment, so a reset link cannot be sent. Ask ' +
          'whoever operates this xecret instance to set one up, or to reset your PIN directly.',
      });
    }

    const { token } = await generateToken('pinReset');
    await createPinReset(services.db, {
      userId: user.user.id,
      token,
      ipAddress: services.meta.ipAddress,
    });

    const url = `${publicOrigin(services.env)}/reset-pin?token=${encodeURIComponent(token)}`;

    services.waitUntil(
      mailer
        .send(
          pinResetMail({
            to: user.user.email,
            toName: user.user.displayName,
            url,
          }),
        )
        .catch((cause: unknown) => {
          // Logged, never rethrown: the response has already gone. The name
          // only — `errorName` rather than `describeError`, because a delivery
          // error embeds the recipient address in its message and this line
          // ends up wherever logs end up.
          services.log
            .at('POST')
            .error(
              'Could not deliver the PIN reset email — the user has been told a link was sent ' +
                'and will never receive one',
              { error: errorName(cause) },
            );
        }),
    );

    const orgId = await primaryOrgId(services, user.user.id);
    if (orgId !== null) {
      record(
        audit(orgId).success(
          'auth.pin_reset',
          { type: 'user', id: user.user.id },
          { source: 'dashboard', reason: 'requested' },
        ),
      );
    }

    return json({ sent: true });
  },
  { allowLocked: true },
);
