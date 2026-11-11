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

// Wordmark: the mark stands in for the P, followed by "arry" in Instrument Sans Semibold, outlined
// so it renders the same everywhere. The mark's stem spans the cap height and sits on the alphabetic line,
// and the gap to the "a" is the font's own P-to-a spacing, tightened a little.
const fontFile = await readFile(join(root, "node_modules", "@fontsource", "instrument-sans", "files", "instrument-sans-latin-600-normal.woff"));
const font = opentype.parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
const WORD_SIZE = 100;
const wordOptions = { kerning: true, letterSpacing: -0.02 };
// Serialised by hand: opentype's own serialiser prints NaN for values that round to zero.
const r2 = (v) => {
  const n = Math.round(v * 100) / 100;
  return Object.is(n, -0) ? "0" : String(n);
};
// Glyph-by-glyph layout with the font's advances and kerning (opentype's text shaper does not
// support every substitution table this font carries).
const unit = WORD_SIZE / font.unitsPerEm;
function layout(text, x, y) {
  const glyphs = [...text].map((ch) => font.charToGlyph(ch));
  const paths = [];
  let pen = x;
  glyphs.forEach((g, i) => {
    paths.push(g.getPath(pen, y, WORD_SIZE));
    const kern = i + 1 < glyphs.length ? font.getKerningValue(g, glyphs[i + 1]) : 0;
    pen += (g.advanceWidth + kern) * unit + wordOptions.letterSpacing * WORD_SIZE;
  });
  return paths;
}
function box(text, x = 0, y = 0) {
  const bb = layout(text, x, y).map((p) => p.getBoundingBox());
  return { x1: Math.min(...bb.map((b) => b.x1)), y1: Math.min(...bb.map((b) => b.y1)), x2: Math.max(...bb.map((b) => b.x2)), y2: Math.max(...bb.map((b) => b.y2)) };
}
function pathData(text, x, y) {
  let last = "";
  return layout(text, x, y)
    .flatMap((p) => p.commands)
    .map((c) => {
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
}
// Metrics on the alphabetic line (y = 0, negative is up).
const capHeight = -box("P").y1;
const pBox = box("P");
const aStart = box("Pa").x2 - box("a").x2; // the pen position of "a" after "P"
const naturalGap = aStart + box("a").x1 - pBox.x2;
// The mark's visible box on its 32 unit grid.
const VISIBLE = { x1: 7.25, y1: 5, x2: 24.75, y2: 27 };
const markScale = capHeight / (VISIBLE.y2 - VISIBLE.y1);
const markW = (VISIBLE.x2 - VISIBLE.x1) * markScale;
const gap = naturalGap * 0.82;
const restBox = box("arry");
// Layout: the mark's left ink edge at x = 0, the type's alphabetic line at y = capHeight (top of box at
// the cap line), so the box spans the cap line to the descender of the "y"s.
const restX = markW + gap - restBox.x1;
const rest = pathData("arry", restX, capHeight);
const wordW = Math.round((markW + gap + (restBox.x2 - restBox.x1)) * 100) / 100;
const wordH = Math.round((capHeight + restBox.y2) * 100) / 100;
const lineFromTop = Math.round(capHeight * 100) / 100;
const markTransform = { x: Number(r2(-VISIBLE.x1 * markScale)), y: Number(r2(-VISIBLE.y1 * markScale)), scale: Number(markScale.toFixed(4)) };
const wordmarkInner = (shapes) =>
  `<g transform="translate(${markTransform.x} ${markTransform.y}) scale(${markTransform.scale})">${shapes}</g>`;

const header = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
await mkdir(join(root, "public", "brand"), { recursive: true });
await mkdir(join(root, "public", "icons"), { recursive: true });

// Standalone files.
await writeFile(
  join(root, "public", "brand", "parry-mark.svg"),
  `${header}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Parry">${adaptiveStyle()}${adaptiveMarkShapes()}</svg>\n`,
);
// The wordmark is the lockup: the mark is its first letter.
const wordmarkSvg = `${header}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wordW} ${wordH}" width="${wordW}" height="${wordH}" role="img" aria-label="Parry">${adaptiveStyle()}${wordmarkInner(adaptiveMarkShapes())}<path class="t" d="${rest}"/></svg>\n`;
await writeFile(join(root, "public", "brand", "parry-wordmark.svg"), wordmarkSvg);
await writeFile(join(root, "public", "brand", "parry-logo.svg"), wordmarkSvg);

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

/** The mark's visible box on its 32 unit grid, for optical alignment. */
export const MARK_VISIBLE = ${JSON.stringify(VISIBLE)} as const;

/**
 * The wordmark: the mark as the P, then "arry". The box runs from the cap line to the descender;
 * \`line\` is the alphabetic line's distance from the top. \`mark\` places the 32 unit mark in the box.
 */
export const WORDMARK = {
  width: ${wordW},
  height: ${wordH},
  line: ${lineFromTop},
  mark: ${JSON.stringify(markTransform)},
  rest: ${JSON.stringify(rest)},
} as const;
`,
);

console.log(`brand: wordmark ${wordW}x${wordH} (gap ${gap.toFixed(1)}), icons written`);
