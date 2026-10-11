// SPDX-License-Identifier: Apache-2.0
import { ACCENT, PAPER } from "./graph-model";
import type { CCEdge, CCNode } from "./view-model";

/**
 * Which of the canvas's overlay marks are showing.
 *
 * A layer is a reader's preference about what to look at, not a claim about the
 * work, so it lives outside the spec and outside the lint result: it is applied
 * to the laid-out view on its way to the canvas and to nothing else. Like every
 * overlay it may change colour, text and marks, and never a position or a size.
 *
 * Only marks the web canvas draws are listed. The wave number on each step, the
 * guard marks and the boundary lines belong to the SVG pictures `ccg render`
 * writes; when the canvas draws them they join this list.
 */
export const LAYERS = [
  {
    id: "findings",
    label: "lint findings",
    hint: "the warning mark on a step, and the red dashed look of an edge that carries no data",
  },
  { id: "kinds", label: "kind tint", hint: "the wash that tells a verifier from a worker" },
  { id: "badges", label: "fan-out and worktree", hint: "the ×N badge and the stacked card" },
  { id: "fields", label: "fields on edges", hint: "what each edge carries, written on it" },
] as const;

export type LayerId = (typeof LAYERS)[number]["id"];
export type Layers = Readonly<Record<LayerId, boolean>>;

export const ALL_LAYERS: Layers = { findings: true, kinds: true, badges: true, fields: true };

export function layersEqual(a: Layers, b: Layers): boolean {
  return LAYERS.every(({ id }) => a[id] === b[id]);
}

/**
 * The same nodes and edges with the hidden layers' marks taken off. Positions,
 * sizes, ids and the edges themselves are passed through untouched, which
 * test/layers.test.ts holds this to.
 */
export function applyLayers(
  view: { readonly nodes: readonly CCNode[]; readonly edges: readonly CCEdge[] },
  layers: Layers,
): { nodes: readonly CCNode[]; edges: readonly CCEdge[] } {
  if (layersEqual(layers, ALL_LAYERS)) return view;

  const nodes = view.nodes.map((n) => {
    const data = { ...n.data };
    if (!layers.findings) data.problems = [];
    if (!layers.kinds) data.untinted = true;
    if (!layers.badges) {
      data.badge = null;
      data.worktree = false;
    }
    return { ...n, data };
  });

  const edges = view.edges.map((e): CCEdge => {
    const isFake = e.data?.fake === true;
    let next = e;
    // A fake edge is a finding; with that layer off it is drawn as any edge is.
    if (!layers.findings && isFake) {
      const carries = Array.isArray(e.data?.carries) ? (e.data.carries as string[]) : [];
      next = {
        ...next,
        label: carries.join(", "),
        animated: false,
        style: { stroke: ACCENT, strokeWidth: 2 },
        labelStyle: { ...next.labelStyle, fill: "#6F6660" },
        labelBgStyle: { fill: PAPER, fillOpacity: 0.9 },
        markerEnd: { type: "arrowclosed", color: ACCENT },
      };
    }
    // "carries no data" is the finding's own wording, so it stays while that layer shows.
    if (!layers.fields && !(layers.findings && isFake)) next = { ...next, label: undefined };
    return next;
  });

  return { nodes, edges };
}
