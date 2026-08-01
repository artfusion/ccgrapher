// SPDX-License-Identifier: Apache-2.0
import type { TraceLine } from "./codec.js";
import type { Usage } from "./schema.js";

/**
 * How many recent log lines a node keeps.
 *
 * A ring buffer, not a log store: the fold is a live view, and a canvas showing
 * the last few lines under a node has no use for the ten thousand before them.
 * The full output is in the trace file, which is the thing to read when you want
 * all of it.
 */
export const TAIL_CAP = 200;

export type RunStatus = "running" | "done" | "failed";

/**
 * `partial` is a fanned node with some instances landed and some still out.
 * `waiting` is a gate blocked on a human, which is not the same as running and
 * should never be drawn as if work were happening.
 */
export type NodeStatus = "pending" | "running" | "waiting" | "done" | "failed" | "partial";

export interface InstanceCounts {
  readonly done: number;
  readonly failed: number;
  readonly of: number;
}

export interface NodeRunState {
  readonly status: NodeStatus;
  readonly startedAt?: string;
  /**
   * For a single-shot node, what the trace reported. For a fanned node, the
   * slowest instance seen so far — instances run concurrently, so summing them
   * would invent wall-clock time nobody spent.
   */
  readonly durationMs?: number;
  readonly instances?: InstanceCounts;
  readonly usage?: Usage;
  readonly tail: readonly string[];
  readonly error?: string;
}

export interface RunState {
  readonly runId: string;
  readonly status: RunStatus;
  readonly spec?: { readonly name: string; readonly hash?: string };
  readonly nodes: ReadonlyMap<string, NodeRunState>;
}

/**
 * A run nobody has told us anything about yet.
 *
 * `status` starts at `running`, because a run whose start event has not arrived
 * is not finished and is certainly not failed.
 */
export function emptyRunState(runId: string): RunState {
  return { runId, status: "running", nodes: new Map() };
}

const PENDING: NodeRunState = { status: "pending", tail: [] };

function withNode(
  state: RunState,
  id: string,
  patch: (node: NodeRunState) => NodeRunState,
): RunState {
  const nodes = new Map(state.nodes);
  nodes.set(id, patch(nodes.get(id) ?? PENDING));
  return { ...state, nodes };
}

/** A fanned node's status is entirely a function of how many instances have landed. */
function statusFor(instances: InstanceCounts | undefined): NodeStatus | undefined {
  if (!instances) return undefined;
  const settled = instances.done + instances.failed;
  if (settled < instances.of) return settled === 0 ? "running" : "partial";
  return instances.failed > 0 ? "failed" : "done";
}

/** Additive where present. Absent stays absent — an unknown is never coerced to 0. */
function addKnown(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

function mergeUsage(prev: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (!prev) return next;
  if (!next) return prev;
  const merged: Usage = {};
  const model = next.model ?? prev.model;
  if (model !== undefined) merged.model = model;
  const inputTokens = addKnown(prev.inputTokens, next.inputTokens);
  if (inputTokens !== undefined) merged.inputTokens = inputTokens;
  const outputTokens = addKnown(prev.outputTokens, next.outputTokens);
  if (outputTokens !== undefined) merged.outputTokens = outputTokens;
  const costUsd = addKnown(prev.costUsd, next.costUsd);
  if (costUsd !== undefined) merged.costUsd = costUsd;
  return merged;
}

function mergeDuration(
  prev: number | undefined,
  next: number | undefined,
  fanned: boolean,
): number | undefined {
  if (next === undefined) return prev;
  if (!fanned || prev === undefined) return next;
  return Math.max(prev, next);
}

function capTail(tail: readonly string[], line: string): readonly string[] {
  const next = [...tail, line];
  return next.length <= TAIL_CAP ? next : next.slice(-TAIL_CAP);
}

/**
 * Fold one line into run state. Pure: the argument is never mutated.
 *
 * This is the single object a canvas, a CLI progress display and a hosted
 * dashboard all bind to. One fold, one set of rules about what a status means,
 * so the three of them cannot quietly disagree about whether a run is finished.
 *
 * Two lines are deliberately ignored rather than guessed at:
 *   - anything this reader does not understand, so a newer writer degrades to
 *     "no update" instead of an exception;
 *   - anything for a different `runId`, so folding a file that holds more than
 *     one run stays correct.
 */
export function reduceRun(state: RunState, event: TraceLine): RunState {
  if (event.type === "unknown" || event.runId !== state.runId) return state;

  switch (event.type) {
    case "run_started":
      return { ...state, status: "running", spec: event.spec };

    case "node_started":
      return withNode(state, event.node, (node) => {
        const instances =
          event.of === undefined
            ? node.instances
            : (node.instances ?? { done: 0, failed: 0, of: event.of });
        return {
          ...node,
          status: statusFor(instances) ?? "running",
          startedAt: node.startedAt ?? event.ts,
          instances,
        };
      });

    case "node_log":
      // A run-scoped line belongs to no node, and `RunState` has no run-scoped
      // tail. Read the trace file for those.
      if (event.node === undefined) return state;
      return withNode(state, event.node, (node) => ({
        ...node,
        tail: capTail(node.tail, event.line),
      }));

    case "node_finished":
      return withNode(state, event.node, (node) => {
        const instances = node.instances
          ? { ...node.instances, done: node.instances.done + 1 }
          : undefined;
        return {
          ...node,
          status: statusFor(instances) ?? "done",
          durationMs: mergeDuration(node.durationMs, event.durationMs, instances !== undefined),
          usage: mergeUsage(node.usage, event.usage),
          instances,
        };
      });

    case "node_failed":
      return withNode(state, event.node, (node) => {
        const instances = node.instances
          ? { ...node.instances, failed: node.instances.failed + 1 }
          : undefined;
        return {
          ...node,
          status: statusFor(instances) ?? "failed",
          durationMs: mergeDuration(node.durationMs, event.durationMs, instances !== undefined),
          error: event.error,
          instances,
        };
      });

    case "gate_waiting":
      return withNode(state, event.node, (node) => ({
        ...node,
        status: "waiting",
        startedAt: node.startedAt ?? event.ts,
      }));

    case "gate_resolved":
      return withNode(state, event.node, (node) => ({
        ...node,
        status: event.decision === "approve" ? "done" : "failed",
        // The note is the reviewer's own words. A rejection with no note gets no
        // error string rather than a sentence this package made up.
        error: event.decision === "reject" ? event.note : node.error,
      }));

    case "run_finished":
      // Nodes are left exactly as they are. A node still marked `running` here
      // never reported an end, and saying otherwise would be a guess.
      return { ...state, status: event.ok ? "done" : "failed" };
  }
}
