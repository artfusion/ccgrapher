// SPDX-License-Identifier: Apache-2.0
import type { Graph } from "./graph.js";
import { topoOrder } from "./graph.js";

export interface Ranking {
  /** node id -> zero-based layer index */
  readonly rank: ReadonlyMap<string, number>;
  /** layers[i] holds the ids at rank i, in the order they appear in the spec */
  readonly layers: readonly (readonly string[])[];
  /** Critical path measured in layers. This is the number the linter reports. */
  readonly layerCount: number;
}

/**
 * Longest-path layering: a node sits one below its deepest predecessor, so any
 * two nodes with no dependency between them land on the same row. The diamond
 * shape falls out of this for free.
 *
 * Deliberately independent of the layout library — the "6 layers -> 4" figure
 * in the lint report must not depend on dagre.
 */
export function rankGraph(graph: Graph): Ranking {
  const rank = new Map<string, number>();

  for (const id of topoOrder(graph)) {
    let deepest = -1;
    for (const edge of graph.inbound.get(id) ?? []) {
      deepest = Math.max(deepest, rank.get(edge.from) ?? 0);
    }
    rank.set(id, deepest + 1);
  }

  const layerCount = rank.size === 0 ? 0 : Math.max(...rank.values()) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);

  // Iterate the spec, not the map, so within-layer order is authored order.
  for (const node of graph.spec.nodes) {
    const r = rank.get(node.id);
    if (r !== undefined) layers[r]!.push(node.id);
  }

  return { rank, layers, layerCount };
}

/** Critical path length in layers. */
export function criticalPath(graph: Graph): number {
  return rankGraph(graph).layerCount;
}
