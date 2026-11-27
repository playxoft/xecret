import { appPath } from '../_lib/paths';
import { canAdminister } from './session';
import type { SessionOrganization } from './session';

/**
 * What each settings area is made of: its sections, in the order the left
 * navigation lists them, with the address of each and who is shown which.
 *
 * ── Why every section is a route ──
 * Each of the three settings areas — the account, an organisation, an
 * environment — used to be one long page of cards, and finding the one card
 * that answers a question meant scrolling for it. Now each card, or each small
 * group of cards about one thing, is a section with its own address: the nav
 * lists the sections of the area you are in and nothing else, and choosing one
 * shows that section alone. A route rather than a `?section=` or a client-side
 * tab, so a section is a link somebody can be sent, a reload lands where it
 * was, and Back goes to the section before rather than out of the area.
 *
 * ── Why it is declared, not read from the page ──
 * The contents rail this replaces built its list from the cards on screen, and
 * could, because every entry pointed into the page it was on. A section's
 * entry points at a page that is *not* rendered yet, so there is nothing to
 * read it from: the list has to be written down. It is written here, beside the
 * gates that decide who sees each entry, and the pages under each area's
 * `settings` folder are its other half — `settings-sections.test.ts` checks the
 * two agree.
 *
 * ── Who is shown what ──
 * An entry is hidden from a viewer who certainly cannot use the section, by the
 * same rule that used to hide or empty its card: the organisation's billing
 * for anybody but an owner, its deletion for anybody who cannot delete it, an
 * auto-lock with no vault to lock. As everywhere in the dashboard that is a
 * courtesy and not a boundary — every request is authorised by the server —
 * and a hidden section keeps its address: somebody who follows a link to one
 * gets the sentence that explains who can use it, which is what the card
 * always said.
 *
 * Pure, with no `'use client'`, so the gating can be tested without rendering a
 * navigation that needs a router.
 */

export interface SettingsSection {
  /** The section's own address — what the nav links to, and how it knows it is open. */
  href: string;
  label: string;
  /**
   * The fragments that used to lead to this section's cards when they shared
   * a page with others — `…/settings/security#devices`, say. A visit carrying
   * one of these is sent on to this section; see `legacyAnchorTarget`.
   */
  anchors?: readonly string[];
  /**
   * Left out of the nav for this viewer. Still an address, and still where a
   * legacy anchor leads: the section says who can use it.
   */
  hidden?: boolean;
}

/**
 * A run of sections that belong together. Untitled: the nav is one plain list,
 * and a group is only the little space in its column before the next — see
 * `SettingsNav`.
 */
export interface SettingsSectionGroup {
  sections: readonly SettingsSection[];
}

/** The sections a viewer is shown, empty groups dropped. */
export function visibleSettingsGroups(
  groups: readonly SettingsSectionGroup[],
): readonly SettingsSectionGroup[] {
  return groups
    .map((group) => ({ ...group, sections: group.sections.filter((section) => !section.hidden) }))
    .filter((group) => group.sections.length > 0);
}

/**
 * The section a pathname is, or `undefined` outside every one of them.
 *
 * An exact match, because every section is its own route and General sits at
 * the area's own address, which is a prefix of all the others: a prefix match
 * would light General on every page of the area. A trailing slash is
 * forgiven; a query string never reaches here, since `usePathname` has none —
 * which is what keeps Billing lit on the way back from a checkout.
 */
export function activeSettingsSection(
  groups: readonly SettingsSectionGroup[],
  pathname: string,
): SettingsSection | undefined {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  for (const group of groups) {
    for (const section of group.sections) if (section.href === path) return section;
  }
  return undefined;
}

/**
 * Where a visit carrying an old fragment belongs, or `null` when it is already
 * there — or carries no fragment this area knows.
 *
 * ── Why fragments need forwarding at all ──
 * Every card that shared a page carried an `id`, and those ids are in links
 * nobody can take back: the setup portal's return address, emails, bookmarks,
 * a URL pasted into a chat. A fragment never reaches the server, so a redirect
 * cannot read it — the old page answers, or redirects to a section, and the
 * browser carries the fragment along to wherever it lands. This reads it there
 * and sends the visit on to the section that now holds the card.
 *
 * The fragment travels with it, so a section with more than one card still
 * opens at the one that was linked. Hidden sections are included: an anchor is
 * an address, and the section it leads to says who may use it.
 */
export function legacyAnchorTarget(
  groups: readonly SettingsSectionGroup[],
  pathname: string,
  hash: string,
): string | null {
  if (hash.length < 2 || !hash.startsWith('#')) return null;

  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    // A malformed escape is nobody's anchor.
    return null;
  }

  for (const group of groups) {
    for (const section of group.sections) {
      if (!section.anchors?.includes(id)) continue;
      return activeSettingsSection(groups, pathname) === section
        ? null
        : `${section.href}#${hash.slice(1)}`;
    }
  }
  return null;
}

/* ─────────────────────────────── the account ─────────────────────────────── */

/**
 * The account's settings: who you are, how xecret looks, how you get in, and
 * the two acts that cannot be undone.
 *
 * What were three tabs — General, Security, Danger zone — and a contents rail
 * inside two of them is now one list. The tabs survive as its groups, set a
 * little apart from one another, and the Security tab, five cards long, is
 * four sections: the sign-in page, the vault (with the vault a recent reset
 * left behind, which is the same question), the unlock and its auto-lock, and
 * the devices signed in.
 *
 * "Unlock & auto-lock" waits for a vault: until there is one there is nothing
 * to unlock, and its card has never been drawn without one.
 */
