import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui';
import { featureBlock, limitBlock, lockCopy } from './plan-gate';
import type { PlanBlock } from './plan-gate';
import { AwaitingPlanBanner } from './awaiting-plan-banner';
import {
  continuesPress,
  LockedAction,
  PlanLockBadge,
  PlanLockContent,
  PlanLockNotice,
  pressAt,
} from './plan-lock';
import { entitlementsFor, planView, withPlan } from './plan-test-view';

/**
 * The locked-action component, rendered to static markup.
 *
 * A server render runs no effects and opens no popover, so what is pinned here
 * is what every locked control carries before anybody touches it: the lock
 * icon, `aria-disabled` rather than `disabled` (so it keeps its focus and can
 * explain itself), the reason in `aria-describedby`, and the words for an owner
 * and for anybody else. The panel's own words are rendered through
 * `PlanLockContent`, which the popover shows.
 */

const PROJECTS = limitBlock(entitlementsFor('free'), 'projects', 5) as PlanBlock;
const REFERENCING = featureBlock(entitlementsFor('free'), 'secretReferencing') as PlanBlock;

function action(lock: PlanBlock | null, owner = true): string {
  return renderToStaticMarkup(
    withPlan(
      planView({ owner }),
      <LockedAction lock={lock}>
        <Button variant="primary" onClick={() => {}}>
          New project
        </Button>
      </LockedAction>,
    ),
  );
}

/** The opening `<button …>` tag. */
function buttonTag(html: string): string {
  const match = /<button[^>]*>/.exec(html);
  if (match === null) throw new Error('no button rendered');
  return match[0];
}

describe('LockedAction, unlocked', () => {
  it('is the button exactly, with no lock and nothing added', () => {
    const html = action(null);
    const tag = buttonTag(html);
    expect(html).toContain('New project');
    expect(tag).not.toContain('aria-disabled');
    expect(tag).not.toContain('data-plan-locked');
    expect(html).not.toContain('sr-only');
  });
});

describe('LockedAction, locked', () => {
  it('keeps the control focusable, and marks it aria-disabled rather than disabled', () => {
    const tag = buttonTag(action(PROJECTS));
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).toContain('data-plan-locked=""');
    expect(tag).not.toMatch(/\sdisabled=""/);
    // A submit button that is locked no longer submits its form.
    expect(tag).toContain('type="button"');
  });

  it('carries a lock icon beside its label', () => {
    const html = action(PROJECTS);
    // The icon is the padlock's shackle path, drawn before the label.
    expect(html).toMatch(
      /<svg[^>]*aria-hidden="true"[\s\S]*?M8 10\.5V7\.5a4 4 0 0 1 8 0v3[\s\S]*?New project/,
    );
  });

  it('names the reason for a screen reader, through aria-describedby', () => {
    const html = action(PROJECTS);
    const described = /aria-describedby="([^"]+)"/.exec(buttonTag(html))?.[1];
    expect(described).toBeDefined();
    expect(html).toContain(
      `<span id="${described}" class="sr-only">Your Free plan allows 5 projects. Upgrade to Pro to add more.</span>`,
    );
  });

  it('tells anybody but an owner to ask one', () => {
    expect(action(PROJECTS, false)).toContain(
      'Your Free plan allows 5 projects. Ask an owner to upgrade.',
    );
  });

  it('says a feature the plan lacks in one sentence', () => {
    expect(action(REFERENCING, false)).toContain(
      'Secret referencing is on Pro and above. Ask an owner to upgrade.',
    );
  });
});

describe('the panel a lock opens', () => {
  const content = (block: PlanBlock, owner: boolean, upgrades = true) =>
    renderToStaticMarkup(
      createElement(PlanLockContent, {
        copy: lockCopy(block, { owner, upgrades }),
        plansHref: '/app/acme/settings/plans',
        kind: block.kind,
      }),
    );

  it('gives an owner an Upgrade link to the organisation’s plans page', () => {
    const html = content(PROJECTS, true);
    expect(html).toContain('Your Free plan allows 5 projects. Upgrade to Pro to add more.');
    expect(html).toContain('href="/app/acme/settings/plans"');
    expect(html).toContain('>Upgrade</a>');
  });

  it('gives anybody else no link, and the sentence to ask an owner', () => {
    const html = content(PROJECTS, false);
    expect(html).toContain('Ask an owner to upgrade.');
    expect(html).not.toContain('<a ');
  });

  it('offers no upgrade where this deployment sells none', () => {
    const html = content(PROJECTS, true, false);
    expect(html).toContain('Your Free plan allows 5 projects.');
    expect(html).not.toContain('Upgrade');
    expect(html).not.toContain('Ask an owner');
  });

  it('asks an owner of an organisation awaiting a plan to choose one', () => {
    const awaiting = limitBlock(
      entitlementsFor('free', { awaitingPaidPlan: true, controlPlaneActive: false }),
      'projects',
      0,
    ) as PlanBlock;
    const html = content(awaiting, true);
    expect(html).toContain('Choose a plan to start using this organisation.');
    expect(html).toContain('>Choose a plan</a>');
  });
});

