// SPDX-License-Identifier: Apache-2.0
import { renderStyle } from "@ccgrapher/core";
import { DEFAULT_METRICS, type Point, type PositionedEdge, type PositionedGraph, type PositionedNode } from "@ccgrapher/layout";
// The `bin/` ESM build uses extensionless relative imports, which Node's
// resolver rejects outside a bundler. The bundled build is a single file with
// no internal imports, so it loads headlessly. Types still come from `bin/`.
import rough from "roughjs/bundled/rough.esm.js";
import type { RoughGenerator } from "roughjs/bin/generator.js";
import type { Drawable, OpSet } from "roughjs/bin/core.js";
import { CAVEAT_NOTICE, caveatFontFace } from "./font.js";
import { iconPath, iconTransform } from "./icons.js";
import { DEFAULT_THEME, type Theme } from "./theme.js";

export interface RenderOptions {
  readonly theme?: Partial<Theme>;
  /** Draw these edges as dead: dashed, red, labelled. */
  readonly fakeEdges?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** Name + goal caption above the diagram. On by default. */
  readonly header?: boolean;
  /** Inline the bundled Caveat face so the file is self-contained. On by default. */
  readonly embedFont?: boolean;
  /**
   * The paper texture. On by default. It is per-pixel noise, so it costs almost
   * nothing in an SVG but defeats PNG compression entirely — turn it off when
   * the SVG is destined for a rasteriser.
   */
  readonly grain?: boolean;
  /** Overrides the spec name in the header. */
  readonly title?: string;
}

const HEADER_HEIGHT = 92;
const ICON_SIZE = 15;
const HEADER_X = 40;
/** Rough advance width per character for the handwriting faces we target. */
const HEADER_CHAR_RATIO = 0.47;

