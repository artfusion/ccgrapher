// SPDX-License-Identifier: Apache-2.0
import {
  agentTag,
  agentTypes,
  effectivePriorities,
  priorityCaption,
  renderStyle,
  stepLegend,
  type EffectivePriority,
} from "@ccgrapher/core";
import { DEFAULT_METRICS, type Point, type PositionedEdge, type PositionedGraph, type PositionedNode, type PositionedRegion } from "@ccgrapher/layout";
// The `bin/` ESM build uses extensionless relative imports, which Node's
// resolver rejects outside a bundler. The bundled build is a single file with
// no internal imports, so it loads headlessly. Types still come from `bin/`.
import rough from "roughjs/bundled/rough.esm.js";
import type { RoughGenerator } from "roughjs/bin/generator.js";
import type { Drawable, OpSet } from "roughjs/bin/core.js";
import { CAVEAT_NOTICE, caveatFontFace } from "./font.js";
import { iconPath, iconTransform } from "./icons.js";
import { findingsOn, fitCaption, renderSharedWrites, sharedWriteRoutes, type FindingMark } from "./findings.js";
import {
  bottomLeftRoom,
  renderFindingHalo,
  renderMarks,
  priorityDisc,
  priorityWashBox,
  renderPriorityMark,
  renderPriorityWash,
  type Mark,
  type MarkBox,
} from "./marks.js";
import { legendSize, placeStepBadges, renderLegend, renderStepBadges, type Obstacles } from "./steps.js";
import { DEFAULT_THEME, type Theme } from "./theme.js";

export interface RenderOptions {
  readonly theme?: Partial<Theme>;
  /** Draw these edges as dead: dashed, red, labelled. */
  readonly fakeEdges?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /**
   * Fan-ins the linter flagged for their count guard, with the number of results
   * that actually arrive. A node with no `expects` is drawn as missing its guard;
   * one whose `expects` disagrees is drawn as a mismatch. The renderer does not
   * compare the two itself: it draws what lint found.
   */
  readonly guardFindings?: ReadonlyArray<{ readonly id: string; readonly arriving: number }>;
  /**
   * Every other rule's findings, as `renderMarksFor` in `@ccgrapher/lint` builds
   * them: a ring and a caption on the node, or a line between two writers.
   */
  readonly findingMarks?: ReadonlyArray<FindingMark>;
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
  /**
   * Number the steps in execution order, as `stepLegend` in `@ccgrapher/core`
   * numbers them. `"numbers"` puts each number beside its box; `"legend"` also
   * writes the list under the picture, and the canvas grows to hold it. Off by
   * default.
   */
  readonly steps?: "numbers" | "legend";
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
  const arriving = new Map((options.guardFindings ?? []).map((g) => [g.id, g.arriving]));
  const findingMarks = options.findingMarks ?? [];
  const priorities = effectivePriorities(positioned.graph);
  const offsetY = showHeader ? HEADER_HEIGHT : 0;

  // A long goal line can be wider than the graph it captions, so the canvas
  // has to account for it or the text runs off the edge.
  const title = options.title ?? positioned.graph.spec.name;
  const graphWidth = showHeader
    ? Math.max(positioned.width, headerWidth(title, positioned.graph.spec.goal, theme))
    : positioned.width;
  const steps = options.steps ? stepLegend(positioned.graph) : [];
  const legend = options.steps === "legend" ? legendSize(steps) : { width: 0, height: 0 };
  const width = Math.max(graphWidth, regionsWidth(positioned.regions), legend.width);
  const height = positioned.height + offsetY + legend.height;

