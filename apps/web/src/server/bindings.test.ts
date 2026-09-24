import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { withProcessFallbacks } from './bindings';
import type { Bindings } from './bindings';

/**
 * The gap between what `Bindings` declares and what `PROCESS_SUPPLIED` copies.
 *
 * ── Why this test exists ──
 * Because the failure it catches has now happened twice, costs an hour each
 * time, and looks like anything except its cause. A string binding is added to
 * the interface; `phase run` puts the value in the shell; every script that
 * reads `process.env` works; and the application answers
 * `503 … is missing the X binding`, which is a true statement that points at the
 * configuration rather than at the list nobody updated.
 *
 * The declaration and the list are two places that have to agree, and a comment
 * asking the next person to remember is not a mechanism. This is.
 */

const SOURCE = readFileSync(new URL('./bindings.ts', import.meta.url), 'utf8');

/**
 * Every optional string property declared on the `CloudflareEnv` augmentation.
 *
 * Read out of the source rather than derived from the type, because the type
 * does not exist at runtime and the type-level version of this check reports its
 * failure as an unreadable conditional rather than as a name. A regular
 * expression over a declaration block is a blunt instrument; it is also the one
 * that says "DISCORD_CONTACT_WEBHOOK_URL is missing" when it fails.
 */
function declaredStringBindings(): string[] {
  const block = SOURCE.slice(
    SOURCE.indexOf('interface CloudflareEnv'),
    SOURCE.indexOf('export type Bindings'),
  );
  return [...block.matchAll(/^\s{4}([A-Z][A-Z0-9_]*)\?: string \| undefined;/gm)].map(
    (match) => match[1] as string,
  );
}

function processSupplied(): string[] {
  const block = SOURCE.slice(
    SOURCE.indexOf('const PROCESS_SUPPLIED = ['),
    SOURCE.indexOf('] as const;', SOURCE.indexOf('const PROCESS_SUPPLIED = [')),
  );
  return [...block.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1] as string);
}

describe('PROCESS_SUPPLIED', () => {
  it('finds the declarations it is checking', () => {
    // A guard on the guard: if the regular expressions above stop matching, the
    // real assertion passes vacuously and the check silently stops existing.
    expect(declaredStringBindings().length).toBeGreaterThan(5);
    expect(processSupplied().length).toBeGreaterThan(5);
  });

  it('lists every string binding the interface declares', () => {
    const missing = declaredStringBindings().filter((name) => !processSupplied().includes(name));

    expect(
      missing,
      `Declared as a string binding but never copied from the environment: ${missing.join(', ')}. ` +
        'Add it to PROCESS_SUPPLIED, or `phase run -- npm run dev` will inject a value the ' +
        'application cannot see and every request will answer 503.',
    ).toEqual([]);
  });

  it('lists nothing that is not declared', () => {
    const declared = declaredStringBindings();
    const stray = processSupplied().filter((name) => !declared.includes(name));

    expect(stray, `Copied from the environment but not declared: ${stray.join(', ')}`).toEqual([]);
  });
});

describe('withProcessFallbacks', () => {
  it('fills an absent binding from the environment', () => {
    const merged = withProcessFallbacks({} as Bindings, {
      DISCORD_CONTACT_WEBHOOK_URL: 'https://discord.example/webhook/token',
    });

    expect(merged.DISCORD_CONTACT_WEBHOOK_URL).toBe('https://discord.example/webhook/token');
  });

  /**
   * A binding always wins. In production these arrive from Hyperdrive, the
   * Secrets Store and `wrangler.toml`, and a stray variable on an operator's
   * machine must not be able to redirect a deployed configuration.
   */
  it('never overrides a binding that is already set', () => {
    const merged = withProcessFallbacks({ DATABASE_URL: 'postgres://binding' } as Bindings, {
      DATABASE_URL: 'postgres://shell',
    });

    expect(merged.DATABASE_URL).toBe('postgres://binding');
  });

  it('treats an empty string as absent', () => {
    const merged = withProcessFallbacks({ DATABASE_URL: '' } as Bindings, {
      DATABASE_URL: 'postgres://shell',
    });

    expect(merged.DATABASE_URL).toBe('postgres://shell');
  });
});