export function renderSvg(positioned: PositionedGraph, options: RenderOptions = {}): string {
  const theme: Theme = { ...DEFAULT_THEME, ...options.theme };
  const showHeader = options.header ?? true;
  const grain = options.grain ?? true;
  const gen = rough.generator();

  const fake = new Set((options.fakeEdges ?? []).map((e) => `${e.from}->${e.to}`));
  const offsetY = showHeader ? HEADER_HEIGHT : 0;

  // A long goal line can be wider than the graph it captions, so the canvas
  // has to account for it or the text runs off the edge.
  const title = options.title ?? positioned.graph.spec.name;
  const width = showHeader
    ? Math.max(positioned.width, headerWidth(title, positioned.graph.spec.goal, theme))
    : positioned.width;
  const height = positioned.height + offsetY;

  const body = [
    ...positioned.edges.map((edge) => renderEdge(gen, edge, theme, fake.has(`${edge.from}->${edge.to}`))),
    ...positioned.nodes.map((node) => renderNode(gen, node, theme)),
  ].join("\n    ");

  const fontFace = (options.embedFont ?? true) ? caveatFontFace() : null;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escapeAttr(theme.fontFamily)}">`,
    // The font is only redistributed when it is actually embedded, so the
    // notice appears only then.
    fontFace ? `  <!-- ${CAVEAT_NOTICE} -->` : "",
    `  <defs>`,
    fontFace ? `    <style>${fontFace}</style>` : "",
    grain
      ? [
          `    <filter id="grain" x="0" y="0" width="100%" height="100%">`,
          `      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" stitchTiles="stitch" result="n"/>`,
          `      <feColorMatrix in="n" type="saturate" values="0"/>`,
          `      <feComponentTransfer><feFuncA type="linear" slope="0.05"/></feComponentTransfer>`,
          `    </filter>`,
        ].join("\n")
      : "",
    `  </defs>`,
    `  <rect width="${width}" height="${height}" fill="${theme.paper}"/>`,
    grain ? `  <rect width="${width}" height="${height}" filter="url(#grain)"/>` : "",
    showHeader ? renderHeader(gen, positioned, theme, options.title) : "",
    `  <g transform="translate(0 ${offsetY})">`,
    `    ${body}`,
    `  </g>`,
    `</svg>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function headerWidth(title: string, goal: string | undefined, theme: Theme): number {
  const line = (text: string, size: number) => text.length * size * HEADER_CHAR_RATIO;
  return (
    Math.ceil(Math.max(line(title, theme.titleSize), goal ? line(goal, theme.goalSize) : 0)) +
    HEADER_X * 2
  );
}

function renderHeader(
  gen: RoughGenerator,
  positioned: PositionedGraph,
  theme: Theme,
  titleOverride?: string,
): string {
  const title = titleOverride ?? positioned.graph.spec.name;
  const goal = positioned.graph.spec.goal;
  const x = HEADER_X;

  // Hand-drawn underline sized to the title, not to the page.
  const underlineWidth = Math.max(90, title.length * theme.titleSize * 0.46);
  const underline = gen.line(x, 52, x + underlineWidth, 52, {
    stroke: theme.accent,
    strokeWidth: 3,
    roughness: 1.6,
    bowing: 2,
    seed: seedOf(title),
  });

  return [
    `  <g>`,
    `    <text x="${x}" y="44" font-size="${theme.titleSize}" fill="${theme.ink}">${escapeText(title)}</text>`,
    `    ${drawableToSvg(gen, underline, { stroke: theme.accent, strokeWidth: 3 })}`,
    goal
      ? `    <text x="${x}" y="76" font-size="${theme.goalSize}" fill="${theme.muted}">${escapeText(goal)}</text>`
      : "",
    `  </g>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderNode(gen: RoughGenerator, positioned: PositionedNode, theme: Theme): string {
  const { node, x, y, width, height, lines } = positioned;
  const style = renderStyle(node);
  const fill = theme.fill[node.kind];
  const seed = seedOf(node.id);
  const parts: string[] = [];

  // A fanOut node is one node that runs many times, so it draws as a stack.
  if (node.fanOut) {
    const off = 5;
    for (let i = 2; i >= 1; i--) {
      parts.push(
        `<rect x="${r(x + off * i)}" y="${r(y - off * i)}" width="${r(width - off * 2)}" height="${r(height - off * 2)}" fill="${fill}" stroke="${theme.ink}" stroke-width="1.2" opacity="${0.45 / i}"/>`,
      );
    }
  }

  // An isolated worktree gets a dashed halo — its writes cannot collide.
  if (node.worktree) {
    parts.push(
      `<rect x="${r(x - 5)}" y="${r(y - 5)}" width="${r(width + 10)}" height="${r(height + 10)}" fill="none" stroke="${theme.muted}" stroke-width="1" stroke-dasharray="3 4" opacity="0.8"/>`,
    );
  }

  const boxW = node.fanOut ? width - 10 : width;
  const boxH = node.fanOut ? height - 10 : height;

  if (style === "agent") {
    // Sketchy: this one costs tokens.
    const box = gen.rectangle(x, y, boxW, boxH, {
      stroke: theme.ink,
      strokeWidth: 1.9,
      fill,
      fillStyle: "solid",
      roughness: theme.roughness,
      bowing: theme.bowing,
      seed,
    });
    parts.push(drawableToSvg(gen, box, { stroke: theme.ink, strokeWidth: 1.9, fill }));
  } else {
    // Sharp corners: plain code, or a human gate. No model, no tokens.
    const dash = style === "human" ? ` stroke-dasharray="7 4"` : "";
    parts.push(
      `<rect x="${r(x)}" y="${r(y)}" width="${r(boxW)}" height="${r(boxH)}" fill="${fill}" stroke="${theme.ink}" stroke-width="1.6"${dash}/>`,
    );
  }

  // Icon, left-aligned in its gutter and vertically centred.
  const iconX = x + 11;
  const iconY = y + boxH / 2 - ICON_SIZE / 2;
  parts.push(
    `<g transform="${iconTransform(iconX, iconY, ICON_SIZE)}" fill="none" stroke="${style === "agent" ? theme.accent : theme.muted}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPath(node.kind)}"/></g>`,
  );

  // Label, centred in the space left of the gutter.
  const textLeft = x + DEFAULT_METRICS.iconGutter;
  const centreX = textLeft + (boxW - DEFAULT_METRICS.iconGutter) / 2;
  const totalText = lines.length * DEFAULT_METRICS.lineHeight;
  const firstBaseline = y + boxH / 2 - totalText / 2 + DEFAULT_METRICS.lineHeight * 0.75;

  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${r(centreX)}" y="${r(firstBaseline + i * DEFAULT_METRICS.lineHeight)}">${escapeText(line)}</tspan>`,
    )
    .join("");
  parts.push(
    `<text font-size="${DEFAULT_METRICS.fontSize}" fill="${theme.ink}" text-anchor="middle">${tspans}</text>`,
  );

  if (node.fanOut) {
    const badge = `x${node.fanOut.cap ?? "n"}`;
    parts.push(
      `<text x="${r(x + boxW - 8)}" y="${r(y + 17)}" font-size="15" fill="${theme.accent}" text-anchor="end">${escapeText(badge)}</text>`,
    );
  }

  return `<g data-node="${escapeAttr(node.id)}" data-kind="${node.kind}" data-rank="${positioned.rank}">${parts.join("")}</g>`;
}

