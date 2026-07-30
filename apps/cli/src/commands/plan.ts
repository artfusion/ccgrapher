// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from "node:util";
import { withEdges, type Graph } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { stages } from "@ccgrapher/codegen";
import { lint } from "@ccgrapher/lint";

/**
 * Answers the only question an orchestrator actually has: what can I start
 * right now, and what has to wait?
 *
 * `lint` tells you what is wrong with a workflow. `plan` tells you how to run
 * it — one line per wave, with the nodes in each wave that have no dependency
 * on one another. That is the output an agent can act on directly.
 */
export function planCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: {
      /** Plan the repaired graph rather than the graph as written. */
      fix: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      color: { type: "boolean", default: process.stdout.isTTY ?? false },
    },
    allowPositionals: true,
    allowNegative: true,
  });

  const spec = positionals[0];
  if (!spec) {
    process.stderr.write("ccg plan: no spec file given\n");
    return 2;
  }

  const original = loadGraph(spec);
  const result = lint(original);
  const graph: Graph = values.fix ? withEdges(original, result.repairedEdges) : original;

  const waves = stages(graph);
  const nodeCount = graph.nodes.size;
  const concurrent = waves.filter((s) => s.nodes.length > 1);
  const widest = Math.max(...waves.map((s) => s.nodes.length));

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          spec,
          name: graph.spec.name,
          repaired: values.fix,
          waves: waves.map((s) => ({
            wave: s.rank + 1,
            concurrent: s.nodes.length > 1,
            nodes: s.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind })),
          })),
          waveCount: waves.length,
          nodeCount,
          sequentialWouldBe: nodeCount,
          savedIfRepaired: result.layersBefore - result.layersAfter,
          findings: result.findings.length,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const c = (code: string, text: string) => (values.color ? `[${code}m${text}[0m` : text);
  const out: string[] = [];

  out.push(
    c("1", graph.spec.goal ? `${graph.spec.name} — ${graph.spec.goal}` : graph.spec.name),
    "",
  );

  const width = String(waves.length).length;
  for (const wave of waves) {
    const n = String(wave.rank + 1).padStart(width);
    const tag = wave.nodes.length > 1 ? c("38;5;173", `×${wave.nodes.length} together`) : "           ";
    out.push(`  wave ${n}  ${tag}  ${wave.nodes.map((x) => x.id).join(", ")}`);
  }

  out.push("");
  out.push(
    `  ${c("1", String(waves.length))} waves for ${nodeCount} steps` +
      (nodeCount > waves.length
        ? ` — ${nodeCount - waves.length} fewer than doing them one at a time`
        : ""),
  );
  if (concurrent.length > 0) {
    out.push(`  ${concurrent.length} wave(s) run concurrently, widest is ${widest}`);
  }

  // The number only means something if the edges are real.
  if (!values.fix && result.layersAfter < result.layersBefore) {
    out.push(
      "",
      `  ${c("33", "!")} ${result.repairs.length} edge(s) here carry no data, inflating this to ${result.layersBefore} waves.`,
      `    Real shape is ${result.layersAfter}. Re-run with --fix, or ccg lint to see them.`,
    );
  }

  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}
