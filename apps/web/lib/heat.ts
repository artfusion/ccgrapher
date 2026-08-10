// SPDX-License-Identifier: Apache-2.0
import type { HeatData } from "@ccgrapher/trace";
import type { CCNode as Node } from "./view-model.js";

/**
 * The thermal overlay.
 *
 * Same seam as `applyRunState` and the same rule: layout has already run, and
 * this may only add to `data` and to the presentation of a node that is already
 * where it is. Nothing here reads or writes a position, a width, a height or a
 * rank, and nothing here reorders the array. A graph that rearranged itself
 * because one node turned out to be slow would be a graph you could not compare
 * to yesterday's, which is the only thing a heat overlay is for.
 *
 * There are no edges in this file on purpose. A `HeatData` is keyed by node id;
 * it has nothing to say about an edge, so heat leaves the edges alone rather
 * than inventing a reading for them.
 *
 * ── the sparse map ──
 *
 * `values` deliberately omits every node it has no measurement for. Those nodes
 * are *unmeasured*, and they are drawn off the ramp entirely — hatched, not
 * pale. Painting them the cold end would say "this was fast", which is the one
 * thing the file does not know. Absence stays absence, the same way it does in
 * `heatFromRunStats`, which is where these files come from.
 */

/**
 * Five bands, cold to hot, ending on the accent the drawing already uses.
 *
 * Deliberately not a spectrum. A blue-to-red ramp would introduce two hues the
 * rest of the page has never used and turn a pen drawing into a weather map;
 * this is the paper warming up, and its hottest step is `--accent` exactly.
 *
 * Banded rather than continuous because a continuous gradient invites the eye
 * to read a precision that a median over three samples does not have.
 */
export const HEAT_RAMP: readonly string[] = [
  "#FBF3E9",
  "#F8E3CD",
  "#F3CBA6",
  "#EDA972",
  "#E8763A",
];

/** The fill for a node the file has no measurement for. Off the ramp, on purpose. */
export const HEAT_UNMEASURED_FILL =
  "repeating-linear-gradient(45deg, #F0EBE3 0 5px, #E2DACE 5px 10px)";

export interface HeatBand {
  /** Inclusive lower bound of the band, in the file's own unit. */
  readonly from: number;
  /** Exclusive upper bound, except for the last band, which includes its top. */
  readonly to: number;
  readonly fill: string;
}

/**
 * Everything the legend needs, computed once from the nodes actually on screen.
 *
 * `unmatched` counts entries in the file that name no node in this graph. That
 * is how loading a heat file over the wrong spec announces itself instead of
 * quietly tinting three nodes and looking like a run where nothing happened.
 */
export interface HeatLegend {
  readonly metric: string;
  readonly unit: string;
  readonly source: string;
  /**
   * Empty when there is no domain to draw one over: no node on screen is
   * measured, or every measured node reads zero.
   */
  readonly bands: readonly HeatBand[];
  /**
   * True when several nodes are measured and they all read the same. The ramp
   * is still drawn and still correct — anchored at zero, "all equal to the
   * maximum" genuinely is the top band — but a wall of one colour looks like a
   * finding, and it is not one, so the legend says so in words.
   */
  readonly flat: boolean;
  readonly measured: number;
  readonly unmeasured: number;
  readonly unmatched: number;
}

export interface HeatNodeData {
  /** Absent when no heat file is showing. Present, with no `value`, when a node is unmeasured. */
  readonly heat?: {
    readonly value?: number;
    /** The value as the legend would print it, or "no data". */
    readonly text: string;
    readonly band?: number;
  };
}

/**
 * The domain a set of measurements is drawn against.
 *
 * Anchored at zero rather than at the smallest value present. Every metric these
 * files carry — a duration, a cost, hours to merge — is a ratio quantity, so a
 * node at twice the value should be twice as far up the ramp. Anchoring at the
 * minimum instead would paint 100, 101 and 102 as a dramatic spread across the
 * whole ramp, which is the oldest lie a heatmap tells.
 *
 * `Math.max(0, …)` on the top is only there so a file of entirely negative
 * numbers still produces a domain rather than an inverted one.
 */