function renderEdge(
  gen: RoughGenerator,
  positioned: PositionedEdge,
  theme: Theme,
  isFake: boolean,
): string {
  const points = positioned.points;
  if (points.length < 2) return "";

  const colour = isFake ? theme.danger : theme.accent;
  const seed = seedOf(`${positioned.from}->${positioned.to}`);

  const line = gen.linearPath(
    points.map((p) => [p.x, p.y] as [number, number]),
    {
      stroke: colour,
      strokeWidth: isFake ? 1.6 : 2,
      roughness: isFake ? 0.6 : 1.1,
      bowing: 1,
      seed,
      ...(isFake && { strokeLineDash: [7, 5] }),
    },
  );

  const parts = [drawableToSvg(gen, line, { stroke: colour, strokeWidth: isFake ? 1.6 : 2 })];
  parts.push(arrowHead(points, colour));

  if (isFake) {
    const mid = points[Math.floor(points.length / 2)]!;
    parts.push(
      `<text x="${r(mid.x + 8)}" y="${r(mid.y)}" font-size="14" fill="${theme.danger}">carries no data</text>`,
    );
  }

  const carries = positioned.edge.carries.join(", ");
  return `<g data-edge="${escapeAttr(`${positioned.from}->${positioned.to}`)}"${carries ? ` data-carries="${escapeAttr(carries)}"` : ""}${isFake ? ` data-fake="true"` : ""}>${parts.join("")}</g>`;
}

/** Solid triangle at the head, aimed along the last segment. Crisp on purpose. */
function arrowHead(points: readonly Point[], colour: string): string {
  const tip = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
  const size = 9;
  const spread = 0.42;

  const p = (a: number) => `${r(tip.x - size * Math.cos(a))},${r(tip.y - size * Math.sin(a))}`;
  return `<polygon points="${r(tip.x)},${r(tip.y)} ${p(angle - spread)} ${p(angle + spread)}" fill="${colour}"/>`;
}

/**
 * rough.js hands back op sets rather than markup, which is exactly what we want
 * headlessly — no DOM, no jsdom. Fills are emitted before strokes so the sketchy
 * outline sits on top of its own fill.
 */
function drawableToSvg(
  gen: RoughGenerator,
  drawable: Drawable,
  attrs: { stroke: string; strokeWidth: number; fill?: string },
): string {
  const rank = (set: OpSet) => (set.type === "path" ? 1 : 0);
  const sets = [...drawable.sets].sort((a, b) => rank(a) - rank(b));

  return sets
    .map((set) => {
      const d = gen.opsToPath(set);
      switch (set.type) {
        case "fillPath":
          return `<path d="${d}" fill="${attrs.fill ?? "none"}" stroke="none"/>`;
        case "fillSketch":
          return `<path d="${d}" fill="none" stroke="${attrs.fill ?? "none"}" stroke-width="${drawable.options.fillWeight ?? 1}"/>`;
        default: {
          const dash = drawable.options.strokeLineDash;
          return `<path d="${d}" fill="none" stroke="${attrs.stroke}" stroke-width="${attrs.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash.join(" ")}"` : ""}/>`;
        }
      }
    })
    .join("");
}

/** Stable per-element seed so the same spec always renders byte-identically. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 2147483647;
}

const r = (n: number) => Number(n.toFixed(2));

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");
