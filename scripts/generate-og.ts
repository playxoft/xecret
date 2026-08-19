#!/usr/bin/env -S npx tsx
/**
 * The social preview image.
 *
 *   npm run og
 *
 * ── Why a build artefact rather than a runtime one ──
 * The obvious answer in Next.js is `opengraph-image.tsx` with `ImageResponse`,
 * which renders JSX to a PNG. It is the right tool on Vercel and the wrong one
 * here: this application deploys to Cloudflare Workers through OpenNext, where
 * that path drags satori and a resvg WASM binary into a runtime whose whole
 * design constraint is bundle size — to produce an image that is identical on
 * every request.
 *
 * So the image is generated once, committed, and served as a static asset. One
 * file, no runtime cost, no WASM.
 *
 * ── Why one image rather than one per page ──
 * Per-page cards are worth having when the per-page content is worth reading in
 * a preview — a chart, a price, a headline. Ours would be the same mark with a
 * different word under it, and forty near-identical PNGs is forty things to
 * regenerate when the mark changes. One card, and the page's own `og:title`
 * and `og:description` carry what differs. Every unfurler shows those.
 *
 * The mark below is the same geometry and the same gradient as
 * `generate-icons.ts` and `components/layout/logo.tsx`. Change one and change
 * the others.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const OUTPUT = join(process.cwd(), 'apps', 'web', 'public', 'og.png');

/** 1.91:1, which is what every unfurler crops to. Anything else gets cut. */
const WIDTH = 1200;
const HEIGHT = 630;

/**
 * `--canvas` and the text tokens from the dark theme, by value.
 *
 * A generated PNG cannot read a CSS custom property, and a social card has no
 * theme to follow — it is shown on someone else's white or black background,
 * so it has to bring its own. Dark, because that is this product's primary
 * theme and the one every screenshot of it will be in.
 */
const CANVAS = '#0a0a0a';
const FG = '#fafafa';
const FG_MUTED = '#adadad';
const LINE = '#1f1f1f';

/**
 * The font stack, resolved by fontconfig when librsvg rasterises this.
 *
 * The site ships Geist, which is not installed on a build machine — so this
 * names the grotesques that are, in the order that best matches it. The card
 * is a wordmark and two lines of text; a half-step difference in the grotesque
 * is invisible at this size, and embedding a webfont to close it would put a
 * font file in the repository for one image.
 */
const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

function svg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="mark" x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1c1c1c"/>
      <stop offset="1" stop-color="#000000"/>
    </linearGradient>

    <!-- The glow went achromatic with the mark. A blue halo behind a black chip
         is the old palette outliving the logo that justified it; white at 7%
         does the same job of lifting the top of the card off flat #0a0a0a. -->
    <radialGradient id="glow" cx="0.5" cy="0" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.025"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>

    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M64 0H0V64" fill="none" stroke="${LINE}" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="${CANVAS}"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>

  <!-- The mark, drawn in the favicon's own 32-unit box and scaled ×4, so the
       card and the tab icon are the same file's geometry rather than two
       transcriptions of it. The hairline is a quarter-unit here: at ×4 a full
       unit would be a 4px band, which is a border rather than a sheen. -->
  <g transform="translate(96 132) scale(4)">
    <rect width="32" height="32" rx="9" fill="url(#mark)"/>
    <rect x="0.125" y="0.125" width="31.75" height="31.75" rx="8.875" fill="none" stroke="#ffffff" stroke-opacity="0.13" stroke-width="0.25"/>
    <path fill="#fafafa" d="M25.9 25.9L23.07 26.18L17.98 21.09L17.84 17.84L21.09 17.98L26.18 23.07ZM25.9 6.1L26.18 8.93L21.09 14.02L17.84 14.16L17.98 10.91L23.07 5.82ZM6.1 6.1L8.93 5.82L14.02 10.91L14.16 14.16L10.91 14.02L5.82 8.93ZM6.1 25.9L5.82 23.07L10.91 17.98L14.16 17.84L14.02 21.09L8.93 26.18Z"/>
  </g>

  <text x="248" y="222" font-family="${FONT}" font-size="86" font-weight="600"
        letter-spacing="-3" fill="${FG}">xecret</text>

  <text x="96" y="360" font-family="${FONT}" font-size="58" font-weight="600"
        letter-spacing="-1.8" fill="${FG}">Secret management that</text>
  <text x="96" y="428" font-family="${FONT}" font-size="58" font-weight="600"
        letter-spacing="-1.8" fill="${FG}">gets out of your way.</text>

  <text x="96" y="500" font-family="${FONT}" font-size="30" fill="${FG_MUTED}">Encrypted per environment. Audited on every read. Open source.</text>

  <rect x="96" y="546" width="1008" height="1" fill="${LINE}"/>
  <text x="96" y="592" font-family="${FONT}" font-size="26" fill="${FG_MUTED}">xecret run -- npm run dev</text>
  <text x="1104" y="592" text-anchor="end" font-family="${FONT}" font-size="26" fill="${FG_MUTED}">AGPL-3.0 · Powered by Playxoft</text>
</svg>`;
}

async function main(): Promise<void> {
  const png = await sharp(Buffer.from(svg())).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(OUTPUT, png);
  console.warn(`  og.png          ${png.byteLength} bytes  ${WIDTH}×${HEIGHT}`);
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