  const body = [
    ...renderRegions(positioned.regions, theme),
    ...positioned.edges.map((edge) => renderEdge(gen, edge, theme, fake.has(`${edge.from}->${edge.to}`))),
    ...positioned.nodes.map((node) => renderNode(gen, node, theme, arriving.get(node.node.id), findingMarks, priorities.get(node.node.id))),
    ...renderSharedWrites(positioned, findingMarks, theme),
    // Last, so a number is never painted over.
    ...(steps.length > 0
      ? renderStepBadges(
          placeStepBadges(positioned.nodes, steps, obstaclesFor(positioned, fake, findingMarks, priorities), {
            width,
            height: positioned.height,
          }),
          theme,
        )
      : []),
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
    options.steps === "legend" ? renderLegend(steps, positioned.height + offsetY, theme) : "",
    `</svg>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Everything a step number keeps clear of, besides the boxes: what this file draws between them. */
function obstaclesFor(
  positioned: PositionedGraph,
  fake: ReadonlySet<string>,
  findingMarks: readonly FindingMark[],
  priorities: ReadonlyMap<string, EffectivePriority>,
): Obstacles {
  const ratio = DEFAULT_METRICS.charRatio;
  const text = (x: number, y: number, size: number, length: number, anchor: "start" | "middle") => {
    const w = length * size * ratio;
    const x0 = anchor === "middle" ? x - w / 2 : x;
    return { x0, y0: y - size * 0.8, x1: x0 + w, y1: y + size * 0.25 };
  };
  const shared = sharedWriteRoutes(positioned, findingMarks);
  const raised = positioned.nodes.filter((n) => priorities.has(n.id));
  // The urgency disc sits on the urgent step itself; a step that inherits has only the wash.
  const marked = raised.filter((n) => priorities.get(n.id)!.inheritedFrom === undefined);
  const corners = (b: MarkBox) => ({ x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height });
  return {
    lines: [...positioned.edges.map((e) => e.points), ...shared.map((s) => s.route.points)],
    rects: [
      ...positioned.edges
        .filter((e) => fake.has(`${e.from}->${e.to}`) && e.points.length >= 2)
        .map((e) => {
          const mid = e.points[Math.floor(e.points.length / 2)]!;
          return text(mid.x + 8, mid.y, 14, "carries no data".length, "start");
        }),
      ...shared.map((s) => text(s.route.label.x, s.route.label.y - 5, 13, s.label.length, "middle")),
      ...raised.map((n) => corners(priorityWashBox(extentOf(n)))),
      ...marked.map((n) => {
        const disc = priorityDisc(extentOf(n));
        return { x0: disc.cx - disc.r, y0: disc.cy - disc.r, x1: disc.cx + disc.r, y1: disc.cy + disc.r };
      }),
      ...positioned.regions.map((region) => {
        const x = region.x + REGION_CAPTION_INSET - REGION_CAPTION_GAP;
        const w = regionCaption(region).length * REGION_CAPTION_SIZE * ratio + REGION_CAPTION_GAP * 2;
        return { x0: x, y0: region.y - REGION_CAPTION_SIZE / 2, x1: x + w, y1: region.y + REGION_CAPTION_SIZE / 2 };
      }),
    ],
    regions: positioned.regions.map((g) => ({ x0: g.x, y0: g.y, x1: g.x + g.width, y1: g.y + g.height })),
  };
}

/** Everything a node draws: the box, and the fan-out stack up and to its right. */
function extentOf({ node, x, y, width, height }: PositionedNode): MarkBox {
  return node.fanOut ? { x, y: y - 10, width, height } : { x, y, width, height };
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

const REGION_CAPTION_SIZE = 15;
/** Clear of the rounded corner (rx 14), so no stray dash sits before the caption. */
const REGION_CAPTION_INSET = 18;
const REGION_CAPTION_GAP = 5;
/**
 * The paper patch is sized to what Caveat actually sets, about 0.38 of the font
 * size per character. `charRatio` (0.52) is a deliberate overestimate for
 * fitting text inside boxes; used here it would erase dashes the caption does
 * not cover. The canvas check in `regionsWidth` keeps the safe overestimate.
 */
const REGION_CAPTION_RATIO = 0.38;

/** The caption: the boundary's label, or its id, and its access when that claims something. */
function regionCaption(region: PositionedRegion): string {
  const { id, label, access } = region.boundary;
  return access === "read-only" ? `${label ?? id} · read-only` : (label ?? id);
}

/** Where a region's caption ends, so a caption wider than its region still fits the canvas. */
function regionsWidth(regions: readonly PositionedRegion[]): number {
  let right = 0;
  for (const region of regions) {
    const text = regionCaption(region).length * REGION_CAPTION_SIZE * DEFAULT_METRICS.charRatio;
    right = Math.max(right, region.x + REGION_CAPTION_INSET + text + REGION_CAPTION_GAP * 2);
  }
  return Math.ceil(right);
}

/** Every region in one layer, drawn first so it sits behind edges and nodes. */
function renderRegions(regions: readonly PositionedRegion[], theme: Theme): string[] {
  if (regions.length === 0) return [];
  return [`<g data-layer="boundaries">${regions.map((region) => renderRegion(region, theme)).join("")}</g>`];
}

/**
 * A boundary's region: a dashed, rounded rectangle behind its members, with
 * the caption set into the top edge on a patch of paper. Dashes mean structure
 * in this picture, as on a gate or a worktree halo, so this is dashed too; it
 * is told apart from the halo by its rounded corners, longer dashes and the
 * padding the layout gives it. Crisp rather than rough, so it never competes
 * with the nodes it holds.
 */
function renderRegion(region: PositionedRegion, theme: Theme): string {
  const { x, y, width, height } = region;
  const caption = regionCaption(region);
  const textX = x + REGION_CAPTION_INSET;
  const textWidth = caption.length * REGION_CAPTION_SIZE * REGION_CAPTION_RATIO;
  return [
    `<g data-boundary="${escapeAttr(region.boundary.id)}" data-members="${escapeAttr(region.members.join(" "))}">`,
    `<rect x="${r(x)}" y="${r(y)}" width="${r(width)}" height="${r(height)}" rx="14" fill="none" stroke="${theme.boundary}" stroke-width="1.4" stroke-dasharray="12 6"/>`,
    `<rect x="${r(textX - REGION_CAPTION_GAP)}" y="${r(y - REGION_CAPTION_SIZE / 2)}" width="${r(textWidth + REGION_CAPTION_GAP * 2)}" height="${r(REGION_CAPTION_SIZE)}" fill="${theme.paper}"/>`,
    `<text x="${r(textX)}" y="${r(y + REGION_CAPTION_SIZE * 0.32)}" font-size="${REGION_CAPTION_SIZE}" fill="${theme.boundary}">${escapeText(caption)}</text>`,
    `</g>`,
  ].join("");
}

function renderNode(
  gen: RoughGenerator,
  positioned: PositionedNode,
  theme: Theme,
  arriving: number | undefined,
  findingMarks: readonly FindingMark[],
  priority: EffectivePriority | undefined,
): string {
  const { node, x, y, width, height, lines } = positioned;
  const style = renderStyle(node);
  const fill = theme.fill[node.kind];
  const seed = seedOf(node.id);
  const parts: string[] = [];

  const extent = extentOf(positioned);

  // First, so it sits behind the stack, the halos and the box. Who set it, or
  // which step needs it, is the node's title: it shows on hover.
  if (priority) {
    parts.push(`<title>${escapeText(priorityCaption(priority))}</title>`);
    parts.push(renderPriorityWash(extent, theme.urgentWash));
  }

  // A fanOut node is one node that runs many times, so it draws as a stack.
  if (node.fanOut) {
    const off = 5;
    for (let i = 2; i >= 1; i--) {
      parts.push(
        `<rect x="${r(x + off * i)}" y="${r(y - off * i)}" width="${r(width - off * 2)}" height="${r(height - off * 2)}" fill="${fill}" stroke="${theme.ink}" stroke-width="1.2" opacity="${0.45 / i}"/>`,
      );
    }
  }

  const boxW = node.fanOut ? width - 10 : width;
  const boxH = node.fanOut ? height - 10 : height;
  const box = { x, y, width: boxW, height: boxH };
  // A guard is a declaration, so the count is always drawn. Whether it is
  // wrong is a finding, so that is drawn only when lint said so.
  const guard =
    arriving === undefined ? undefined : node.expects === undefined ? "missing" : "mismatch";
  const found = findingsOn(node.id, findingMarks, guard);

  // An isolated worktree gets a dashed halo — its writes cannot collide.
  if (node.worktree) {
    parts.push(
      `<rect x="${r(x - 5)}" y="${r(y - 5)}" width="${r(width + 10)}" height="${r(height + 10)}" fill="none" stroke="${theme.muted}" stroke-width="1" stroke-dasharray="3 4" opacity="0.8"/>`,
    );
  }

  // After the worktree halo and before the box, so the ring sits behind it.
  if (found.rules.length > 0) parts.push(renderFindingHalo(box, theme.danger, theme.paper));

  if (style === "agent") {
    // Sketchy: this one costs tokens.
    const sketch = gen.rectangle(x, y, boxW, boxH, {
      stroke: theme.ink,
      strokeWidth: 1.9,
      fill,
      fillStyle: "solid",
      roughness: theme.roughness,
      bowing: theme.bowing,
      seed,
    });
    parts.push(drawableToSvg(gen, sketch, { stroke: theme.ink, strokeWidth: 1.9, fill }));
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

  // Label, centred in the space left of the gutter. The agent tag, when there
  // is one, is a quieter line under it, and the two are centred as one block.
  const tag = agentTag(node);
  const textLeft = x + DEFAULT_METRICS.iconGutter;
  const centreX = textLeft + (boxW - DEFAULT_METRICS.iconGutter) / 2;
  const labelHeight = lines.length * DEFAULT_METRICS.lineHeight;
  const totalText = labelHeight + (tag ? DEFAULT_METRICS.tagLineHeight : 0);
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
  if (tag) {
    const tagBaseline =
      y + boxH / 2 - totalText / 2 + labelHeight + DEFAULT_METRICS.tagLineHeight * 0.75;
    parts.push(
      `<text x="${r(centreX)}" y="${r(tagBaseline)}" font-size="${DEFAULT_METRICS.tagSize}" fill="${theme.quiet}" text-anchor="middle">${escapeText(tag)}</text>`,
    );
  }

  const marks: Mark[] = [];
  // What the node is: the tier it runs on. Plain code and an unspecified tier
  // carry none; plain code already says so with its sharp corners.
  if (node.model) {
    marks.push({ slot: "top-left", text: node.model, fill: node.model === "strong" ? theme.ink : theme.quiet });
  }
  if (node.fanOut) {
    marks.push({ slot: "top-right", text: `x${node.fanOut.cap ?? "n"}`, fill: theme.accent });
  }
  if (node.expects !== undefined) {
    marks.push(
      guard === "mismatch"
        ? { slot: "bottom-right", text: `${node.expects} ≠ ${arriving}`, fill: theme.dangerInk }
        : { slot: "bottom-right", text: `expects ${node.expects}`, fill: theme.quiet },
    );
  }
  const caption = fitCaption(found.captions, bottomLeftRoom(box, marks));
  if (caption) marks.push({ slot: "bottom-left", text: caption, fill: theme.dangerInk });
  parts.push(renderMarks(marks, box));
  // Last, so the mark sits over the wash and any finding ring at that corner.
  if (priority && priority.inheritedFrom === undefined) {
    parts.push(renderPriorityMark(extent, priority.priority, theme.urgent, theme.paper));
  }

  const declared = node.expects !== undefined ? ` data-expects="${node.expects}"` : "";
  const flagged = guard ? ` data-guard="${guard}"` : "";
  const tier = node.model ? ` data-tier="${node.model}"` : "";
  const agent = tag ? ` data-agent="${escapeAttr(agentTypes(node).join(" "))}"` : "";
  const rules = found.rules.length > 0 ? ` data-findings="${found.rules.join(" ")}"` : "";
  const urgency = priority
    ? ` data-priority="${priority.priority}"${priority.inheritedFrom !== undefined ? ` data-priority-from="${escapeAttr(priority.inheritedFrom)}"` : ""}${priority.setBy !== undefined ? ` data-priority-set-by="${escapeAttr(priority.setBy)}"` : ""}`
    : "";
  return `<g data-node="${escapeAttr(node.id)}" data-kind="${node.kind}" data-rank="${positioned.rank}"${declared}${flagged}${tier}${agent}${rules}${urgency}>${parts.join("")}</g>`;
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
  return `<g data-edge="${escapeAttr(`${positioned.from}->${positioned.to}`)}"${carries ? ` data-carries="${escapeAttr(carries)}"` : ""}${isFake ? ` data-fake="true" data-finding="FAKE_EDGE"` : ""}>${parts.join("")}</g>`;
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