export function accountSettingsSections({
  vaultConfigured,
}: {
  vaultConfigured: boolean;
}): readonly SettingsSectionGroup[] {
  return [
    {
      sections: [
        { href: appPath.account(), label: 'Profile', anchors: ['profile'] },
        { href: appPath.settingsAppearance(), label: 'Appearance', anchors: ['appearance'] },
      ],
    },
    {
      sections: [
        { href: appPath.settingsSignIn(), label: 'Password & sign-in', anchors: ['sign-in'] },
        { href: appPath.settingsVault(), label: 'Vault', anchors: ['vault', 'previous-vaults'] },
        {
          href: appPath.settingsUnlock(),
          label: 'Unlock & auto-lock',
          anchors: ['unlock'],
          hidden: !vaultConfigured,
        },
        { href: appPath.settingsDevices(), label: 'Signed-in devices', anchors: ['devices'] },
      ],
    },
    {
      sections: [
        {
          href: appPath.settingsDanger(),
          label: 'Danger zone',
          anchors: ['delete-project', 'delete-account'],
        },
      ],
    },
  ];
}

/* ───────────────────────────── an organisation ───────────────────────────── */

/**
 * An organisation's settings: the page that names it, the rules that apply
 * across it, what it pays, and its deletion.
 *
 * General keeps the area's own address, so every link to "organisation
 * settings" — the sidebar, the billing screen's way back, years of bookmarks —
 * still opens on the organisation's name. Billing and the plans were already
 * routes under `settings` and keep theirs; Dodo's checkout and portal return to
 * the billing address, and the emails about a payment link to it.
 *
 * Each entry is hidden from the viewers its card turned away:
 *
 *  - **Roles** need `member.update`, the read gate of the roles list;
 *  - **Single sign-on** and **Webhooks** need `org.update`, theirs;
 *  - **Billing** needs `billing.manage` — an owner — which is what hid the
 *    billing card on the old page;
 *  - **Danger zone** needs `org.delete` — an owner again — which hid the
 *    delete card.
 *
 * The policies are read by every member, because the people held to a rule
 * should be able to read it, and the plans by every member, because somebody
 * who has just met a locked switch deserves to know what would unlock it.
 */
export function organizationSettingsSections(
  orgSlug: string,
  viewer: SessionOrganization | null,
): readonly SettingsSectionGroup[] {
  return [
    {
      sections: [
        { href: appPath.orgSettings(orgSlug), label: 'General' },
        {
          href: appPath.orgRoles(orgSlug),
          label: 'Roles',
          hidden: !canAdminister(viewer, 'member.update'),
        },
        {
          href: appPath.orgSingleSignOn(orgSlug),
          label: 'Single sign-on',
          anchors: ['single-sign-on'],
          hidden: !canAdminister(viewer, 'org.update'),
        },
        { href: appPath.orgPolicies(orgSlug), label: 'Policies' },
        {
          href: appPath.orgWebhooks(orgSlug),
          label: 'Webhooks',
          anchors: ['webhooks'],
          hidden: !canAdminister(viewer, 'org.update'),
        },
      ],
    },
    {
      sections: [
        {
          href: appPath.orgBilling(orgSlug),
          label: 'Billing',
          hidden: !canAdminister(viewer, 'billing.manage'),
        },
        { href: appPath.orgPlans(orgSlug), label: 'Plans' },
      ],
    },
    {
      sections: [
        {
          href: appPath.orgDanger(orgSlug),
          label: 'Danger zone',
          hidden: !canAdminister(viewer, 'org.delete'),
        },
      ],
    },
  ];
}

/* ───────────────────────────── an environment ────────────────────────────── */

/** The environment's sections below General, by the folder each page lives in. */
export const ENVIRONMENT_SETTINGS_SECTIONS = [
  'encryption',
  'inheritance',
  'policy',
  'danger',
] as const;
export type EnvironmentSettingsSectionId = (typeof ENVIRONMENT_SETTINGS_SECTIONS)[number];

/**
 * One environment section's address, below the environment's settings.
 *
 * Built from the settings address rather than from the slugs, so this module
 * never spells out how an environment is addressed: that is
 * `appPath.environmentSettings`'s to say, and it says it once.
 */
export function environmentSettingsSectionHref(
  settingsHref: string,
  section: EnvironmentSettingsSectionId,
): string {
  return `${settingsHref}/${section}`;
}

/**
 * An environment's settings: what it is called and whether it is production,
 * the key its values are sealed with, what it inherits, how its values may
 * leave it, and its deletion.
 *
 * General keeps `appPath.environmentSettings`, which the environment page's
 * Settings button and the read-alert emails already link to. Everybody who can
 * open the environment is shown every section but the last, as they were
 * shown every card: each says for itself what a viewer without
 * `environment.update` may not change. Deleting needs `environment.delete`,
 * which is what drew the delete card.
 *
 * There is no project-level settings area. A project has a name, a description
 * and a delete, which its Manage menu already holds; and the address one would
 * take, `/app/{org}/{project}/settings`, is the address of an environment whose
 * slug is `settings` — a slug the reserved list deliberately leaves to
 * environments.
 */
export function environmentSettingsSections(
  settingsHref: string,
  viewer: SessionOrganization | null,
): readonly SettingsSectionGroup[] {
  const at = (section: EnvironmentSettingsSectionId) =>
    environmentSettingsSectionHref(settingsHref, section);

  return [
    {
      sections: [
        { href: settingsHref, label: 'General' },
        { href: at('encryption'), label: 'Encryption key' },
        { href: at('inheritance'), label: 'Inheritance' },
        { href: at('policy'), label: 'Policy' },
      ],
    },
    {
      sections: [
        {
          href: at('danger'),
          label: 'Danger zone',
          hidden: !canAdminister(viewer, 'environment.delete'),
        },
      ],
    },
  ];
}
