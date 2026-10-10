// SPDX-License-Identifier: Apache-2.0
import type { NodeSpec } from "@ccgrapher/core";

/**
 * A step whose inputs all exist and which is waiting for a slot.
 *
 * One fanned instance is one step: each is a separate call to the executor and
 * occupies a slot of its own. A gate never appears here, because a human
 * deciding is not work and takes no slot.
 */
export interface ReadyStep {
  readonly node: NodeSpec;
  /** The node's rank, from `rankGraph`. */
  readonly rank: number;
  /** Where the node sits in the spec, counting from zero. */
  readonly order: number;
  /** Present only for a fanned node. */
  readonly instance?: number;
  /**
   * The weight of the node's effective priority (`PRIORITY_WEIGHT`), its own or
   * inherited from a step that waits on it. Absent is normal.
   */
  readonly priority?: number;
}

/**
 * Which ready step gets the next free slot.
 *
 * This is the only place the order of ready work is decided, so it is kept to
 * one small function. Readiness says what may start; this says what starts
 * first when more is ready than there are slots, and in which order steps that
 * became ready together are started at all, which is what makes a trace
 * reproducible.
 *
 * Higher effective priority first, then lower rank, then spec order, then
 * instance. Priority first because that is what it is for, and it only ever
 * chooses among steps that are already ready: it cannot start a step early or
 * stop one that is running. Rank next because a step nearer the top of the
 * graph usually has more waiting on it; spec order because it is the order the
 * author wrote; instance last so a fanned node's instances start together and
 * in order. With no priority anywhere the first term is always zero, and the
 * order is exactly what it was before priority existed.
 */
export function readyOrder(a: ReadyStep, b: ReadyStep): number {
  return (
    (b.priority ?? 0) - (a.priority ?? 0) ||
    a.rank - b.rank ||
    a.order - b.order ||
    (a.instance ?? 0) - (b.instance ?? 0)
  );
}
