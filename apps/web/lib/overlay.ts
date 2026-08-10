// SPDX-License-Identifier: Apache-2.0
import type { NodeRunState, RunState } from "@ccgrapher/trace";
import type { CCEdge as Edge, CCNode as Node } from "./view-model.js";

/**
 * The overlay seam.
 *
 * `buildModel` in `graph-model.ts` is pure — spec in, positioned nodes out — and
 * it stays that way. Run state is merged in *here*, after layout, and it may only
 * add to `data`. It must never change a position, a width, a height, a rank or
 * the order of the arrays, because a picture that rearranges itself under live
 * data can be made to lie: the same spec would draw differently depending on how
 * a run happened to go, and the drawing would stop being a consequence of the
 * `in:`/`out:` declarations.
 *
 * Everything that comes later hangs off this one function:
 *
 *   - a pop-over reads `data.run.tail`, `data.run.usage` and `data.run.error`;
 *   - the gate UI reads `data.run.status === "waiting"` and `data.run.gatePayload`,
 *     and posts to `/runs/:id/gates/:node`;
 *   - the heatmap tints from a per-node metric alongside `data.run`;
 *   - Pareto projections dim the nodes they exclude.
 *
 * All four are `data` fields. If one of them wants a node moved, the answer is no.
 */

export interface RunNodeData {
  /** Absent when nothing is connected, or when the run has said nothing about this node. */
  readonly run?: NodeRunState;
}

/**
 * Merge run state into an already-positioned graph.
 *
 * Returns the arrays unchanged when there is nothing to overlay, so a canvas with
 * no server attached does not even allocate a new array, let alone re-render.
 */
export function applyRunState(
  nodes: Node[],
  edges: Edge[],
  run: RunState | undefined,
): { nodes: Node[]; edges: Edge[] } {
  if (!run) return { nodes, edges };

  const overlaid = nodes.map((node) => {
    const state = run.nodes.get(node.id);
    if (!state) return node;
    // Position, width and height are spread through untouched, on purpose.
    return { ...node, data: { ...node.data, run: state } };
  });

  const withFlow = edges.map((edge) => {
    // An edge earns its animation only when data is genuinely moving along it:
    // the source has produced its output and the target is working on it.
    const from = run.nodes.get(edge.source)?.status;
    const to = run.nodes.get(edge.target)?.status;
    const flowing = from === "done" && (to === "running" || to === "partial");
    if (!flowing || edge.animated) return edge;
    return { ...edge, animated: true, className: "edge-flowing" };
  });

  return { nodes: overlaid, edges: withFlow };
}
