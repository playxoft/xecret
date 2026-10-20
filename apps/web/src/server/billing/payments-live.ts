import { connection } from 'next/server';
import { workerContext } from '../context';
import { takesLivePayments } from './config';

/**
 * Whether the public pages may say that paying works here (P12): this
 * deployment takes **real** payments — every Dodo variable set, in Dodo's live
 * mode. A self-hoster, this deployment before Dodo is set up, and a staging
 * rehearsal in test mode all answer `false`, and the pages keep saying that
 * nothing is charged.
 *
 * ── The cost, stated ──
 * `connection()` makes the calling page render per request. It has to: the
 * answer is runtime configuration — two of the variables are Worker secrets —
 * and a page prerendered at build time would bake in whatever the build
 * machine had, which is none of them. So the pricing, terms, about, FAQ and
 * features pages are dynamic. Each is a render with no database and no
 * network call; the price is microseconds at the edge, against a legal page
 * that could otherwise tell a paying customer they are not being charged.
 *
 * Wherever the configuration cannot be read (a half-configured deployment,
 * whose billing routes answer 503 anyway) the answer is `false`. The one throw
 * let through is `connection()`'s own during a prerender — Next's signal that
 * the page is dynamic, which must reach Next rather than be swallowed here.
 */
export async function takesPayments(): Promise<boolean> {
  await connection();
  try {
    const { env } = await workerContext();
    return takesLivePayments(env);
  } catch {
    return false;
  }
}
