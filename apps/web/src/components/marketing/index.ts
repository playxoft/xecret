/**
 * The public-site kit: the pieces every marketing, blog and legal page is
 * assembled from.
 *
 * Unlike `components/ui`, this barrel is safe to import from a prerendered
 * page. Everything under it is either a Server Component or one of the two
 * small client islands the public pages genuinely need (the reveal observer,
 * the mobile drawer) — nothing here reaches the dashboard, the API client or
 * the Firebase SDK, which is the thing the note in `app/layout.tsx` is guarding
 * against.
 */

export { DockerLogo, GoLogo, NextjsLogo, NodejsLogo, PipelineLogo, ReactLogo } from './brand-logos';
export type { BrandLogoProps } from './brand-logos';
export { CtaBand } from './cta-band';
export { Faq, faqSchema } from './faq';
export type { FaqItem } from './faq';
export { graph, JsonLd } from './json-ld';
export { LegalPage } from './legal-page';
export type { LegalSection } from './legal-page';
export { INLINE_LINK, QUIET_LINK } from './link-styles';
export { PageHero } from './page-hero';
export { PublicPage } from './public-page';
export { Reveal, RevealGroup } from './reveal';
export type { RevealProps } from './reveal';
export { Container, Section, SectionHeading } from './section';
export type { SectionHeadingProps, SectionProps } from './section';
