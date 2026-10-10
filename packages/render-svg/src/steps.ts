// SPDX-License-Identifier: Apache-2.0
import type { Step } from "@ccgrapher/core";
import type { PositionedNode } from "@ccgrapher/layout";
import type { Theme } from "./theme.js";

/**
 * Step numbers and the legend under the picture.
 *
 * The number is not a corner slot: all four are taken (see `marks.ts`), and the
 * finding halo flags the top-left corner itself. So the number sits outside the
 * box, in a small paper pill, at the first of a fixed list of places round the
 * box that is clear: over the box's left end first, where edges seldom arrive
 * (they aim at the middle), then up and to the left of the corner, beside the
 * box, the same on the right, and below last. Clear means clear of every box
 * and what is drawn round it (halo, flag, worktree ring, fan-out copies, the
 * urgency disc and wash), every
 * edge and shared-write line, every edge label and boundary caption, every
 * number already placed, and every boundary outline, which a number sits wholly
 * inside or wholly outside; and nearer its own box than any other, so it is
 * never read as another step's. The list is fixed and the steps are placed in
 * order, so the same graph puts every number in the same place. The structural
 * checker in the tests holds every example to it.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** What a number must keep clear of, besides the boxes themselves. */
export interface Obstacles {
  /** Edge routes and shared-write lines, as polylines. */
  readonly lines: readonly (readonly Point[])[];
  /** Text: edge labels, shared-write labels, boundary captions. */
  readonly rects: readonly Rect[];
  /** Boundary outlines. */
  readonly regions: readonly Rect[];
}

const BADGE_SIZE = 13;
const BADGE_HEIGHT = 18;
const BADGE_PAD = 5;
/** Distance from the box: clear of the halo (7 out) and its flag (6.5 round the corner), with air. */
const BADGE_CLEAR = 16;
/** Air kept round a number. */
const GAP = 3;
/** What the layout plans text with; an overestimate for Caveat, so text never meets its pill. */
const CHAR_RATIO = 0.52;
/** How far out from a box its own drawing reaches: the halo 7, the fan-out copies 10 above. */
const RING = 8;
const COPIES = 11;
const FLAG = { offset: 7, radius: 6.5 };

export interface PlacedBadge {
  readonly step: Step;
  readonly box: Rect;
}

/** Candidate places, as the top-left of the pill, in order of preference. */
function candidates(node: PositionedNode, w: number): Point[] {
  const { x, y, width: W, height: H } = node;
  const h = BADGE_HEIGHT;
  const left = x - BADGE_CLEAR - w;
  const right = x + W + BADGE_CLEAR;
  // Above the fan-out copies, when there are any: they climb 10 above the box.
  const above = (node.node.fanOut ? y - 10 : y) - BADGE_CLEAR - h;
  const below = y + H + BADGE_CLEAR;
  return [
    { x, y: above },
    { x: left, y: above },
    { x: left, y },
    { x: x + W - w, y: above },
    { x: right, y: above },
    { x: right, y },
    { x: left, y: y + H - h },
    { x: right, y: y + H - h },
    { x, y: below },
    { x: x + W - w, y: below },
  ];
}

const intersects = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const grow = (b: Rect, d: number): Rect => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });

/** Liang-Barsky: does the segment touch the box? */
function segmentHits(p: Point, q: Point, b: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const clip = (pk: number, qk: number): boolean => {
    if (pk === 0) return qk >= 0;
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    return t0 <= t1;
  };
  return clip(-dx, p.x - b.x0) && clip(dx, b.x1 - p.x) && clip(-dy, p.y - b.y0) && clip(dy, b.y1 - p.y);
}

/** Gap between two rectangles; zero when they touch or overlap. */
const distance = (a: Rect, b: Rect) =>
  Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));

const boxOf = (n: PositionedNode): Rect => ({ x0: n.x, y0: n.y, x1: n.x + n.width, y1: n.y + n.height });

/** How many things a pill at `box` would meet, as the number of `own`. Zero is clear. */
function collisions(
  box: Rect,
  own: PositionedNode,
  nodes: readonly PositionedNode[],
  obstacles: Obstacles,
  placed: readonly Rect[],
  bounds: { width: number; height: number },
): number {
  const near = grow(box, GAP);
  let count = 0;
  if (box.x0 < GAP || box.y0 < GAP || box.x1 > bounds.width - GAP || box.y1 > bounds.height - GAP) count++;
  for (const n of nodes) {
    if (intersects(near, { x0: n.x - RING, y0: n.y - COPIES, x1: n.x + n.width + RING, y1: n.y + n.height + RING })) count++;
    // The flag is round: test the circle, not its square.
    const cx = Math.max(near.x0, Math.min(n.x - FLAG.offset, near.x1));
    const cy = Math.max(near.y0, Math.min(n.y - FLAG.offset, near.y1));
    if (Math.hypot(cx - (n.x - FLAG.offset), cy - (n.y - FLAG.offset)) < FLAG.radius) count++;
    if (n !== own && distance(box, boxOf(n)) <= distance(box, boxOf(own))) count++;
  }
  for (const line of obstacles.lines) {
    if (line.some((p, k) => k > 0 && segmentHits(line[k - 1]!, p, near))) count++;
  }
  for (const rect of [...obstacles.rects, ...placed]) {
    if (intersects(near, rect)) count++;
  }
  for (const region of obstacles.regions) {
    const outside = !intersects(near, region);
    const inside = near.x0 > region.x0 && near.y0 > region.y0 && near.x1 < region.x1 && near.y1 < region.y1;
    if (!outside && !inside) count++;
  }
  return count;
}

