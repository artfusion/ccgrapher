// SPDX-License-Identifier: Apache-2.0
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  heatFromRunStats,
  statsFromLines,
  type Aggregate,
  type TraceHeatMetric,
  type TraceLine,
} from "@ccgrapher/trace";
import { readTrace } from "@ccgrapher/trace/node";

const HEAT_METRICS: readonly TraceHeatMetric[] = ["duration-ms", "cost-usd"];

/**
 * `ccg trace <subcommand>`.
 *
 * Only `stats` exists today. This stays a dispatcher rather than `stats`
 * folding straight into `ccg trace` so a later trace subcommand has somewhere
 * to land without a new top-level `ccg` command.
 */
export function traceCommand(args: string[]): number {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "stats":
      return traceStatsCommand(rest);
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
  const { values, positionals } = parseArgs({
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