function domain(values: readonly number[]): { lo: number; hi: number } {
  let lo = 0;
  let hi = 0;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return { lo, hi };
}

/**
 * The band a value falls in. `hi` itself belongs to the top band, not to a
 * sixth one off the end.
 *
 * `hi === lo` can only happen when every measured value is zero, and zero is
 * where this scale starts, so those land at the cold end rather than at some
 * invented middle.
 */
function bandOf(value: number, lo: number, hi: number): number {
  if (hi === lo) return 0;
  const step = (value - lo) / (hi - lo);
  const index = Math.floor(step * HEAT_RAMP.length);
  return Math.min(Math.max(index, 0), HEAT_RAMP.length - 1);
}

function bands(lo: number, hi: number): HeatBand[] {
  const width = (hi - lo) / HEAT_RAMP.length;
  return HEAT_RAMP.map((fill, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, fill }));
}

/**
 * A number a reader can hold in their head: three significant figures at most,
 * and no trailing zeroes pretending to be precision.
 */
export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return String(Number(value.toFixed(2)));
  return String(Number(value.toPrecision(2)));
}

/**
 * Formats in the file's own unit, and never converts. 90000 ms is printed as
 * 90000 ms, not 1.5 minutes: the file said milliseconds, and a reader comparing
 * this overlay to `ccg trace stats` should see the same number in both places.
 */
export function formatHeat(value: number, unit: string): string {
  if (unit === "usd") return `$${formatNumber(value)}`;
  return `${formatNumber(value)} ${unit}`;
}

/** CSS `content:` takes a quoted string, and the unit comes out of a file. */
function cssString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Tint an already-positioned graph.
 *
 * Returns the array unchanged when there is no heat to show, so a canvas with no
 * heat file loaded does not allocate, let alone re-render.
 *
 * The tint reaches the card as two custom properties on the node wrapper rather
 * than as a repainted node component, because the fill and the caption are
 * presentation and the component's job is the drawing. `--heat-fill` is the wash,
 * `--heat-label` the caption underneath it; `globals.css` does the rest.
 */
export function applyHeat(
  nodes: Node[],
  heat: HeatData | undefined,
): { nodes: Node[]; legend?: HeatLegend } {
  if (!heat) return { nodes };

  const present: number[] = [];
  for (const node of nodes) {
    const value = heat.values[node.id];
    if (value !== undefined) present.push(value);
  }

  const { lo, hi } = domain(present);

  const tinted = nodes.map((node) => {
    const value = heat.values[node.id];
    const measured = value !== undefined;
    const band = measured ? bandOf(value, lo, hi) : undefined;
    const text = measured ? formatHeat(value, heat.unit) : "no data";

    // Position, width and height are spread through untouched, on purpose.
    return {
      ...node,
      className: `${node.className ?? ""} heat-node ${measured ? "heat-measured" : "heat-unmeasured"}`.trim(),
      style: {
        ...node.style,
        "--heat-fill": measured ? HEAT_RAMP[band!] : HEAT_UNMEASURED_FILL,
        "--heat-label": cssString(text),
        // Custom properties are how a wash reaches a card this file does not own.
        // React sets them with `setProperty`, but `CSSProperties` has no room for
        // them in the type, hence the one assertion.
      } as Node["style"],
      data: {
        ...node.data,
        heat: measured ? { value, text, band } : { text },
      },
    };
  });

  const ids = new Set(nodes.map((node) => node.id));
  let unmatched = 0;
  for (const id of Object.keys(heat.values)) {
    if (!ids.has(id)) unmatched += 1;
  }

  return {
    nodes: tinted,
    legend: {
      metric: heat.metric,
      unit: heat.unit,
      source: heat.source,
      bands: hi === lo ? [] : bands(lo, hi),
      flat: present.length > 1 && present.every((value) => value === present[0]),
      measured: present.length,
      unmeasured: nodes.length - present.length,
      unmatched,
    },
  };
}
