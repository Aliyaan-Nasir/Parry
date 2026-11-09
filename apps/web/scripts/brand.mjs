// Generates every brand asset from one geometry: the mark (a P cut into a stem and a guard),
// the outlined wordmark, the lockup, the favicons, the apple-touch icon and the PWA icons.
//
//   pnpm --filter @parry/web icons
//
// Outputs are committed. Edit this file, run it, then look at every image it writes.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(await readFile(join(root, "..", "..", "packages", "brand", "tokens.json"), "utf8"));
const light = tokens.light;
const dark = tokens.dark;

// The mark, on a 32 unit grid: a P cut in two. The stem is the position, the half-disc is the
// guard raised beside it. Two flat shapes, ink and brass, centred on the grid.
const MARK = {
  stem: { x: 7.25, y: 5, width: 5, height: 22, rx: 2.5 },
  guard: "M14.25 5H17.25A7.5 7.5 0 0 1 17.25 20H14.25Z",
};

function markShapes(fg, metal) {
  const { x, y, width, height, rx } = MARK.stem;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${fg}"/><path d="${MARK.guard}" fill="${metal}"/>`;
}

// Class based shapes so one SVG file can switch colors with the viewer's color scheme.
function adaptiveMarkShapes() {
  const { x, y, width, height, rx } = MARK.stem;
  return `<rect class="t" x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}"/><path class="m" d="${MARK.guard}"/>`;
}

function adaptiveStyle() {
  return (
    `<style>.t{fill:${light.text}}.m{fill:${light.mark}}` +
    `@media (prefers-color-scheme:dark){.t{fill:${dark.text}}.m{fill:${dark.mark}}}</style>`
  );
}

// Wordmark: "Parry" in Manrope Bold, outlined so it renders the same everywhere.
const fontFile = await readFile(join(root, "node_modules", "@fontsource", "manrope", "files", "manrope-latin-700-normal.woff"));
const font = opentype.parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
const WORD_SIZE = 100;
const wordOptions = { kerning: true, letterSpacing: -0.03 };
const probe = font.getPath("Parry", 0, 0, WORD_SIZE, wordOptions).getBoundingBox();
const x1 = probe.x1;
const y1 = probe.y1;
// Serialised by hand: opentype's own serialiser prints NaN for values that round to zero.
const r2 = (v) => {
  const n = Math.round(v * 100) / 100;
  return Object.is(n, -0) ? "0" : String(n);
};
let last = "";
const word = font
  .getPath("Parry", -x1, -y1, WORD_SIZE, wordOptions)
  .commands.map((c) => {
    const here = c.type === "Z" ? "" : `${r2(c.x)} ${r2(c.y)}`;
    const prev = last;
    last = here;
    if (c.type === "L" && here === prev) return "";
    if (c.type === "M" || c.type === "L") return `${c.type}${here}`;
    if (c.type === "Q") return `Q${r2(c.x1)} ${r2(c.y1)} ${r2(c.x)} ${r2(c.y)}`;
    if (c.type === "C") return `C${r2(c.x1)} ${r2(c.y1)} ${r2(c.x2)} ${r2(c.y2)} ${r2(c.x)} ${r2(c.y)}`;
    return "Z";
  })
  .join("");
const wordW = Math.round((probe.x2 - x1) * 100) / 100;
const wordH = Math.round((probe.y2 - y1) * 100) / 100;
// Distance from the top of the box to the alphabetic line (the bottom of "P").
const lineFromTop = Math.round((0 - y1) * 100) / 100;

const header = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
await mkdir(join(root, "public", "brand"), { recursive: true });
await mkdir(join(root, "public", "icons"), { recursive: true });

// Standalone files.
await writeFile(
  join(root, "public", "brand", "parry-mark.svg"),
  `${header}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Parry">${adaptiveStyle()}${adaptiveMarkShapes()}</svg>\n`,
);
await writeFile(
  join(root, "public", "brand", "parry-wordmark.svg"),
  `${header}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wordW} ${wordH}" width="${wordW}" height="${wordH}" role="img" aria-label="Parry">${adaptiveStyle()}<path class="t" d="${word}"/></svg>\n`,
);
// Lockup: the mark's visible box is a little taller than the cap height and centred on it.
const VISIBLE = { x1: 7.25, y1: 5, x2: 24.75, y2: 27 };
const capHeight = lineFromTop;
const lockScale = (capHeight * 1.12) / (VISIBLE.y2 - VISIBLE.y1);
const markTop = capHeight / 2 - ((VISIBLE.y1 + VISIBLE.y2) / 2) * lockScale;
const markLeft = -VISIBLE.x1 * lockScale;
const gap = capHeight * 0.22;
const wordX = (VISIBLE.x2 - VISIBLE.x1) * lockScale + gap;
const topEdge = Math.min(0, markTop + VISIBLE.y1 * lockScale);
const bottomEdge = Math.max(wordH, markTop + VISIBLE.y2 * lockScale);
const lockW = Math.ceil(wordX + wordW + 1);
const lockH = Math.ceil(bottomEdge - topEdge + 1);
const dy = -topEdge + 0.5;
await writeFile(
  join(root, "public", "brand", "parry-logo.svg"),
  `${header}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lockW} ${lockH}" width="${lockW}" height="${lockH}" role="img" aria-label="Parry">${adaptiveStyle()}<g transform="translate(${r2(markLeft)} ${r2(markTop + dy)}) scale(${lockScale.toFixed(4)})">${adaptiveMarkShapes()}</g><path class="t" transform="translate(${r2(wordX)} ${r2(dy)})" d="${word}"/></svg>\n`,
);