describe('PlanLockBadge', () => {
  it('is a focusable button named by the lock’s words', () => {
    const html = renderToStaticMarkup(
      withPlan(planView({ owner: false }), createElement(PlanLockBadge, { lock: REFERENCING })),
    );
    expect(html).toContain(
      'aria-label="Locked. Secret referencing is on Pro and above. Ask an owner to upgrade."',
    );
    expect(buttonTag(html)).toContain('type="button"');
    expect(buttonTag(html)).not.toMatch(/\sdisabled=""/);
  });
});

describe('PlanLockNotice, for a refusal that arrived anyway', () => {
  const refusal = new ApiError({
    code: 'plan_limit',
    message:
      'This organisation is on the Free plan, which allows 5 projects. The Pro plan allows more.',
    status: 403,
    requestId: 'req-1',
    plan: { resource: 'projects', limit: 5, current: 5, plan: 'free', upgradeTo: 'pro' },
  });

  it('says it in the lock’s words, and never the server’s sentence', () => {
    const html = renderToStaticMarkup(
      withPlan(planView(), createElement(PlanLockNotice, { error: refusal })),
    );
    expect(html).toContain('Your Free plan allows 5 projects. Upgrade to Pro to add more.');
    expect(html).toContain('>Upgrade</a>');
    expect(html).not.toContain('which allows 5 projects');
  });

  it('renders nothing for a failure that is not a plan refusal', () => {
    const other = new ApiError({
      code: 'conflict',
      message: 'Taken.',
      status: 409,
      requestId: null,
    });
    expect(renderToStaticMarkup(createElement(PlanLockNotice, { error: other }))).toBe('');
    expect(renderToStaticMarkup(createElement(PlanLockNotice, { error: null }))).toBe('');
  });
});

describe('the banner on an organisation awaiting a paid plan', () => {
  const awaiting = entitlementsFor('free', { awaitingPaidPlan: true, controlPlaneActive: false });

  function banner(owner: boolean, onPlansPage: boolean, entitlements = awaiting): string {
    return renderToStaticMarkup(
      withPlan(
        planView({ entitlements, owner }),
        createElement(AwaitingPlanBanner, { onPlansPage }),
      ),
    );
  }

  it('says what, and offers an owner the plans page', () => {
    const html = banner(true, false);
    expect(html).toContain('This organisation needs a paid plan to start.');
    expect(html).toContain('href="/app/acme/settings/plans"');
  });

  // Why it waits is a fact about the account that created it, which its
  // members are not told; its owners get the reason by email.
  it('never says why to the members who read it', () => {
    for (const html of [banner(true, false), banner(false, false), banner(true, true)]) {
      expect(html).not.toMatch(/two|free organisations|account that created/i);
    }
  });

  it('points at the plans below rather than linking to the page it is on', () => {
    const html = banner(true, true);
    expect(html).toContain('Choose one below to start using it.');
    expect(html).not.toContain('href="/app/acme/settings/plans"');
  });

  it('tells anybody else to ask an owner', () => {
    expect(banner(false, false)).toContain('Ask an owner to choose a plan.');
  });

  it('is absent from an organisation that is open', () => {
    expect(banner(true, false, entitlementsFor('free'))).toBe('');
  });
});

describe('a locked control pressed after its lock went stale', () => {
  const at = 1_000_000;

  it('goes ahead once the re-read lifts the lock', () => {
    expect(continuesPress(pressAt(null, at), null, at + 400)).toBe(true);
  });

  it('stays explained while the lock holds', () => {
    expect(continuesPress(pressAt(null, at), PROJECTS, at + 400)).toBe(false);
  });

  it('never runs a press long forgotten, when the lock lifts for another reason later', () => {
    expect(continuesPress(pressAt(null, at), null, at + 60_000)).toBe(false);
  });

  it('runs nothing nobody pressed', () => {
    expect(continuesPress(null, null, at)).toBe(false);
  });
});
