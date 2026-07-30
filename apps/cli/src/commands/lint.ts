// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from "node:util";
import { loadGraph } from "@ccgrapher/core/node";
import { formatReport, lint } from "@ccgrapher/lint";

export function lintCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
      color: { type: "boolean", default: process.stdout.isTTY ?? false },
      quiet: { type: "boolean", default: false },
    },
    allowPositionals: true,
    // Node's parseArgs needs this for `--no-header` and friends.
    allowNegative: true,
  });

  if (positionals.length === 0) {
    process.stderr.write("ccg lint: no spec files given\n");
    return 2;
  }

  let errors = 0;
  const reports: unknown[] = [];

  for (const path of positionals) {
    const graph = loadGraph(path);
    const result = lint(graph);
    errors += result.findings.filter((f) => f.severity === "error").length;

    if (values.json) {
      reports.push({
        spec: path,
        name: graph.spec.name,
        findings: result.findings,
        repairs: result.repairs,
        layersBefore: result.layersBefore,
        layersAfter: result.layersAfter,
      });
    } else if (!values.quiet) {
      process.stdout.write(`${formatReport(graph, result, { color: values.color })}\n\n`);
    }
  }

  if (values.json) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  return errors > 0 ? 1 : 0;
}
