/**
 * An environment, as the secrets table needs to describe one.
 *
 * `isProduction` travels with the slug because it is what the confirmation
 * dialogs key off: a write that lands in production is confirmed and named,
 * everywhere it can happen. Carrying the flag alongside the slug means no
 * caller has to look it up a second time and none can forget to.
 */
export interface EnvironmentTarget {
  slug: string;
  name: string;
  isProduction: boolean;
}
