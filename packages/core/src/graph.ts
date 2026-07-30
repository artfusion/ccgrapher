// SPDX-License-Identifier: Apache-2.0
import type { EdgeSpec, NodeSpec, WorkflowSpec } from "./schema.js";

export class SpecError extends Error {
  override readonly name = "SpecError";
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export interface Graph {
  readonly spec: WorkflowSpec;
  readonly nodes: ReadonlyMap<string, NodeSpec>;
  readonly edges: readonly EdgeSpec[];
  readonly inbound: ReadonlyMap<string, readonly EdgeSpec[]>;
  readonly outbound: ReadonlyMap<string, readonly EdgeSpec[]>;
}

/** Validates ids, edge endpoints and acyclicity, then indexes the adjacency. */
export function buildGraph(spec: WorkflowSpec): Graph {
  const nodes = new Map<string, NodeSpec>();
  for (const node of spec.nodes) {
    if (nodes.has(node.id)) throw new SpecError(`duplicate node id: ${node.id}`);
    nodes.set(node.id, node);
  }

  const inbound = new Map<string, EdgeSpec[]>();
  const outbound = new Map<string, EdgeSpec[]>();
  for (const id of nodes.keys()) {
    inbound.set(id, []);
    outbound.set(id, []);
  }

  for (const edge of spec.edges) {
    if (!nodes.has(edge.from)) {
      throw new SpecError(`edge references unknown node '${edge.from}'`, edge);
    }
    if (!nodes.has(edge.to)) {
      throw new SpecError(`edge references unknown node '${edge.to}'`, edge);
    }
    if (edge.from === edge.to) {
      throw new SpecError(`self-loop on node '${edge.from}'`, edge);
    }
    outbound.get(edge.from)!.push(edge);
    inbound.get(edge.to)!.push(edge);
  }

  const graph: Graph = { spec, nodes, edges: spec.edges, inbound, outbound };
  const cycle = findCycle(graph);
  if (cycle) {
    throw new SpecError(`graph contains a cycle: ${cycle.join(" -> ")}`, cycle);
  }
  return graph;
}

/** Rebuild a graph with a different edge set. Used by the lint repair pass. */
export function withEdges(graph: Graph, edges: readonly EdgeSpec[]): Graph {
  return buildGraph({ ...graph.spec, edges: [...edges] });
}

export function predecessors(graph: Graph, id: string): NodeSpec[] {
  return (graph.inbound.get(id) ?? []).map((e) => graph.nodes.get(e.from)!);
}

export function successors(graph: Graph, id: string): NodeSpec[] {
  return (graph.outbound.get(id) ?? []).map((e) => graph.nodes.get(e.to)!);
}

/**
 * Nodes with no inbound edges. Their declared inputs come from the invocation,
 * so MISSING_INPUT must not fire on them — otherwise every fixture in the drop
 * reports a spurious finding for its entry node.
 */
export function roots(graph: Graph): NodeSpec[] {
  return [...graph.nodes.values()].filter((n) => (graph.inbound.get(n.id) ?? []).length === 0);
}

/**
 * How many results actually arrive at a node. A fanOut source contributes its
 * cap rather than one, which is what makes `expects` consistent across both
 * styles: diamond's checker sees 5 separate edges, research-desk's dedupe sees
 * one edge from a node capped at 5. Both are 5.
 */
export function effectiveInboundCount(graph: Graph, id: string): number {
  return (graph.inbound.get(id) ?? []).reduce((sum, edge) => {
    const source = graph.nodes.get(edge.from)!;
    return sum + (source.fanOut?.cap ?? 1);
  }, 0);
}

/** Every node that can reach `id`, nearest first (BFS over reversed edges). */
export function ancestors(graph: Graph, id: string): NodeSpec[] {
  const seen = new Set<string>([id]);
  const out: NodeSpec[] = [];
  let frontier = [id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of graph.inbound.get(current) ?? []) {
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        out.push(graph.nodes.get(edge.from)!);
        next.push(edge.from);
      }
    }
    frontier = next;
  }
  return out;
}

/** Is there a directed path from `from` to `to`? */
export function hasPath(graph: Graph, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const edge of graph.outbound.get(current) ?? []) {
      if (edge.to === to) return true;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      stack.push(edge.to);
    }
  }
  return false;
}

/** Kahn's algorithm. Returns ids in dependency order. */
export function topoOrder(graph: Graph): string[] {
  const remaining = new Map<string, number>();
  for (const id of graph.nodes.keys()) {
    remaining.set(id, (graph.inbound.get(id) ?? []).length);
  }
  const queue = [...remaining.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const edge of graph.outbound.get(id) ?? []) {
      const left = remaining.get(edge.to)! - 1;
      remaining.set(edge.to, left);
      if (left === 0) queue.push(edge.to);
    }
  }
  return order;
}

function findCycle(graph: Graph): string[] | null {
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "open") return [...path.slice(path.indexOf(id)), id];

    state.set(id, "open");
    path.push(id);
    for (const edge of graph.outbound.get(id) ?? []) {
      const found = visit(edge.to);
      if (found) return found;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of graph.nodes.keys()) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}
