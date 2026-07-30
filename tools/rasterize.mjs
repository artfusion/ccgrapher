// SPDX-License-Identifier: Apache-2.0
/**
 * Rasterises the SVGs in docs/ to PNG for the README.
 *
 * GitHub serves repository SVGs under `default-src 'none'`, which blocks the
 * data-URI font our renderer embeds — the diagram would arrive with the
 * handwriting face silently swapped for a system default. So the README points
 * at PNGs rasterised here, while the SVGs stay committed alongside for anyone
 * who wants to open the real thing.
 *
 * resvg also ignores a base64 `@font-face`, so the Caveat woff2 that
 * `@fontsource/caveat` already ships is decompressed to a TTF in memory and
 * handed over as a real font file. Nothing is downloaded and nothing binary is
 * committed.
 *
 *   node tools/rasterize.mjs
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { decompress } from "wawoff2";

const DIR = "docs";
/** 2x so the images stay sharp on a retina display. */
const SCALE = 2;

const require = createRequire(import.meta.url);

/** Caveat as a TTF resvg can actually load, derived from the woff2 we depend on. */
async function caveatTtf() {
  // The font belongs to render-svg, so resolve it from there rather than the
  // workspace root — pnpm's isolated layout does not hoist it.
  const woff2 = readFileSync(
    require.resolve("@fontsource/caveat/files/caveat-latin-400-normal.woff2", {
      paths: ["packages/render-svg"],
    }),
  );
  const ttf = await decompress(woff2);
  const path = join(mkdtempSync(join(tmpdir(), "ccg-font-")), "Caveat-Regular.ttf");
  writeFileSync(path, ttf);
  return path;
}

const fontPath = await caveatTtf();

const svgs = readdirSync(DIR)
  .filter((f) => f.endsWith(".svg"))
  .sort();

if (svgs.length === 0) {
  console.error(`no SVGs in ${DIR}/ — run \`ccg render\` first`);
  process.exit(1);
}

for (const name of svgs) {
  const source = readFileSync(join(DIR, name), "utf8");
  const width = Number(/<svg[^>]*width="(\d+)"/.exec(source)?.[1] ?? 800);

  const resvg = new Resvg(source, {
    fitTo: { mode: "width", value: width * SCALE },
    font: {
      fontFiles: [fontPath],
      loadSystemFonts: false,
      defaultFontFamily: "Caveat",
    },
  });

  const png = resvg.render().asPng();
  const out = join(DIR, name.replace(/\.svg$/, ".png"));
  writeFileSync(out, png);
  console.log(`${out.padEnd(38)} ${width * SCALE}px wide, ${(png.length / 1024).toFixed(0)} kB`);
}
