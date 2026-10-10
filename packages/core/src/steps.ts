// SPDX-License-Identifier: Apache-2.0
import type { Graph } from "./graph.js";
import { rankGraph } from "./ranks.js";
import type { NodeSpec } from "./schema.js";

/** One numbered step of a run, as the legend under a picture lists it. */
export interface Step {
  readonly id: string;
  /**
   * The step's number: its wave, counted from 1. Steps that share a wave share
   * the number and take a letter each, in spec order (`4a`, `4b`), so the
   * number alone says what can run together.
   */
  readonly number: string;
  /** The wave, counted from 1: the node's rank plus one. */
  readonly wave: number;
  readonly label: string;
  /**
   * What the step takes and gives, read off its `in` and `out` field names,
   * and how far it fans out. Derived from the declarations, never written.
   */
  readonly line: string;
}

/** How many field names a line names before it counts the rest. */
const NAMED = 3;

/**
 * Every step in execution order: wave first, then the order the spec lists
 * them in. A fanned-out node is one step, however many times it runs; its cap
 * is in the line. The same graph always gives the same steps.
 */
export function stepLegend(graph: Graph): Step[] {
  const { layers } = rankGraph(graph);
  return layers.flatMap((layer, rank) =>
    layer.map((id, i) => {
      const node = graph.nodes.get(id)!;
      return {
        id,
        number: layer.length === 1 ? `${rank + 1}` : `${rank + 1}${letters(i)}`,
        wave: rank + 1,
        label: node.label,
        line: stepLine(node),
      };
    }),
  );
}

/** `a` to `z`, then `aa`: bijective base 26, so a wave of any width keeps its letters distinct. */
function letters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const d = (n - 1) % 26;
    out = String.fromCharCode(97 + d) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function stepLine(node: NodeSpec): string {
  const takes = Object.keys(node.in);
  const gives = Object.keys(node.out);
  const parts: string[] = [];
  if (node.fanOut) {
    parts.push(
      node.fanOut.cap === undefined
        ? `one per ${node.fanOut.over}`
        : `one per ${node.fanOut.over}, up to ${node.fanOut.cap}`,
    );
  }
  if (takes.length > 0) parts.push(`takes ${names(takes)}`);
  if (gives.length > 0) parts.push(`gives ${names(gives)}`);
  return parts.length > 0 ? parts.join("; ") : "takes and gives nothing";
}

function names(fields: readonly string[]): string {
  const shown = fields.slice(0, NAMED).join(", ");
  return fields.length > NAMED ? `${shown} +${fields.length - NAMED}` : shown;
}
