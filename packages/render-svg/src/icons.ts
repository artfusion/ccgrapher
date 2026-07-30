// SPDX-License-Identifier: Apache-2.0
import type { NodeKind } from "@ccgrapher/core";

/**
 * Small line icons, authored in a 16x16 box and scaled at draw time. The
 * reference figures use a magnifier for research, scales for comparison and a
 * clipboard for checking; the rest follow the same weight.
 */
const PATHS: Record<NodeKind, string> = {
  // concentric target
  goal: "M8 2.5 A5.5 5.5 0 1 1 7.99 2.5 M8 5.5 A2.5 2.5 0 1 1 7.99 5.5",
  // one line forking into three
  split: "M1.5 8 H6 M6 8 L11 3.5 M6 8 H11 M6 8 L11 12.5",
  // magnifier
  worker: "M7 3.2 A3.8 3.8 0 1 1 6.99 3.2 M9.8 9.8 L13.2 13.2",
  // balance scales
  verifier: "M8 2.5 V13.5 M3 4.5 H13 M3 4.5 L1.5 8.5 H4.5 Z M13 4.5 L11.5 8.5 H14.5 Z M5 13.5 H11",
  // funnel
  reduce: "M2 3 H14 L9.5 8.2 V13.5 L6.5 12 V8.2 Z",
  // clipboard
  synthesize: "M4.5 3 H11.5 V14 H4.5 Z M6.5 3 V1.8 H9.5 V3 M6.3 6.5 H9.7 M6.3 9 H9.7 M6.3 11.5 H8.4",
  // head and shoulders
  gate: "M8 2.5 A2.4 2.4 0 1 1 7.99 2.5 M2.8 14 A5.2 5.2 0 0 1 13.2 14",
};

export function iconPath(kind: NodeKind): string {
  return PATHS[kind];
}

/** Place a 16x16 icon at (x, y) scaled by `size`/16. */
export function iconTransform(x: number, y: number, size: number): string {
  const scale = size / 16;
  return `translate(${round(x)} ${round(y)}) scale(${round(scale, 4)})`;
}

const round = (n: number, places = 2) => Number(n.toFixed(places));
