import { generateToken } from '@xecret/core/auth';
import { createPinReset } from '@xecret/db/repositories';
import { publicOrigin } from '@/server/bindings';
import { describeMailFailure, mailerFrom } from '@/server/mail';
import { pinResetMail } from '@/server/pin-reset-mail';
import { json } from '@/server/http';

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
 * ── The mail is sent before the response ──
 * `await`, not `waitUntil`. This used to defer the send, and the reasoning for
 * the reversal is at the call site below — it is a story about an incident, and
 * it belongs next to the code it explains.
 *
 * ── A minted token is audited whether or not it was delivered ──
 * The row is written before the send, so a provider that refuses still leaves a
 * live, single-use reset token behind. Auditing only the delivered case would
 * mean the log says "no reset was issued" while the database says otherwise,
 * and an incident review has no way to tell which one to believe.
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

    // Resolved before the send rather than after it, so both endings below can
    // write their record. The audit log is scoped to an organisation and a user
    // who belongs to none has nowhere to write — which is a gap in the model
    // rather than in this route, and is why the null is tolerated here.
    const orgId = await primaryOrgId(services, user.user.id);
    const subject = { type: 'user', id: user.user.id } as const;

    // ── Awaited, not deferred ──
    //
    // This used to go through `waitUntil`, on the reasoning that a Worker has
    // six outgoing connections and nobody should watch a spinner while Zoho is
    // slow, "since the answer is the same either way". The answer is not the
    // same either way, and a real incident proved it: the provider's account
    // had run out of sending credit, every send came back 429, and every user
    // was told "check your email" for a message that was never going to arrive.
    // The failure was in the log a second after the response had already lied.
    //
    // This is the *recovery* path. Somebody using it cannot get into their
    // account, and a false "check your email" sends them to wait on an inbox
    // instead of asking for help — the one flow where an optimistic answer
    // costs the most. A second of latency is the correct price for telling the
    // truth here, and the rate limit above bounds how often it can be paid.
    //
    // The invitation mail still defers, and should: its response carries the
    // link itself, so a failed send loses nothing the inviter cannot recover.
    try {
      await mailer.send(
        pinResetMail({
          to: user.user.email,
          toName: user.user.displayName,
          url,
        }),
      );
    } catch (cause) {
      // The provider's own status and explanation, address stripped — without
      // them this reads "MailDeliveryError" and an operator cannot tell an
      // exhausted quota from a wrong region from an unverified domain.
      services.log
        .at('POST')
        .error(
          'The mail provider rejected the PIN reset email, so no link was sent. An account that ' +
            'has forgotten its PIN cannot get back in until this is fixed — see status and ' +
            'detail for which of quota, credentials or sending domain is at fault.',
          describeMailFailure(cause),
        );

      // The token stays in the database. It is single-use and short-lived, and
      // an unused row is harmless — whereas rolling it back would mean a second
      // failure path to get wrong on the way out. It is *not* unrecorded,
      // though: something that can replace a PIN now exists, and the audit log
      // is where that fact has to live regardless of who read the email.
      //
      // `outcome: error` on this action means exactly one thing — a token was
      // minted and not delivered. It cannot be confused with the other way a
      // reset fails to arrive, because a deployment with no mailer returns
      // above without minting anything, so it writes no record at all.
      if (orgId !== null) {
        record(
          audit(orgId).error('auth.pin_reset', subject, 'upstreamUnavailable', {
            source: 'dashboard',
          }),
        );
      }

      return json({
        sent: false,
        reason:
          'The email could not be sent right now — the mail provider refused it. This is a ' +
          'problem with this deployment rather than with your account. Try again shortly, and ' +
          'if it keeps failing ask whoever operates this xecret instance to check its mail setup.',
      });
    }

    if (orgId !== null) {
      record(
        audit(orgId).success('auth.pin_reset', subject, {
          source: 'dashboard',
          reason: 'requested',
        }),
      );
    }

    return json({ sent: true });
  },
  { allowLocked: true },
);
