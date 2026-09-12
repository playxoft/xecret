/**
 * The contract between the settings layout, its cards and the contents rail.
 *
 * Its own module, with no `'use client'`, for a reason that is easy to get
 * wrong: every export of a client module is a *client reference* when a Server
 * Component imports it, not the value. The layout is a Server Component and it
 * writes the container id into its markup, so that id cannot live beside the
 * rail that reads it — it would arrive as an opaque proxy and render nothing
 * usable.
 */

/**
 * The element the section scan is scoped to. Set by the settings layout around
 * `{children}`, so a tab's cards are the only things that can appear in the
 * rail.
 */
export const SETTINGS_CONTENT_ID = 'settings-sections';

/**
 * The marker a card carries to appear in the contents rail, alongside the `id`
 * the link points at.
 *
 * Two attributes rather than one because they answer different questions: the
 * `id` is the anchor — and a shareable one, so `…/settings/security#devices`
 * opens on the devices card — while this says "that anchor is a section of the
 * page", which a card with an `id` for some other reason is not.
 *
 * Written out at each card (`<Card id="devices" data-settings-section>`) rather
 * than spread from here: the cards live in `_components` and in
 * `components/vault`, and neither should have to import from one route's folder
 * to label a heading.
 */
export const SETTINGS_SECTION_ATTRIBUTE = 'data-settings-section';
