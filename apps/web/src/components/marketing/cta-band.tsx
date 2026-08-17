import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { ArrowRightIcon, GitHubIcon } from '@/components/ui/icons';
import { REPO_URL } from '@/lib/site';
import { Reveal } from './reveal';
import { Container } from './section';

/**
 * The closing band on every public page.
 *
 * A reader who has scrolled to the bottom of a page has told you they are
 * interested; a footer full of links is not an answer to that. So every page
 * ends with the same two actions, in the same place, with the same weight.
 *
 * Both actions are stated plainly. "Start free" is free, and "Read the source"
 * goes to the source — on a security product, a call to action that overstates
 * itself costs more than the click it wins.
 */
export function CtaBand({
  title = 'Get your secrets out of version control.',
  description = 'Create a project, import the .env file you already have, and run your app through the CLI. It takes about a minute, and the free tier does not ask for a card.',
}: {
  title?: string;
  description?: string;
}) {
  return (
    <section className="border-line-subtle relative isolate overflow-hidden border-t">
      <div className="x-hero-glow" aria-hidden="true" />
      <Container className="relative py-20 sm:py-24">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-fg text-3xl leading-tight font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
            {title}
          </h2>
          <p className="text-fg-muted mx-auto mt-4 max-w-xl text-base leading-8 text-pretty">
            {description}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild variant="primary" size="lg" className="rounded-full">
              <Link href="/sign-up">
                Start free
                <ArrowRightIcon className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="secondary" size="lg" className="rounded-full">
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                <GitHubIcon className="size-4" />
                Read the source
              </a>
            </Button>
          </div>
          <p className="text-fg-subtle mt-5 text-sm">
            No credit card · AGPL-3.0 server · MIT CLI · Self-host it for free
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