/**
 * Where each step's number goes: the first clear candidate, or, when none is,
 * the one that meets the least (earliest on a tie), so a crowded picture still
 * gets every number, and the checker says where.
 */
export function placeStepBadges(
  nodes: readonly PositionedNode[],
  steps: readonly Step[],
  obstacles: Obstacles,
  bounds: { width: number; height: number },
): PlacedBadge[] {
  const at = new Map(nodes.map((n) => [n.id, n]));
  const placed: PlacedBadge[] = [];
  for (const step of steps) {
    const node = at.get(step.id)!;
    const w = Math.max(BADGE_HEIGHT, Math.ceil(step.number.length * BADGE_SIZE * CHAR_RATIO) + BADGE_PAD * 2);
    let best: { box: Rect; count: number } | undefined;
    for (const p of candidates(node, w)) {
      const box = { x0: p.x, y0: p.y, x1: p.x + w, y1: p.y + BADGE_HEIGHT };
      const count = collisions(box, node, nodes, obstacles, placed.map((b) => b.box), bounds);
      if (!best || count < best.count) best = { box, count };
      if (count === 0) break;
    }
    placed.push({ step, box: best!.box });
  }
  return placed;
}

/** A paper pill with the number in ink, drawn over everything else in the graph. */
export function renderStepBadges(badges: readonly PlacedBadge[], theme: Theme): string[] {
  return badges.map(({ step, box }) => {
    const width = box.x1 - box.x0;
    return [
      `<g data-step="${escapeText(step.number)}" data-step-of="${escapeAttr(step.id)}">`,
      `<rect x="${r(box.x0)}" y="${r(box.y0)}" width="${r(width)}" height="${BADGE_HEIGHT}" rx="${BADGE_HEIGHT / 2}" fill="${theme.paper}" stroke="${theme.ink}" stroke-width="1.3"/>`,
      `<text x="${r(box.x0 + width / 2)}" y="${r(box.y0 + 13.5)}" font-size="${BADGE_SIZE}" fill="${theme.ink}" text-anchor="middle">${escapeText(step.number)}</text>`,
      `</g>`,
    ].join("");
  });
}

const LEGEND_X = 40;
const LEGEND_HEADING = "one run, step by step";
const HEADING_SIZE = 20;
const NUMBER_SIZE = 16;
const LABEL_SIZE = 17;
const LINE_SIZE = 15;
const HEADING_BASELINE = 22;
const FIRST_ROW = 52;
const ROW = 24;
const BOTTOM = 30;
const COLUMN_GAP = 14;

interface Columns {
  readonly label: number;
  readonly line: number;
  readonly width: number;
  readonly height: number;
}

const textWidth = (text: string, size: number) => Math.ceil(text.length * size * CHAR_RATIO);

/** Column positions and the room the legend needs. Computed from the text, so the same steps give the same box. */
function columns(steps: readonly Step[]): Columns {
  const numbers = Math.max(...steps.map((s) => textWidth(s.number, NUMBER_SIZE)));
  const labels = Math.max(...steps.map((s) => textWidth(s.label, LABEL_SIZE)));
  const lines = Math.max(...steps.map((s) => textWidth(s.line, LINE_SIZE)));
  const label = LEGEND_X + numbers + COLUMN_GAP;
  const line = label + labels + COLUMN_GAP;
  return {
    label,
    line,
    width: Math.max(line + lines, LEGEND_X + textWidth(LEGEND_HEADING, HEADING_SIZE)) + LEGEND_X,
    height: FIRST_ROW + (steps.length - 1) * ROW + BOTTOM,
  };
}

/** How much the canvas grows to hold the legend. */
export function legendSize(steps: readonly Step[]): { width: number; height: number } {
  if (steps.length === 0) return { width: 0, height: 0 };
  const { width, height } = columns(steps);
  return { width, height };
}

/** The legend as text under the graph, its top at `top`: number, label, and what the step takes and gives. */
export function renderLegend(steps: readonly Step[], top: number, theme: Theme): string {
  if (steps.length === 0) return "";
  const cols = columns(steps);
  const rows = steps.map((step, i) => {
    const y = r(top + FIRST_ROW + i * ROW);
    return [
      `<text x="${LEGEND_X}" y="${y}" font-size="${NUMBER_SIZE}" fill="${theme.ink}">${escapeText(step.number)}</text>`,
      `<text x="${cols.label}" y="${y}" font-size="${LABEL_SIZE}" fill="${theme.ink}">${escapeText(step.label)}</text>`,
      `<text x="${cols.line}" y="${y}" font-size="${LINE_SIZE}" fill="${theme.quiet}">${escapeText(step.line)}</text>`,
    ].join("");
  });
  return [
    `  <g data-legend="steps">`,
    `    <text x="${LEGEND_X}" y="${r(top + HEADING_BASELINE)}" font-size="${HEADING_SIZE}" fill="${theme.ink}">${LEGEND_HEADING}</text>`,
    ...rows.map((row) => `    ${row}`),
    `  </g>`,
  ].join("\n");
}

const r = (n: number) => Number(n.toFixed(2));

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");
