#!/usr/bin/env -S npx tsx
/**
 * The application icon, and the three files browsers ask for.
 *
 *   npm run icons
 *
 * ── Why this is generated rather than hand-committed ──
 * A favicon set is one design in four sizes and three container formats. Drawn
 * once by hand it drifts: somebody adjusts the SVG, the `.ico` keeps the old
 * mark, and half the browsers show a logo the other half retired a year ago.
 * The mark below is the single source, and every artefact falls out of it — so
 * changing the gradient is a one-line edit followed by one command.
 *
 * ── What is written ──
 *   app/icon.svg        the mark itself. Modern browsers prefer it: one file,
 *                       crisp at every density, no raster at all.
 *   app/favicon.ico     16/32/48, for `/favicon.ico` requests and for the
 *                       browsers and crawlers that still only look there.
 *   app/apple-icon.png  180×180 for an iOS home screen.
 *
 * Next.js picks all three up by file convention — see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/app-icons.md`.
 * There is no `icons` entry in `metadata` and there should not be; adding one
 * would override the convention and give two places to keep in step.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

// Resolved from the working directory rather than from `import.meta.url`: the
// other scripts here run through tsx's CommonJS output, where that is not
// available. `npm run` always executes from the repository root.
const APP_DIR = join(process.cwd(), 'apps', 'web', 'src', 'app');

/**
 * The gradient.
 *
 * Anchored on the product's accent — `--accent` is `#2ac9e0` in dark — and
 * carried down into a deep blue, so the tab icon reads as part of the same
 * family as the interface rather than as a sticker applied to it. Three stops
 * rather than two: a straight cyan→indigo interpolation passes through a muddy
 * middle, and the extra stop holds it in the blues the whole way.
 */
const STOPS = [
  { offset: 0, color: '#3ad4ec' },
  { offset: 0.55, color: '#2380e2' },
  { offset: 1, color: '#2a3fd0' },
];

/**
 * The mark: a gradient chip carrying a white X.
 *
 * A filled chip rather than a bare glyph, because 16px is the size that decides
 * this. A two-stroke X floating on transparency disappears into a light tab
 * strip at one end and a dark one at the other; a chip gives the mark its own
 * ground and reads at any tab-bar colour. The X is white for the same reason —
 * it is the only fill that holds against every stop of the gradient beneath it.
 *
 * The arms reach almost to the chip's corners and the stroke is a tenth of the
 * box, and both numbers were settled at 16px rather than at a comfortable
 * preview size. A thicker, shorter X — the obvious first draft — closes its own
 * counters when it lands on a 16-pixel grid and reads as a blob with a dent in
 * it. Long arms and a thin stroke keep the four triangles of negative space
 * open, which is the whole of what makes an X legible that small.
 *
 * @param radius Corner rounding. `0` for the Apple icon, which iOS masks with
 *   its own squircle — rounding it here would round it twice and leave a pale
 *   fringe inside the mask.
 */
function mark(radius: number): string {
  const stops = STOPS.map(
    ({ offset, color }) => `<stop offset="${offset}" stop-color="${color}"/>`,
  ).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="xecret">
  <defs>
    <linearGradient id="xecret-mark" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">${stops}</linearGradient>
  </defs>
  <rect width="32" height="32" rx="${radius}" fill="url(#xecret-mark)"/>
  <path d="M8.5 8.5L23.5 23.5M23.5 8.5L8.5 23.5" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round"/>
</svg>
`;
}

/** The chip's corner radius, a quarter of the box — the same proportion as `LogoMark`. */
const RADIUS = 8;

async function png(svg: string, size: number): Promise<Buffer> {
  // `density` scales the SVG before rasterising. Without it sharp renders the
  // 32-unit viewBox at its nominal size and upsamples, which turns a 180px
  // Apple icon into a blurred 32px one.
  return sharp(Buffer.from(svg), { density: (72 * size) / 32 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Packs PNGs into an `.ico`.
 *
 * A PNG payload inside an ICO container, which every browser since IE11 reads
 * and which keeps the file a tenth the size of the equivalent uncompressed
 * bitmaps. Written out here because it is forty bytes of header per image and
 * the alternative is a dependency that does this and nothing else.
 */
function ico(images: readonly { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, data }, index) => {
    const entry = 16 * index;
    // A zero byte means 256: the field is one byte and 256 does not fit.
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size; 0 for truecolour
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map(({ data }) => data)]);
}

async function main(): Promise<void> {
  await mkdir(APP_DIR, { recursive: true });

  const rounded = mark(RADIUS);

  // 16 for the tab, 32 for hidpi tabs and bookmarks, 48 for Windows' task bar
  // and for the crawlers that pick the largest frame they find.
  const sizes = [16, 32, 48];
  const frames = await Promise.all(
    sizes.map(async (size) => ({ size, data: await png(rounded, size) })),
  );

  // Full-bleed for Apple: iOS applies its own squircle mask.
  const written: readonly [string, Buffer | string][] = [
    ['icon.svg', rounded],
    ['favicon.ico', ico(frames)],
    ['apple-icon.png', await png(mark(0), 180)],
  ];

  for (const [name, data] of written) {
    await writeFile(join(APP_DIR, name), data);
    console.warn(`  ${name.padEnd(16)} ${Buffer.byteLength(data)} bytes`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
