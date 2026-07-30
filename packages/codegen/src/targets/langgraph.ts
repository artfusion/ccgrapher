// SPDX-License-Identifier: Apache-2.0
import type { Graph, NodeSpec } from "@ccgrapher/core";
import { roots } from "@ccgrapher/core";
import { tsType } from "../fields.js";
import { banner, identifier, quote, type Emitter, type EmitOptions } from "../types.js";

/**
 * LangGraph derives its own concurrency from the edge set: a node with several
 * outgoing edges fans out, and a node with several incoming edges waits for all
 * of them. So this target emits the edges verbatim and lets the runtime do what
 * the diagram shows.
 */
export const langgraphEmitter: Emitter = {
  target: "langgraph",
  extension: ".graph.ts",

  emit(graph: Graph, options: EmitOptions): string {
    const lines: string[] = [...banner(graph, options, "langgraph")];

    lines.push(
      `import { Annotation, END, START, StateGraph } from "@langchain/langgraph";`,
      "",
      "// Every field any node declares, merged into one state channel set.",
      "export const State = Annotation.Root({",
      ...channels(graph),
      "});",
      "",
      "type StateType = typeof State.State;",
      "",
    );

    for (const node of graph.spec.nodes) {
      lines.push(
        `/** ${node.label} — ${node.kind}${node.model === null ? ", plain code" : ""}. */`,
        `async function ${identifier(node.id)}(state: StateType): Promise<Partial<StateType>> {`,
        `  void state;`,
        `  throw new Error(${quote(`${node.id}: not implemented`)});`,
        "}",
        "",
      );
    }

    lines.push(`export const workflow = new StateGraph(State)`);
    for (const node of graph.spec.nodes) {
      lines.push(`  .addNode(${quote(node.id)}, ${identifier(node.id)})`);
    }

    for (const root of roots(graph)) {
      lines.push(`  .addEdge(START, ${quote(root.id)})`);
    }
    for (const edge of graph.spec.edges) {
      lines.push(`  .addEdge(${quote(edge.from)}, ${quote(edge.to)})`);
    }
    for (const leaf of leaves(graph)) {
      lines.push(`  .addEdge(${quote(leaf.id)}, END)`);
    }

    lines.push("  .compile();", "");

    const fanOuts = graph.spec.nodes.filter((n) => n.fanOut);
    if (fanOuts.length > 0) {
      lines.push(
        "// fanOut nodes map over a list. LangGraph's Send API is the idiomatic",
        "// way to do that; each of these needs a conditional edge dispatching one",
        "// Send per item:",
        ...fanOuts.map(
          (n) =>
            `//   ${n.id}: over ${n.fanOut!.over}${n.fanOut!.cap ? `, cap ${n.fanOut!.cap}` : ""}`,
        ),
        "",
      );
    }

    const guarded = graph.spec.nodes.filter((n) => n.expects !== undefined);
    if (guarded.length > 0) {
      lines.push(
        "// Fan-in guards — check these before synthesising, or a dead upstream",
        "// node produces a report that looks complete:",
        ...guarded.map((n) => `//   ${n.id}: expects ${n.expects}`),
        "",
      );
    }

    return lines.join("\n");
  },
};

/** One channel per distinct field name across the whole spec. */
function channels(graph: Graph): string[] {
  const fields = new Map<string, string>();
  for (const node of graph.spec.nodes) {
    for (const [name, descriptor] of Object.entries({ ...node.in, ...node.out })) {
      fields.set(name, descriptor);
    }
  }

  // A field several nodes write concurrently has to accumulate, not overwrite.
  const concurrent = concurrentlyWritten(graph);

  return [...fields.entries()].map(([name, descriptor]) => {
    const type = tsType(descriptor);
    return concurrent.has(name)
      ? `  ${name}: Annotation<${type}[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),`
      : `  ${name}: Annotation<${type}>(),`;
  });
}

function concurrentlyWritten(graph: Graph): Set<string> {
  const writers = new Map<string, number>();
  for (const node of graph.spec.nodes) {
    const times = node.fanOut ? 2 : 1;
    for (const name of Object.keys(node.out)) {
      writers.set(name, (writers.get(name) ?? 0) + times);
    }
  }
  return new Set([...writers.entries()].filter(([, n]) => n > 1).map(([name]) => name));
}

function leaves(graph: Graph): NodeSpec[] {
  return graph.spec.nodes.filter((n) => (graph.outbound.get(n.id) ?? []).length === 0);
}
