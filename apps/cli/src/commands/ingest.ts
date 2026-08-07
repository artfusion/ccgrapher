// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "../args.js";
import { buildGraph, formatSpec } from "@ccgrapher/core";
import { ingest } from "@ccgrapher/ingest";
import { formatReport, lint } from "@ccgrapher/lint";

export function ingestCommand(args: string[]): number {
  const { values, positionals } = parseArgs("ingest", {
    args,
    options: {
      out: { type: "string", short: "o" },
      name: { type: "string" },
      /** Lint the reconstructed graph straight away. */
      lint: { type: "boolean", default: false },
      color: { type: "boolean", default: process.stdout.isTTY ?? false },
    },
    allowPositionals: true,
    // Node's parseArgs needs this for `--no-header` and friends.
    allowNegative: true,
  });

  const path = positionals[0];
  if (!path) {
    process.stderr.write("ccg ingest: no source file given\n");
    return 2;
  }

  const { spec, warnings } = ingest(readFileSync(path, "utf8"), {
    ...(values.name ? { name: values.name } : {}),
  });

  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  if (spec.nodes.length === 0) return 2;

  const yaml = formatSpec(spec);
  if (values.out) {
    writeFileSync(values.out, yaml, "utf8");
    process.stderr.write(
      `wrote ${values.out} — ${spec.nodes.length} nodes, ${spec.edges.length} edges\n`,
    );
  } else if (!values.lint) {
    process.stdout.write(yaml);
  }

  if (values.lint) {
    // The whole point of reading code back: audit what it actually does.
    const graph = buildGraph(spec);
    const result = lint(graph);
    process.stdout.write(`${formatReport(graph, result, { color: values.color })}\n`);
    return result.findings.some((f) => f.severity === "error") ? 1 : 0;
  }

  return 0;
}
