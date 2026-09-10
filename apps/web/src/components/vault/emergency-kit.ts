'use client';

import { normalizeCrockford } from '@xecret/core/crypto/client';
import type { RecoveryCode } from '@xecret/core/crypto/client';

/**
 * The Emergency Kit: five codes, on paper, and the rules about leaving the
 * screen that shows them.
 *
 * ── Why this is a file and a print sheet, not a "copy to clipboard" ──
 * Copy is offered too, but it is not enough on its own and it is not what the
 * gate below accepts. A clipboard is overwritten by the next thing anybody
 * copies, and the failure it causes surfaces months later on the one day it
 * matters. The kit is written for the person reading it in a year, under
 * pressure, who has forgotten what any of this was — which is why the text
 * carries the account's email, the date it was issued, and a paragraph
 * explaining what the codes do, rather than five bare strings.
 *
 * ── The honest sentence ──
 * Every rendering of the kit repeats it: without the passphrase or one of these
 * codes, the data is gone, and nobody — including xecret — can change that. It
 * is stated on the setup screen, in the file, and on the print sheet, because
 * the one place a user will still have it in a year is the file.
 */

export interface EmergencyKit {
  email: string;
  issuedAt: Date;
  codes: readonly RecoveryCode[];
}

/**
 * The paragraph, written once and used in the file, the print sheet and the
 * screen.
 *
 * Deliberately not marketing copy. It names what the codes replace (the
 * passphrase), what using one costs (all five are replaced), and what happens
 * when they are gone (nothing can be done), in that order.
 */
export const EMERGENCY_KIT_EXPLANATION =
  'These recovery codes are the only way back into your xecret vault if you forget your master passphrase. ' +
  'Each code can be used once, and using any one of them replaces all five and forces you to set a new passphrase. ' +
  'Anyone holding a code and your sign-in can read everything in your vault, so keep this somewhere you would keep a ' +
  'passport — not in the password manager or the inbox that your xecret sign-in already protects. ' +
  'If you lose your passphrase and all five codes, your secrets cannot be decrypted by anyone, including xecret. ' +
  'There is no support process that recovers them, because there is no key on our side to recover them with.';

/** `2026-09-08` — the date, unambiguous in every locale. */
function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `xecret-emergency-kit-2026-09-08.txt`. */
export function emergencyKitFilename(issuedAt: Date): string {
  return `xecret-emergency-kit-${isoDate(issuedAt)}.txt`;
}

/**
 * The `.txt` file's contents.
 *
 * Plain text with hard line breaks rather than anything richer, because the
 * requirement is that it opens on a machine nobody has configured — a phone, a
 * recovery USB stick, a printer's built-in viewer — and survives being pasted
 * into whatever the reader has to hand.
 *
 * Pure, and returning a string rather than triggering a download, so what the
 * file says can be asserted in a test. `downloadEmergencyKit` is the thin part
 * that touches the DOM.
 */
export function emergencyKitText(kit: EmergencyKit): string {
  const lines = [
    'XECRET EMERGENCY KIT',
    '====================',
    '',
    `Account:  ${kit.email}`,
    `Issued:   ${isoDate(kit.issuedAt)}`,
    '',
    'RECOVERY CODES',
    '--------------',
    ...kit.codes.map((code, index) => `  ${index + 1}. ${code.displayForm}`),
    '',
    'WHAT THESE ARE',
    '--------------',
    EMERGENCY_KIT_EXPLANATION,
    '',
    'Your master passphrase is deliberately not written here. If you write it down,',
    'keep it somewhere else — this sheet and that passphrase together are your vault.',
    '',
  ];

  return lines.join('\n');
}

/**
 * Saves the kit as a file.
 *
 * A `blob:` URL and a synthetic click, revoked immediately afterwards: there is
 * no server round trip because there is nothing on the server to ask — these
 * codes exist only in this tab, and this is the last screen on which they will
 * ever be legible.
 */
export function downloadEmergencyKit(kit: EmergencyKit): void {
  const blob = new Blob([emergencyKitText(kit)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = emergencyKitFilename(kit.issuedAt);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}

/**
 * Prints the kit.
 *
 * `window.print()` on the dashboard would print the dashboard. This opens a
 * detached same-origin document containing nothing but the kit, prints that, and
 * closes it — so what comes out of the printer is the sheet and not a screenshot
 * of an application around it.
 *
 * Returns `false` when the window could not be opened, which is what a popup
 * blocker looks like from here. The caller says so rather than silently counting
 * the kit as printed: the save-confirmation gate below must never be satisfied
 * by a print that did not happen.
 */
export function printEmergencyKit(kit: EmergencyKit): boolean {
  const frame = window.open('', '_blank', 'noopener,noreferrer,width=720,height=900');
  if (frame === null) return false;

  const document_ = frame.document;
  document_.title = emergencyKitFilename(kit.issuedAt);

  // Built with DOM calls rather than `document.write` of a template string: the
  // codes and the account's email go through `textContent`, so no value on this
  // page can be read as markup. A print sheet is not a place to introduce the
  // one injection sink in the application.
  const pre = document_.createElement('pre');
  pre.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  pre.style.fontSize = '13px';
  pre.style.lineHeight = '1.6';
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.padding = '24px';
  pre.textContent = emergencyKitText(kit);
  document_.body.appendChild(pre);

  frame.focus();
  frame.print();
  frame.close();
  return true;
}

/**
 * Which code the confirmation step asks for.
 *
 * Chosen at random rather than always asking for the first, so that "confirm you
 * saved this" cannot be satisfied by copying one code and ignoring the rest.
 * Returns an index into `codes`.
 */
export function promptedCodeIndex(count: number): number {
  return Math.floor(Math.random() * count);
}

/**
 * Whether the ceremony may leave the recovery-codes screen, and why not if not.
 *
 * ── The rule, and why it is an OR ──
 * Either the kit was saved — downloaded or printed, both of which produce an
 * artefact that outlives the tab — or the user typed one prompted code back,
 * which proves they have it written down somewhere this page cannot see. Both
 * are evidence; neither is proof, and no rule enforceable in a browser could be.
 * What this stops is the far more common failure: clicking Continue on a screen
 * of codes without reading it, and discovering six months later that the only
 * copy died with the tab.
 *
 * Pure, so the gate itself is testable. The typed value is normalised the same
 * forgiving way `parseRecoveryCode` normalises a redeemed code — hyphens,
 * spacing, case and the `I`/`L`/`O` confusables all forgiven — because a person
 * copying 26 characters off a sheet they printed thirty seconds ago should not
 * fail on a missing dash.
 */
export function kitConfirmationProblem(input: {
  /** Set once a download or a print has actually happened. */
  saved: boolean;
  /** The code the screen is asking to have typed back. */
  prompted: RecoveryCode;
  typed: string;
}): string | null {
  if (input.saved) return null;
  if (input.typed.trim().length === 0) {
    return 'Download or print the kit, or type the code above to confirm you have saved it.';
  }

  const expected = normalizeCrockford(input.prompted.displayForm);
  if (normalizeCrockford(input.typed) !== expected) {
    return 'That does not match the code shown above. Check it character by character.';
  }

  return null;
}
