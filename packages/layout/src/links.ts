// SPDX-License-Identifier: Apache-2.0
import type { Point, PositionedGraph, PositionedNode } from "./layout.js";

/**
 * A line between two nodes that is not an edge: two concurrent writers of one
 * file, say. It has to be drawn without implying an order and without crossing
 * a box, so it never takes the straight path an edge would.
 *
 * It runs in the lane above a row, which no box occupies (rows are `rankSep`
 * apart and a lane sits well inside that gap):
 *
 *   same row      up from each node, across the lane above the row, a bracket
 *   two rows      up from the upper node, out along its lane to the margin,
 *                 down the margin to the lane above the lower node, back in
 *
 * The margin is clear by construction, so neither shape can pass through a
 * node. Several links over one row step up a lane each, in the order given.
 */
export interface LinkRoute {
  readonly between: readonly [string, string];
  readonly points: readonly Point[];
  /** Where a label goes: the middle of the longest run along a lane, on the line. */
  readonly label: Point;
}

/** First lane above a row's top edge, clear of fan-out copies and finding flags. */
const LANE = 24;
/** Each further link over the same row rises by this much. */
const LANE_STEP = 16;
/** How far into a box, from its corner, a link meets it: clear of the flag and of edges arriving centre top. */
const LEG = 24;
/** Distance from the outermost box (and its ring) to the margin run. */
const SIDE = 23;

export function routeLinks(
  positioned: PositionedGraph,
  pairs: ReadonlyArray<readonly [string, string]>,
): LinkRoute[] {
  const byId = new Map(positioned.nodes.map((n) => [n.id, n]));
  // A row is the nodes drawn on one line, which is not always one rank: a root
  // with no successor is ranked 0 but drawn on the bottom row. Rows share a centre.
  const row = (n: PositionedNode) => Math.round(n.y + n.height / 2);
  const rowTop = new Map<number, number>();
  for (const n of positioned.nodes) rowTop.set(row(n), Math.min(rowTop.get(row(n)) ?? Infinity, n.y));

  const used = new Map<number, number>();
  const lane = (n: PositionedNode): number => {
    const k = used.get(row(n)) ?? 0;
    used.set(row(n), k + 1);
    return rowTop.get(row(n))! - LANE - LANE_STEP * k;
  };

  const left = Math.min(...positioned.nodes.map((n) => n.x));
  const right = Math.max(...positioned.nodes.map((n) => n.x + n.width));
  const centre = (n: PositionedNode) => n.x + n.width / 2;

  const routes: LinkRoute[] = [];
  for (const [a, b] of pairs) {
    const na = byId.get(a);
    const nb = byId.get(b);
    if (!na || !nb) continue;

    if (row(na) === row(nb)) {
      const [l, r] = centre(na) <= centre(nb) ? [na, nb] : [nb, na];
      const y = lane(na);
      const x0 = l.x + l.width - LEG;
      const x1 = r.x + LEG;
      routes.push({
        between: [a, b],
        points: [
          { x: x0, y: l.y },
          { x: x0, y },
          { x: x1, y },
          { x: x1, y: r.y },
        ],
        label: { x: (x0 + x1) / 2, y },
      });
      continue;
    }

    const [upper, lower] = row(na) < row(nb) ? [na, nb] : [nb, na];
    const toRight = (centre(upper) + centre(lower)) / 2 >= (left + right) / 2;
    const side = toRight ? right + SIDE : left - SIDE;
    const leg = (n: PositionedNode) => (toRight ? n.x + n.width - LEG : n.x + LEG);
    const yu = lane(upper);
    const yl = lane(lower);
    const runUpper = Math.abs(side - leg(upper));
    const runLower = Math.abs(side - leg(lower));
    routes.push({
      between: [a, b],
      points: [
        { x: leg(upper), y: upper.y },
        { x: leg(upper), y: yu },
        { x: side, y: yu },
        { x: side, y: yl },
        { x: leg(lower), y: yl },
        { x: leg(lower), y: lower.y },
      ],
      label:
        runUpper >= runLower
          ? { x: (leg(upper) + side) / 2, y: yu }
          : { x: (leg(lower) + side) / 2, y: yl },
    });
  }
  return routes;
}
