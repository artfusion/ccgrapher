// SPDX-License-Identifier: Apache-2.0
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../args.js";
import {
  heatFromRunStats,
  statsFromLines,
  type Aggregate,
  type TraceHeatMetric,
  type TraceLine,
} from "@ccgrapher/trace";
import { readTrace } from "@ccgrapher/trace/node";
import { loadGraph } from "@ccgrapher/core/node";
import { audit, type AuditFinding } from "@ccgrapher/lint";

const HEAT_METRICS: readonly TraceHeatMetric[] = ["duration-ms", "cost-usd"];

/**
 * `ccg trace <subcommand>`.
 *
 * `stats` asks what a run cost. `audit` asks whether it did what its spec said
 * it would need. Both read the same trace, and neither is the other's flag.
 */
export function traceCommand(args: string[]): number {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "stats":
      return traceStatsCommand(rest);
    case "audit":
      return traceAuditCommand(rest);
    default:
      process.stderr.write(
        `ccg trace: unknown subcommand '${subcommand ?? ""}' — try 'ccg trace stats <run.jsonl>'\n`,
      );
      return 2;
  }
}

/** A single run file, or every `.jsonl` file in a directory, pooled by concatenation. */
function readLines(path: string): readonly TraceLine[] {
  if (!statSync(path).isDirectory()) return readTrace(path);
  const files = readdirSync(path)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  return files.flatMap((name) => readTrace(join(path, name)));
}

/** Every node id ever mentioned, whether or not it went on to record a duration. */
function nodeIdsIn(lines: readonly TraceLine[]): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.type !== "unknown" && "node" in line && typeof line.node === "string") {
      ids.add(line.node);
    }
  }
  return [...ids].sort();
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** One line of the human-readable summary. `undefined` is printed as an explicit marker, never a 0. */
function formatNode(id: string, agg: Aggregate | undefined): string {
  const label = id.padEnd(24);
  if (agg === undefined) return `  ${label}  no duration recorded`;
  const duration =
    agg.count > 1
      ? `median ${formatDuration(agg.medianMs)} (mean ${formatDuration(agg.meanMs)}, n=${agg.count})`
      : formatDuration(agg.medianMs);
  const cost = agg.costUsd === undefined ? "cost n/a" : `cost ${formatCost(agg.costUsd)}`;
  return `  ${label}  ${duration.padEnd(36)}${cost}`;
}

/**
 * Human-readable and `--heat` producer for one run's trace, or a directory of
 * them.
 *
 * A directory is pooled by concatenating every `.jsonl` file before rolling
 * up, so a node fanned across several runs gets one honest median over every
 * instance rather than an average of per-run averages. See `statsFromLines`.
 */
export function traceStatsCommand(args: string[]): number {
  const { values, positionals } = parseArgs("trace stats", {
    args,
    options: {
      json: { type: "boolean", default: false },
      /** Write a HeatData overlay here instead of (or alongside) the summary. */
      heat: { type: "string" },
      metric: { type: "string", default: "duration-ms" satisfies TraceHeatMetric },
    },
    allowPositionals: true,
    allowNegative: true,
  });

  const path = positionals[0];
  if (!path) {
    process.stderr.write("ccg trace stats: no run file or directory given\n");
    return 2;
  }

  if (!(HEAT_METRICS as readonly string[]).includes(values.metric)) {
    process.stderr.write(`ccg trace stats: --metric must be one of ${HEAT_METRICS.join(", ")}\n`);
    return 2;
  }
  const metric = values.metric as TraceHeatMetric;

  const lines = readLines(path);
  const stats = statsFromLines(lines);

  if (values.heat) {
    const heat = heatFromRunStats(stats, metric, `ccg trace stats ${path}`);
    writeFileSync(values.heat, `${JSON.stringify(heat, null, 2)}\n`, "utf8");
    const measured = Object.keys(heat.values).length;
    process.stderr.write(`wrote ${values.heat} — ${metric} for ${measured} node(s)\n`);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return 0;
  }

  const runLabel =
    stats.runIds.length === 0
      ? "no run events"
      : stats.runIds.length === 1
        ? `run ${stats.runIds[0]}`
        : `${stats.runIds.length} runs (${stats.runIds.join(", ")})`;
  const out: string[] = [`${path} — ${runLabel}`, ""];

  const ids = nodeIdsIn(lines);
  if (ids.length === 0) {
    out.push("  (no nodes recorded)");
  } else {
    for (const id of ids) out.push(formatNode(id, stats.nodes[id]));
  }

  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

/** True when nothing in the trace said anything about a capability at all. */
function mentionsCapabilities(lines: readonly TraceLine[]): boolean {
  return lines.some((line) => line.type !== "unknown" && line.type.startsWith("capability_"));
}

function formatAuditFindings(findings: readonly AuditFinding[]): string[] {
  if (findings.length === 0) return ["  ✓ no findings"];
  const width = Math.max(...findings.map((f) => f.rule.length));
  return findings.map(
    (f) => `  ${f.severity === "error" ? "error" : " warn"}  ${f.rule.padEnd(width)}  ${f.message}`,
  );
}

/**
 * `ccg trace audit <run.jsonl|dir> --spec <spec.yaml>`.
 *
 * Holds a run against the capabilities its spec declares. A directory is pooled
 * the way `stats` pools one, so a whole history of runs reports each
 * disagreement once rather than once per run.
 */
export function traceAuditCommand(args: string[]): number {
  const { values, positionals } = parseArgs("trace audit", {
    args,
    options: {
      spec: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    allowNegative: true,
  });

  const path = positionals[0];
  if (!path) {
    process.stderr.write("ccg trace audit: no run file or directory given\n");
    return 2;
  }
  if (!values.spec) {
    process.stderr.write("ccg trace audit: --spec <spec.yaml> is required — an audit needs both sides\n");
    return 2;
  }

  const graph = loadGraph(values.spec);
  const lines = readLines(path);
  const result = audit(lines, graph);

  if (values.json) {
    const report = {
      spec: values.spec,
      name: graph.spec.name,
      findings: result.findings,
      runIds: result.runIds,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const title = graph.spec.goal ? `${graph.spec.name} — ${graph.spec.goal}` : graph.spec.name;
    const runLabel =
      result.runIds.length === 0
        ? "no run events"
        : result.runIds.length === 1
          ? `run ${result.runIds[0]}`
          : `${result.runIds.length} runs (${result.runIds.join(", ")})`;

    const out = [title, `${path} — ${runLabel}`, "", ...formatAuditFindings(result.findings), ""];

    // Silence from a trace that never mentioned a capability is not a clean
    // bill of health, and saying so is cheaper than someone assuming otherwise.
    if (!mentionsCapabilities(lines)) {
      out.push("  This trace reported no capability events at all — nothing here was checked.");
    }

    const errors = result.findings.filter((f) => f.severity === "error").length;
    const warnings = result.findings.length - errors;
    if (result.findings.length > 0) {
      out.push(
        `  ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`,
      );
    }

    process.stdout.write(`${out.join("\n")}\n`);
  }

  return result.findings.some((f) => f.severity === "error") ? 1 : 0;
}
