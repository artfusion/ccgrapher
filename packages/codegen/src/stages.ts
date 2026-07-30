// SPDX-License-Identifier: Apache-2.0
import { rankGraph, type Graph, type NodeSpec } from "@ccgrapher/core";
import type { Stage } from "./types.js";

/**
 * One stage per rank. Everything in a stage has no dependency on anything else
 * in it, so it can all run at once — which is the entire point of having drawn
 * the graph. A stage of one emits a plain await; a stage of many emits a
 * parallel barrier.
 */
export function stages(graph: Graph): Stage[] {
  const { layers } = rankGraph(graph);
  return layers.map((ids, rank) => ({
    rank,
    nodes: ids.map((id) => graph.nodes.get(id)!),
  }));
}

/** Upstream nodes whose output this node consumes. */
export function inputsOf(graph: Graph, node: NodeSpec): Array<{ from: string; fields: string[] }> {
  return (graph.inbound.get(node.id) ?? []).map((edge) => ({
    from: edge.from,
    fields: [...edge.carries],
  }));
}

/** How many results a fan-in node should wait for, if it declared a guard. */
export function guardOf(node: NodeSpec): number | undefined {
  return node.expects;
}