// Favicon (SVG): transparent, follows the browser's color scheme.
await writeFile(
  join(root, "app", "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">${adaptiveStyle()}${adaptiveMarkShapes()}</svg>\n`,
);

// Raster icons sit on an ink tile with bone and brass.
function tile({ size, radius, inset }) {
  const s = (size * (1 - inset * 2)) / 32;
  const o = size * inset;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${radius}" fill="${dark.bg}"/>` +
      `<g transform="translate(${o} ${o}) scale(${s})">${markShapes(dark.text, dark.mark)}</g></svg>`,
  );
}
async function png(svg, size) {
  return sharp(svg, { density: 72 * 8 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

const icoSizes = [16, 32, 48];
const icoImages = await Promise.all(
  icoSizes.map((size) => png(tile({ size, radius: size * 0.2, inset: size <= 16 ? 0.02 : 0.06 }), size)),
);
// ICO container with PNG payloads.
const headerBuf = Buffer.alloc(6 + icoSizes.length * 16);
headerBuf.writeUInt16LE(0, 0);
headerBuf.writeUInt16LE(1, 2);
headerBuf.writeUInt16LE(icoSizes.length, 4);
let offset = headerBuf.length;
icoSizes.forEach((size, i) => {
  const e = 6 + i * 16;
  headerBuf.writeUInt8(size === 256 ? 0 : size, e);
  headerBuf.writeUInt8(size === 256 ? 0 : size, e + 1);
  headerBuf.writeUInt8(0, e + 2);
  headerBuf.writeUInt8(0, e + 3);
  headerBuf.writeUInt16LE(1, e + 4);
  headerBuf.writeUInt16LE(32, e + 6);
  headerBuf.writeUInt32LE(icoImages[i].length, e + 8);
  headerBuf.writeUInt32LE(offset, e + 12);
  offset += icoImages[i].length;
});
await writeFile(join(root, "app", "favicon.ico"), Buffer.concat([headerBuf, ...icoImages]));

// Apple touch icon: full bleed, iOS rounds the corners itself.
await writeFile(join(root, "app", "apple-icon.png"), await png(tile({ size: 180, radius: 0, inset: 0.14 }), 180));
// PWA icons: rounded "any" icons and full bleed maskable icons (mark inside the 80% safe circle).
for (const size of [192, 512]) {
  await writeFile(join(root, "public", "icons", `icon-${size}.png`), await png(tile({ size, radius: size * 0.22, inset: 0.12 }), size));
  await writeFile(join(root, "public", "icons", `icon-maskable-${size}.png`), await png(tile({ size, radius: 0, inset: 0.24 }), size));
}

// Path data for React components and the Open Graph images.
await writeFile(
  join(root, "components", "brand", "paths.ts"),
  `// Generated by scripts/brand.mjs from the brand geometry. Do not edit by hand; edit the script and run \`pnpm icons\`.
export const MARK = ${JSON.stringify(MARK, null, 2)} as const;

export const WORDMARK = {
  width: ${wordW},
  height: ${wordH},
  /** Distance from the top of the box to the alphabetic line. */
  line: ${lineFromTop},
  d: ${JSON.stringify(word)},
} as const;

/** The mark's visible box on its 32 unit grid, for optical alignment. */
export const MARK_VISIBLE = ${JSON.stringify(VISIBLE)} as const;

export const LOCKUP = {
  width: ${lockW},
  height: ${lockH},
  mark: { x: ${r2(markLeft)}, y: ${r2(markTop + dy)}, scale: ${lockScale.toFixed(4)} },
  word: { x: ${r2(wordX)}, y: ${r2(dy)} },
} as const;
`,
);

console.log(`brand: wordmark ${wordW}x${wordH}, lockup ${lockW}x${lockH}, icons written`);
