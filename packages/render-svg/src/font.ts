// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Caveat is licensed under the SIL Open Font License 1.1, which requires the
 * copyright notice and licence to accompany redistributed copies of the font.
 * Embedding the woff2 means every generated SVG *is* a redistribution, so the
 * notice has to travel inside the file rather than sit in the repository.
 */
export const CAVEAT_NOTICE = [
  "Embedded typeface: Caveat. Copyright 2014 The Caveat Project Authors",
  "(https://github.com/googlefonts/caveat). Licensed under the SIL Open Font",
  "License 1.1 - https://scripts.sil.org/OFL. The font is unmodified.",
].join("\n       ");

/**
 * Caveat ships with the package, so a rendered SVG carries its own handwriting
 * face and looks the same on a machine that has never heard of it. Falls back
 * to the family list in the theme if the file cannot be found — the diagram
 * still renders, just in whatever cursive face the viewer has.
 */
export function caveatFontFace(): string | null {
  const data = loadCaveat();
  if (!data) return null;
  return [
    "@font-face{font-family:'Caveat';font-style:normal;font-weight:400;",
    `src:url(data:font/woff2;base64,${data}) format('woff2');}`,
  ].join("");
}

let cached: string | null | undefined;

function loadCaveat(): string | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    const path = require.resolve("@fontsource/caveat/files/caveat-latin-400-normal.woff2");
    cached = readFileSync(path).toString("base64");
  } catch {
    cached = null;
  }
  return cached;
}
