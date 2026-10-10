// SPDX-License-Identifier: Apache-2.0
import { topoOrder, type Graph } from "./graph.js";
import type { Priority } from "./schema.js";

/** A priority above `normal`: the only kind that changes anything. */
export type RaisedPriority = Exclude<Priority, "normal">;

/** Higher goes first. Absent and `normal` are both zero. */
export const PRIORITY_WEIGHT: Readonly<Record<Priority, number>> = {
  normal: 0,
  high: 1,
  urgent: 2,
};

/** The priority a step runs at, and where it came from. */
export interface EffectivePriority {
  readonly priority: RaisedPriority;
  /**
   * The step whose own `priority` this is, when it is not this one's: the
   * urgent step that waits, directly or not, on this one.
   */
  readonly inheritedFrom?: string;
  /** `prioritySetBy` on the step the priority belongs to, when it says. */
  readonly setBy?: string;
}

/**
 * Every node whose effective priority is raised, by id. A node at `normal`,
 * which is most of them, is absent.
 *
 * Effective priority is the higher of a node's own and that of any step that
 * depends on it, directly or not. That is priority inheritance: an urgent step
 * that waits on two unstarted steps would otherwise wait behind the very work
 * it needs. Nothing about dependencies changes. An inherited priority only
 * reorders a step among others that are also ready.
 *
 * The rule says "any descendant not yet started", and the static answer is
 * the same one: a step is only ever ready, and so only ever ordered, before
 * anything downstream of it has started, since nothing downstream can start
 * until it has finished. So this is computed once, from the spec.
 *
 * Ties are deterministic. A node's own priority wins over an equal inherited
 * one, and between two equal descendants the one earlier in the spec is named.
 */
export function effectivePriorities(graph: Graph): ReadonlyMap<string, EffectivePriority> {
  const order = new Map([...graph.nodes.keys()].map((id, index) => [id, index]));
  const out = new Map<string, EffectivePriority & { readonly from: string }>();

  // Reverse topological order, so every descendant is settled before its ancestors.
  for (const id of topoOrder(graph).reverse()) {
    const node = graph.nodes.get(id)!;
    let best: (EffectivePriority & { readonly from: string }) | undefined =
      node.priority && node.priority !== "normal"
        ? { priority: node.priority, from: id, ...(node.prioritySetBy !== undefined && { setBy: node.prioritySetBy }) }
        : undefined;

    for (const edge of graph.outbound.get(id) ?? []) {
      const below = out.get(edge.to);
      if (!below) continue;
      const better =
        best === undefined ||
        PRIORITY_WEIGHT[below.priority] > PRIORITY_WEIGHT[best.priority] ||
        (PRIORITY_WEIGHT[below.priority] === PRIORITY_WEIGHT[best.priority] &&
          best.from !== id &&
          order.get(below.from)! < order.get(best.from)!);
      if (better) best = below;
    }

    if (best) out.set(id, best);
  }

  const result = new Map<string, EffectivePriority>();
  // Spec order, so iterating the map reads the way the spec does.
  for (const id of graph.nodes.keys()) {
    const found = out.get(id);
    if (!found) continue;
    const { from, ...rest } = found;
    result.set(id, from === id ? rest : { ...rest, inheritedFrom: from });
  }
  return result;
}

/**
 * The words every format draws for a raised priority: `urgent, set by on-call`
 * on the step that carries it, `urgent, needed by deploy` on one that
 * inherits it. One string, so the SVG title and the Mermaid and Excalidraw
 * labels cannot say different things.
 */
export function priorityCaption(effective: EffectivePriority): string {
  if (effective.inheritedFrom !== undefined) {
    return `${effective.priority}, needed by ${effective.inheritedFrom}`;
  }
  return effective.setBy !== undefined ? `${effective.priority}, set by ${effective.setBy}` : effective.priority;
}
