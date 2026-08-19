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
 * The chip's gradient.
 *
 * Achromatic, and shallow: #1c1c1c down to black. The mark used to run cyan
 * into indigo, which made it the last saturated thing in a product whose
 * palette is now pure grey. Flat black would be the honest end of that, except
 * that flat black on our own #0a0a0a canvas is a chip with no edges — so the
 * sheen and the hairline below stay, and they are the only reason one drawing
 * works on a white tab strip and on the application's own dark shell.
 */
const STOPS = [
  { offset: 0, color: '#1c1c1c' },
  { offset: 1, color: '#000000' },
];

/**
 * The blades: a crosshair turned onto the diagonals.
 *
 * Four marks pointed at both ends, stopping 2.6 units short of the centre so
 * they never touch — the 5.2-unit gap between the tips is the mark. Each blade
 * is 4.4 wide and reaches 14 units out, and the outer points are shallower than
 * the inner ones (1.8 against 2.4), because matched points turn a blade into a
 * leaf and four leaves read as a flower rather than a crosshair.
 *
 * Every number here was chosen at 16px rather than at a comfortable preview
 * size. The gap is the part that decides it: wider and the four blades read as
 * four separate ticks in a tab strip instead of one X; this is the width where
 * they cohere and the gap is still visibly a gap.
 */
const BLADES =
  'M25.9 25.9L23.07 26.18L17.98 21.09L17.84 17.84L21.09 17.98L26.18 23.07ZM25.9 6.1L26.18 8.93L21.09 14.02L17.84 14.16L17.98 10.91L23.07 5.82ZM6.1 6.1L8.93 5.82L14.02 10.91L14.16 14.16L10.91 14.02L5.82 8.93ZM6.1 25.9L5.82 23.07L10.91 17.98L14.16 17.84L14.02 21.09L8.93 26.18Z';

/**
 * The mark: a black chip carrying the blades in white.
 *
 * A filled chip rather than a bare glyph, because 16px is the size that decides
 * this. Four blades floating on transparency disappear into a light tab strip
 * at one end and a dark one at the other; a chip gives the mark its own ground
 * and reads at any tab-bar colour.
 *
 * @param radius Corner rounding. `0` for the Apple icon, which iOS masks with
 *   its own squircle — rounding it here would round it twice and leave a pale
 *   fringe inside the mask. That case drops the hairline too: at radius 0 it
 *   runs square into the corners iOS is about to cut off.
 */
function mark(radius: number): string {
  const stops = STOPS.map(
    ({ offset, color }) => `<stop offset="${offset}" stop-color="${color}"/>`,
  ).join('');

  // Inset by half its own width so the hairline lands inside the chip rather
  // than straddling its edge, where a rasteriser would drop half of it.
  const hairline =
    radius > 0
      ? `<rect x="0.5" y="0.5" width="31" height="31" rx="${radius - 0.5}" fill="none" stroke="#ffffff" stroke-opacity="0.13" stroke-width="1"/>`
      : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="xecret">
  <defs>
    <linearGradient id="xecret-mark" x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse">${stops}</linearGradient>
  </defs>
  <rect width="32" height="32" rx="${radius}" fill="url(#xecret-mark)"/>
  ${hairline}
  <path fill="#fafafa" d="${BLADES}"/>
</svg>
`;
}

/** The chip's corner radius. Matches `LogoMark`. */
const RADIUS = 9;

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
