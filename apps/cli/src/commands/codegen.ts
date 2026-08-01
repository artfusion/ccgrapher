// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { withEdges } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { codegen, codegenWarnings, isTarget, TARGETS } from "@ccgrapher/codegen";
import { lint } from "@ccgrapher/lint";

export function codegenCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: {
      out: { type: "string", short: "o" },
      target: { type: "string", short: "t", default: "claude-code" },
      /** Generate from the repaired graph rather than the graph as written. */
      fix: { type: "boolean", default: false },
      banner: { type: "boolean", default: true },
    },
    allowPositionals: true,
    // Node's parseArgs needs this for `--no-header` and friends.
    allowNegative: true,
  });

  const spec = positionals[0];
  if (!spec) {
    process.stderr.write("ccg codegen: no spec file given\n");
    return 2;
  }

  const target = values.target;
  if (!isTarget(target)) {
    process.stderr.write(`ccg codegen: unknown target '${target}' (expected ${TARGETS.join(", ")})\n`);
    return 2;
  }

  const original = loadGraph(spec);
  const result = lint(original);

  // Generating from a graph with known-fake edges bakes the wasted waits into
  // the runtime, so say so.
  const fakes = result.findings.filter((f) => f.rule === "FAKE_EDGE").length;
  if (fakes > 0 && !values.fix) {
    process.stderr.write(
      `ccg codegen: ${spec} has ${fakes} fake edge${fakes === 1 ? "" : "s"} — the generated code will wait for nothing. Pass --fix to generate from the repaired graph.\n`,
    );
  }

  const graph = values.fix ? withEdges(original, result.repairedEdges) : original;

  for (const warning of codegenWarnings(graph, target)) {
    process.stderr.write(`ccg codegen: ${spec}: ${warning}\n`);
  }

  const code = codegen(graph, target, { banner: values.banner, specPath: spec });

  if (values.out) {
    writeFileSync(values.out, code, "utf8");
    process.stderr.write(`wrote ${values.out} — ${target}, ${graph.nodes.size} nodes\n`);
  } else {
    process.stdout.write(code);
  }
  return 0;
}
