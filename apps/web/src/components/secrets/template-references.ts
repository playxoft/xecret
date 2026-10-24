import { formatReference, templateReferences, TemplateSyntaxError } from '@xecret/core/references';
import type { SecretReference } from '@xecret/core/references';

/**
 * What a template value field shows about the text in it (P19 §1), as it is
 * typed.
 *
 * ── Why the dashboard parses at all ──
 * The server never sees a template's text — it is a secret value, end-to-end
 * encrypted like any other — so the only list of references it can check for a
 * loop, a dangling target or a reach into an environment the writer may not
 * read is the one the writer *declares* beside the ciphertext. The dashboard
 * declares what `templateReferences` finds; showing the same list while the
 * text is being written is what lets the person see, before saving, exactly
 * what the server is about to be told — and notice the `${DB_HSOT}` before the
 * server refuses it as a reference to nothing.
 *
 * ── What may be said about a parse failure ──
 * The rule and the position, never the text. `TemplateSyntaxError` carries
 * exactly that, and its message is reused verbatim; nothing here echoes any
 * part of the value, because an error message is the easiest place in a
 * product for a credential to escape into a log or a screenshot.
 */

/** One reference, as the field lists it. */
export interface ListedReference {
  /** As it is written in the template, braces and all: `${staging.DB_HOST}`. */
  written: string;
  /** Where it resolves, in words. */
  where: string;
  reference: SecretReference;
}

export type TemplateReading =
  /** Not a template, or nothing typed yet. The field says nothing. */
  | { kind: 'none' }
  /** The text does not parse. The field's own shape check already says why. */
  | { kind: 'invalid'; message: string; offset: number }
  /** Parses. An empty list is plain text declared as a template, which is allowed. */
  | { kind: 'references'; references: readonly ListedReference[] };

/**
 * Reads a value as the template it is declared to be.
 *
 * Distinct references in order of first appearance, which is also the order
 * the write declares them in — so the list on screen and the declaration on
 * the wire are the same list.
 */
export function readTemplate(value: string, valueType: string): TemplateReading {
  if (valueType !== 'template' || value.length === 0) return { kind: 'none' };

  try {
    return {
      kind: 'references',
      references: templateReferences(value).map((reference) => ({
        written: formatReference(reference),
        where: describeReference(reference),
        reference,
      })),
    };
  } catch (cause) {
    if (cause instanceof TemplateSyntaxError) {
      return { kind: 'invalid', message: cause.message, offset: cause.offset };
    }
    // Nothing else is thrown by the parser; if something ever is, its message is
    // not one this module has vetted, so it is not passed on.
    return { kind: 'invalid', message: 'That template cannot be read.', offset: 0 };
  }
}

/**
 * Where a reference resolves, in a sentence fragment.
 *
 * An unqualified `${KEY}` is the subtle one: it is `KEY` *as the environment
 * being read sees it*, which includes what that environment inherits — so a
 * template in a parent resolves `${KEY}` differently for each child that
 * inherits it. Saying "in this environment" would be wrong for exactly the
 * case the feature exists for.
 */
export function describeReference(reference: SecretReference): string {
  if (reference.project !== undefined && reference.environment !== undefined) {
    return `${reference.name} in ${reference.project}/${reference.environment}`;
  }
  if (reference.environment !== undefined) {
    return `${reference.name} in ${reference.environment}, in this project`;
  }
  return `${reference.name} as the environment being read sees it, including what it inherits`;
}

/**
 * Whether a type change turns a value into a template or stops it being one.
 *
 * Such a change alters what the stored text *means* — its `${…}` become
 * references, or stop being them — and the declaration that goes with a
 * template lives on a version. So the server refuses it as a label change
 * (`PUT …/secrets/{name}`) and accepts it only as a value write, which is how
 * the dashboard has to send it.
 */
export function crossesTemplateBoundary(storedType: string, nextType: string): boolean {
  return (storedType === 'template') !== (nextType === 'template');
}

/**
 * Why a template cannot be renamed, in the sentence the dashboard shows before
 * the server would refuse it with the same reason.
 */
export const TEMPLATE_RENAME_REFUSAL =
  'A template cannot be renamed: what its unqualified references resolve to depends on where it sits. Create it under the new name and delete this one.';

/**
 * Why a type change to or from a template needs the value, when the editor
 * holds none to write.
 */
export const TEMPLATE_RETYPE_NEEDS_VALUE =
  'Changing to or from a template rewrites the value, so it has to be read first. Open the value, then save again.';
