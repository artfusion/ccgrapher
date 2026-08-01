// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { TraceLine } from "./codec.js";

/**
 * A per-node tint, keyed by node id.
 *
 * `metric` says what the numbers mean, `unit` how to format them, `source`
 * where they came from — a trace file, a provider's billing export, a guess
 * somebody typed in. All three are required, because an overlay whose
 * provenance is unstated is an overlay nobody should trust.
 *
 * Nodes absent from `values` are unmeasured, not zero. Draw them uncoloured.
 * And this only ever tints: core computes ranks, layout computes pixels, and a
 * heat file never moves a node.
 */
export const HeatData = z.object({
  v: z.literal(1),
  metric: z.string().min(1),
  unit: z.string().min(1),
  source: z.string().min(1),
  values: z.record(z.string(), z.number()),
});
export type HeatData = z.infer<typeof HeatData>;

/**
 * One group of finished node runs, rolled up.
 *
 * `median` and `mean` are both here because a fan-out of ten with one straggler
 * has two honest answers and picking one for the reader would hide the shape.
 * `costUsd` is the sum of the costs that were actually reported, and is absent
 * when nothing in the group reported one.
 *
 * `count` is the number of finished instances that fed the roll-up — not the
 * number of runs. A node fanned out ten times in one run contributes ten here;
 * the same node touched by three separate runs, once each, also contributes
 * three. Either way it is the sample size behind `median`/`mean`, which is what
 * a reader needs to judge whether to trust them. (`RunStats.runIds.length`
 * answers the separate question of how many runs were pooled to produce this.)
 */
export interface Aggregate {
  readonly count: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly costUsd?: number;
}

/**
 * One or more runs rolled up two ways.
 *
 * `nodes` is keyed by node id. `models` is keyed by the `usage.model` string the
 * run reported: a trace records what ran, so it never sorts a model into core's
 * cheap/strong tiers — that is the spec's vocabulary, not the run's. Runs that
 * reported no model count in `nodes` and are left out of `models` rather than
 * filed under an invented key.
 *
 * `runIds` replaces what was originally a single `runId`: the same shape has to
 * describe both "here is what one run did" (`ccg trace stats <file>`, where it
 * holds one id) and "here is what a directory of runs did, pooled" (aggregating
 * a whole history for a projection, where it holds every id that contributed).
 * A single `runId` could not say the second thing honestly, so it became a list
 * rather than the aggregation growing a second, near-identical type.
 */
export interface RunStats {
  readonly runIds: readonly string[];
  readonly nodes: Readonly<Record<string, Aggregate>>;
  readonly models: Readonly<Record<string, Aggregate>>;
}

/** `sorted` must be non-empty and already sorted ascending. */
function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface Samples {
  readonly durations: number[];
  readonly costs: number[];
}

function bucket(store: Map<string, Samples>, key: string): Samples {
  let entry = store.get(key);
  if (entry === undefined) {
    entry = { durations: [], costs: [] };
    store.set(key, entry);
  }
  return entry;
}

interface Collected {
  readonly runIds: ReadonlySet<string>;
  readonly nodes: ReadonlyMap<string, Samples>;
  readonly models: ReadonlyMap<string, Samples>;
}

/**
 * Walks a trace (or several, concatenated) once, sorting every recorded
 * duration and cost into the node and model it belongs to.
 *
 * A failed instance's duration is kept when the writer reported one — it is a
 * real measurement of how long the attempt ran, and dropping it would bias the
 * survivors' numbers optimistic. `NodeFailed` carries no `usage`, so a failure
 * never contributes a cost or a model; there is nothing there to keep.
 *
 * Lines this reader does not understand, or that carry no duration at all
 * (a node still `running`, or failed before it was timed), contribute nothing.
 * That is the point: absence stays absence instead of becoming a zero.
 */
function collect(lines: readonly TraceLine[]): Collected {
  const runIds = new Set<string>();
  const nodes = new Map<string, Samples>();
  const models = new Map<string, Samples>();

  for (const line of lines) {
    if (line.type === "unknown") continue;
    runIds.add(line.runId);

    if (line.type === "node_finished") {
      const node = bucket(nodes, line.node);
      node.durations.push(line.durationMs);
      const cost = line.usage?.costUsd;
      if (cost !== undefined) node.costs.push(cost);

      const model = line.usage?.model;
      if (model !== undefined) {
        const forModel = bucket(models, model);
        forModel.durations.push(line.durationMs);
        if (cost !== undefined) forModel.costs.push(cost);
      }
    } else if (line.type === "node_failed" && line.durationMs !== undefined) {
      bucket(nodes, line.node).durations.push(line.durationMs);
    }
  }

  return { runIds, nodes, models };
}

/** `undefined` when there is nothing to aggregate, rather than a zeroed-out `Aggregate`. */
function rollUp(samples: Samples): Aggregate | undefined {
  if (samples.durations.length === 0) return undefined;
  const sorted = [...samples.durations].sort((a, b) => a - b);
  const meanMs = sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length;
  const base = { count: sorted.length, meanMs, medianMs: median(sorted) };
  // The key itself is left off rather than set to `undefined`, so a consumer
  // that checks `"costUsd" in aggregate` gets the same honest answer as one
  // that checks `aggregate.costUsd !== undefined`.
  return samples.costs.length > 0
    ? { ...base, costUsd: samples.costs.reduce((sum, c) => sum + c, 0) }
    : base;
}

function rollUpAll(store: ReadonlyMap<string, Samples>): Record<string, Aggregate> {
  const out: Record<string, Aggregate> = {};
  for (const [key, samples] of store) {
    const agg = rollUp(samples);
    if (agg !== undefined) out[key] = agg;
  }
  return out;
}

/**
 * Rolls a trace up into `RunStats`.
 *
 * Pass one run's lines for `ccg trace stats <file>`, or the concatenated lines
 * of every file in a directory to pool a whole history. Pooling is deliberately
 * just "concatenate first, aggregate once": computing the median of several
 * runs' medians would compress the distribution twice and quietly hide the
 * shape a single honest median over the raw samples would show. `runIds`
 * collects whichever run ids were actually seen, so the caller always knows how
 * many runs fed the numbers.
 */
export function statsFromLines(lines: readonly TraceLine[]): RunStats {
  const { runIds, nodes, models } = collect(lines);
  return {
    runIds: [...runIds].sort(),
    nodes: rollUpAll(nodes),
    models: rollUpAll(models),
  };
}

/** What `ccg trace stats --heat` can tint by. */
export type TraceHeatMetric = "duration-ms" | "cost-usd";

const HEAT_UNIT: Readonly<Record<TraceHeatMetric, string>> = {
  "duration-ms": "ms",
  "cost-usd": "usd",
};

/**
 * Turns rolled-up node stats into a heat overlay.
 *
 * `duration-ms` tints every node that reported a duration (its median).
 * `cost-usd` only ever tints the nodes that actually reported a cost — most
 * runs will not have priced every node, and a sparse `values` map is the
 * honest shape for that, never a 0 standing in for "didn't say".
 */
export function heatFromRunStats(stats: RunStats, metric: TraceHeatMetric, source: string): HeatData {
  const values: Record<string, number> = {};
  for (const [id, agg] of Object.entries(stats.nodes)) {
    if (metric === "duration-ms") {
      values[id] = agg.medianMs;
    } else if (agg.costUsd !== undefined) {
      values[id] = agg.costUsd;
    }
  }
  return { v: 1, metric, unit: HEAT_UNIT[metric], source, values };
}
