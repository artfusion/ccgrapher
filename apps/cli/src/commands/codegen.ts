// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "../args.js";
import { withEdges } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import {
  ALL_TARGETS,
  codegen,
  codegenFiles,
  codegenWarnings,
  isAnyTarget,
  isDirectoryTarget,
} from "@ccgrapher/codegen";
import { lint } from "@ccgrapher/lint";

export function codegenCommand(args: string[]): number {
  const { values, positionals } = parseArgs("codegen", {
    args,
    options: {
      out: { type: "string", short: "o" },
      target: { type: "string", short: "t", default: "claude-code" },
      /** Generate from the repaired graph rather than the graph as written. */
      fix: { type: "boolean", default: false },
      banner: { type: "boolean", default: true },
      /** A directory target may write into a directory that already has files in it. */
      force: { type: "boolean", default: false },
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
  if (!isAnyTarget(target)) {
    process.stderr.write(`ccg codegen: unknown target '${target}' (expected ${ALL_TARGETS.join(", ")})\n`);
    return 2;
  }

  // A directory cannot go to stdout, and writing into one that already holds
  // files would mix generated agents with whatever else is there, so both are
  // refused before any work is done.
  if (isDirectoryTarget(target)) {
    if (!values.out) {
      process.stderr.write(`ccg codegen: the ${target} target writes a directory; pass -o <dir>\n`);
      return 2;
    }
    if (existsSync(values.out)) {
      if (!statSync(values.out).isDirectory()) {
        process.stderr.write(`ccg codegen: ${values.out} is a file, and the ${target} target writes a directory\n`);
        return 2;
      }
      if (!values.force && readdirSync(values.out).length > 0) {
        process.stderr.write(
          `ccg codegen: ${values.out} is not empty; pass --force to write into it (only the generated files are replaced)\n`,
        );
        return 2;
      }
    }
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

  if (isDirectoryTarget(target)) {
    const dir = values.out!;
    const files = codegenFiles(graph, target, { banner: values.banner, specPath: spec });
    // --force writes over the generated paths and leaves every other file alone.
    for (const [path, content] of Object.entries(files)) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
    }
    const count = Object.keys(files).length;
    process.stderr.write(`wrote ${dir} — ${target}, ${count} file${count === 1 ? "" : "s"}\n`);
    return 0;
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
