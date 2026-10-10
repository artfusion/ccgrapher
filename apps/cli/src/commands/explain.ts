// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from "node:fs";
import { parseArgs } from "../args.js";
import { stepLegend } from "@ccgrapher/core";
import { loadGraph } from "@ccgrapher/core/node";
import { ALL_TARGETS, describeFiles, isAnyTarget, isDirectoryTarget } from "@ccgrapher/codegen";
import { layoutGraph } from "@ccgrapher/layout";
import { describeRepair, lint, type Finding } from "@ccgrapher/lint";
import { explainHtml, renderSvg, type ExplainRule } from "@ccgrapher/render-svg";
import { drawable } from "./render.js";

/**
 * One page that explains a spec: the picture, the numbered steps, the files the
 * chosen target would generate, and the lint status. Everything on it comes
 * from the spec and the tools' own output, so it is the same bytes every time.
 */
export function explainCommand(args: string[]): number {
  const { values, positionals } = parseArgs("explain", {
    args,
    options: {
      out: { type: "string", short: "o" },
      target: { type: "string", short: "t", default: "claude-code" },
      /** Describe the repaired graph, and draw it beside the spec as written. */
      fix: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const spec = positionals[0];
  if (!spec) {
    process.stderr.write("ccg explain: no spec file given\n");
    return 2;
  }
  if (positionals.length > 1) {
    process.stderr.write("ccg explain: takes one spec\n");
    return 2;
  }
  const target = values.target;
  if (!isAnyTarget(target)) {
    process.stderr.write(`ccg explain: unknown target '${target}' (expected ${ALL_TARGETS.join(", ")})\n`);
    return 2;
  }

  const original = loadGraph(spec);
  const result = lint(original);
  const fix = values.fix;
  const { graph, marks } = drawable(original, result, fix);
  const steps = stepLegend(graph);

  // The page holds the font once, for every picture on it, and only the main
  // picture has the paper grain: its filter id would repeat in a second one.
  const svg = renderSvg(layoutGraph(graph), { ...marks, header: false, embedFont: false, steps: "numbers" });

  const pair =
    fix && result.repairs.length > 0
      ? {
          before: sheet(drawable(original, result, false)),
          after: sheet({ graph, marks }),
        }
      : undefined;

  const files = describeFiles(graph, target, { specPath: spec });

  const html = explainHtml({
    name: original.spec.name,
    ...(original.spec.goal !== undefined && { goal: original.spec.goal }),
    svg,
    steps,
    repaired: fix,
    target,
    directory: isDirectoryTarget(target),
    files,
    lint: {
      rules: byRule(result.findings),
      layersBefore: result.layersBefore,
      layersAfter: result.layersAfter,
      repairs: result.repairs.map((r) => ({ text: describeRepair(r).replace(/\s+/g, " "), why: r.why })),
    },
    ...(pair && { pair }),
  });

  if (values.out) {
    writeFileSync(values.out, html, "utf8");
    process.stderr.write(
      `wrote ${values.out} — explain, ${steps.length} steps, ${files.length} file${files.length === 1 ? "" : "s"}, ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}\n`,
    );
  } else {
    process.stdout.write(html);
  }
  return 0;
}

function sheet(drawn: ReturnType<typeof drawable>): string {
  return renderSvg(layoutGraph(drawn.graph), { ...drawn.marks, header: false, embedFont: false, grain: false });
}

/** The findings as `ccg lint` reports them, grouped under each rule in the order it first appears. */
function byRule(findings: readonly Finding[]): ExplainRule[] {
  const groups = new Map<string, { severity: Finding["severity"]; messages: string[] }>();
  for (const f of findings) {
    const group = groups.get(f.rule) ?? { severity: f.severity, messages: [] };
    group.messages.push(f.phase === "repaired" ? `${f.message} (after repair)` : f.message);
    groups.set(f.rule, group);
  }
  return [...groups].map(([rule, g]) => ({ rule, severity: g.severity, messages: g.messages }));
}
