#!/usr/bin/env -S npx tsx
/**
 * Sends one deliberately hostile enquiry through the real webhook.
 *
 *   phase run -- npx tsx scripts/contact-smoke.ts
 *
 * ── Why this exists as a script rather than a test ──
 * `discord.test.ts` asserts the *payload* — that mentions cannot fire, that the
 * address survives, that a long body is truncated — against a stubbed `fetch`,
 * and that is the right place for every one of those. What it cannot tell you is
 * whether the configured webhook is real, points at the channel you meant, and
 * renders the embed the way you expected. That is a thing you confirm by looking
 * at Discord once, which is what this is for.
 *
 * The payload is chosen to be the worst plausible submission: an `@everyone` in
 * two fields, a credential-shaped string, backticks, and a long tail. If the
 * channel pings anybody when this lands, `allowed_mentions` has regressed and
 * the form is a notification cannon.
 *
 * Safe to run more than once. It sends one message and writes nothing.
 */

import { DiscordContactSink } from '../apps/web/src/server/discord.ts';

async function main(): Promise<void> {
  const url = process.env['DISCORD_CONTACT_WEBHOOK_URL'];

  if (!url) {
    console.error('✗ DISCORD_CONTACT_WEBHOOK_URL is not set.');
    console.error('  Try: phase run -- npx tsx scripts/contact-smoke.ts');
    process.exit(1);
  }

  await new DiscordContactSink(url).deliver({
    name: 'Ada Lovelace @everyone',
    email: 'ada@example.com',
    message:
      'Hi @here — token: xec_live_abcdefghijklmnop. We are moving off Vault and need EU data ' +
      'residency. Backtick test: `code`. ' +
      'Padding so the truncation path is exercised too. '.repeat(40),
    source: 'https://xecret.playxoft.com/pricing',
  });

  console.log('✓ Delivered. In the channel, check that:');
  console.log('  - nobody was pinged — @everyone and @here must be plain text');
  console.log('  - Email reads ada@example.com, not [redacted-email]');
  console.log('  - the token in the body is masked');
  console.log('  - Message ends in an ellipsis rather than at Discord’s own cap');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
