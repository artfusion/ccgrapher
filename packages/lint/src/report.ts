// SPDX-License-Identifier: Apache-2.0
import type { Graph } from "@ccgrapher/core";
import type { LintResult, Repair } from "./types.js";

export interface ReportOptions {
  /** Emit ANSI colour. Off by default so snapshots stay readable. */
  readonly color?: boolean;
}

const ANSI = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  yellow: "[33m",
  green: "[32m",
  orange: "[38;5;173m",
} as const;

export function formatReport(
  graph: Graph,
  result: LintResult,
  options: ReportOptions = {},
): string {
  const c = (code: keyof typeof ANSI, text: string) =>
    options.color ? `${ANSI[code]}${text}${ANSI.reset}` : text;

  const lines: string[] = [];
  const title = graph.spec.goal
    ? `${graph.spec.name} — ${graph.spec.goal}`
    : graph.spec.name;
  lines.push(c("bold", title), "");

  if (result.findings.length === 0) {
    lines.push(`  ${c("green", "✓")} no findings`);
  } else {
    const width = Math.max(...result.findings.map((f) => f.rule.length));
    for (const f of result.findings) {
      const tag = f.severity === "error" ? c("red", "error") : c("yellow", " warn");
      const rule = c("orange", f.rule.padEnd(width));
      const phase = f.phase === "repaired" ? c("dim", " (after repair)") : "";
      lines.push(`  ${tag}  ${rule}  ${f.message}${phase}`);
    }
  }

  if (result.repairs.length > 0) {
    lines.push("", c("bold", "  Proposed repairs"));
    for (const repair of result.repairs) {
      lines.push(`    ${describeRepair(repair)}`);
      lines.push(`      ${c("dim", repair.why)}`);
    }
  }

  lines.push("");
  const delta = result.layersBefore - result.layersAfter;
  const path =
    delta > 0
      ? `  Critical path: ${result.layersBefore} layers ${c("orange", "->")} ${c("bold", `${result.layersAfter} layers`)} (${delta} fewer after repair)`
      : `  Critical path: ${result.layersBefore} layers`;
  lines.push(path);

  const errors = result.findings.filter((f) => f.severity === "error").length;
  const warnings = result.findings.length - errors;
  if (result.findings.length > 0) {
    lines.push(
      `  ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`,
    );
  }

  return lines.join("\n");
}

function describeRepair(repair: Repair): string {
  if (repair.kind === "drop") {
    return `drop     ${repair.from} -> ${repair.to}`;
  }
  const carries = repair.carries.map((f) => `'${f}'`).join(", ");
  if (repair.newFrom === repair.from) {
    return `carry    ${repair.from} -> ${repair.to} now carries ${carries}`;
  }
  return `repoint  ${repair.from} -> ${repair.to} becomes ${repair.newFrom} -> ${repair.to}, carrying ${carries}`;
}
