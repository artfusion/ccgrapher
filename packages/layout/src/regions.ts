// SPDX-License-Identifier: Apache-2.0
import type { BoundarySpec } from "@ccgrapher/core";
import type { PositionedNode } from "./layout.js";

/**
 * One rectangle drawn for a boundary. Most boundaries are one region; a
 * boundary whose members cannot share a rectangle without enclosing a node that
 * is not a member is drawn as several (see `boundaryRegions`).
 */
export interface PositionedRegion {
  readonly boundary: BoundarySpec;
  /** Zero-based index of this region among its boundary's regions. */
  readonly part: number;
  /** How many regions this boundary was drawn as. */
  readonly parts: number;
  /** Member ids inside this region, in rank then left-to-right order. */
  readonly members: readonly string[];
  /** Top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Space between a member's box and the region's side. Smaller than half the
 * layout's minimum node gap (30), so two regions side by side in one row never
 * touch, and well clear of the 5px worktree halo, so the two never read as one.
 */
export const REGION_PAD = 12;

/**
 * Space above and below. Larger, because the row gap (96) allows it and a
 * fan-out stack draws its copies 10px above its own box.
 */
export const REGION_PAD_Y = 22;

interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * Regions for every boundary, computed from the positioned nodes. A boundary
 * never moves, adds or resizes a node: it is drawn around wherever the layout
 * put its members.
 *
 * The layout knows nothing about boundaries, so members need not sit side by
 * side. A rectangle around members that do not will also enclose nodes that are
 * not members, and the picture would then claim something the spec does not.
 * So a boundary is drawn as one padded rectangle around all its members when
 * that rectangle holds no other node; otherwise as one rectangle per run of
 * members that are adjacent within a row. A run, by construction, encloses
 * nothing else.
 *
 * Two boundaries whose single rectangles would cross are both drawn as runs,
 * since a run lies inside its boundary's rectangle and runs in one row are
 * separated by the node gap.
 */
export function boundaryRegions(
  boundaries: readonly BoundarySpec[],
  nodes: readonly PositionedNode[],
): PositionedRegion[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const whole = boundaries.map((boundary) => {
    // buildGraph has already checked that every member names a node.
    const members = boundary.members.map((id) => byId.get(id)!);
    const rect = pad(union(members));
    const others = nodes.filter((n) => !boundary.members.includes(n.id));
    const clean = !others.some((n) => intersects(rect, boxOf(n)));
    return { boundary, members, rect, clean };
  });

  const split = whole.map((w) => !w.clean);
  for (let i = 0; i < whole.length; i++) {
    for (let j = i + 1; j < whole.length; j++) {
      if (intersects(whole[i]!.rect, whole[j]!.rect)) split[i] = split[j] = true;
    }
  }

  return whole.flatMap((w, i) => {
    const groups = split[i] ? runs(w.members, nodes) : [ordered(w.members)];
    return groups.map((group, part) => {
      const rect = pad(union(group));
      return {
        boundary: w.boundary,
        part,
        parts: groups.length,
        members: group.map((n) => n.id),
        x: rect.x0,
        y: rect.y0,
        width: rect.x1 - rect.x0,
        height: rect.y1 - rect.y0,
      };
    });
  });
}

/** Maximal runs of members with no other node between them in the same row. */
function runs(members: readonly PositionedNode[], nodes: readonly PositionedNode[]): PositionedNode[][] {
  const memberIds = new Set(members.map((m) => m.id));
  const ranks = [...new Set(members.map((m) => m.rank))].sort((a, b) => a - b);
  const out: PositionedNode[][] = [];
  for (const rank of ranks) {
    const row = ordered(nodes.filter((n) => n.rank === rank));
    let current: PositionedNode[] = [];
    for (const node of row) {
      if (memberIds.has(node.id)) {
        current.push(node);
      } else if (current.length > 0) {
        out.push(current);
        current = [];
      }
    }
    if (current.length > 0) out.push(current);
  }
  return out;
}

const ordered = (list: readonly PositionedNode[]) =>
  [...list].sort((a, b) => a.rank - b.rank || a.x - b.x || a.id.localeCompare(b.id));

const boxOf = (n: PositionedNode): Rect => ({ x0: n.x, y0: n.y, x1: n.x + n.width, y1: n.y + n.height });

function union(list: readonly PositionedNode[]): Rect {
  const boxes = list.map(boxOf);
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

const pad = (r: Rect): Rect => ({
  x0: r.x0 - REGION_PAD,
  y0: r.y0 - REGION_PAD_Y,
  x1: r.x1 + REGION_PAD,
  y1: r.y1 + REGION_PAD_Y,
});

const intersects = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
