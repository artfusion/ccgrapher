// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

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
 */
export interface Aggregate {
  readonly count: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly costUsd?: number;
}

/**
 * A run rolled up two ways.
 *
 * `nodes` is keyed by node id. `models` is keyed by the `usage.model` string the
 * run reported: a trace records what ran, so it never sorts a model into core's
 * cheap/strong tiers — that is the spec's vocabulary, not the run's. Runs that
 * reported no model count in `nodes` and are left out of `models` rather than
 * filed under an invented key.
 */
export interface RunStats {
  readonly runId: string;
  readonly nodes: Readonly<Record<string, Aggregate>>;
  readonly models: Readonly<Record<string, Aggregate>>;
}
