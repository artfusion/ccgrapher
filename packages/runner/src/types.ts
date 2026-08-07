// SPDX-License-Identifier: Apache-2.0
import type { NodeSpec } from "@ccgrapher/core";
import type { TraceEvent, TraceSource, Usage } from "@ccgrapher/trace";

/**
 * One result a node handed onwards.
 *
 * `instance` is present only for a fanned node, and is the index of the instance
 * that produced it. A node that failed delivers nothing at all: there is no
 * `Delivery` carrying an error, because a downstream node must never be able to
 * mistake a failure for a value.
 */
export interface Delivery {
  readonly instance?: number;
  readonly output: unknown;
}

/**
 * One upstream result as it looks from the far end of an edge.
 *
 * `fields` is the edge's `carries`, repeated here so an executor can see which
 * of the upstream's outputs this edge claims to be for. Note that the engine
 * does not project the output down to those fields: `carries` is a declaration
 * the linter checks, and silently discarding data because a spec under-declared
 * it would be the graph editing the run.
 */
export interface Arrival {
  readonly from: string;
  readonly instance?: number;
  readonly fields: readonly string[];
  readonly output: unknown;
}

/**
 * Everything a node is given. Deliberately no filesystem, no repository, no
 * process: this is the whole of the engine's contact with the outside world, so
 * whatever wraps the engine decides what "running a node" actually means.
 */
export interface NodeContext {
  readonly runId: string;
  readonly node: NodeSpec;
  /** Only the results that genuinely arrived. Never padded, never holed. */
  readonly inputs: readonly Arrival[];
  /** The run's invocation arguments. The only input a root node has. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Present only for a fanned node: which instance this is, and how many there are. */
  readonly instance?: number;
  readonly of?: number;
  /**
   * The node asked for an isolated worktree.
   *
   * Passed through and nothing more. Creating one means shelling out to git,
   * which is exactly the sort of thing this package refuses to do; the wrapper
   * that owns a filesystem owns this.
   */
  readonly worktree: boolean;
  /** Aborted when the node's timeout expires. Honouring it is the executor's choice; the engine gives up either way. */
  readonly signal: AbortSignal;
  /** Emits a `node_log` line against this node. */
  readonly log: (line: string) => void;
  /**
   * Records that this node actually used a capability, as `capability_invoked`.
   *
   * Only the executor can know this. The engine sees a function call and has no
   * idea whether an MCP tool was reached inside it, so a node that used
   * something and did not say so is indistinguishable from one that did not use
   * it — which is why `NodeSpec.uses` is a claim and this is the evidence.
   */
  readonly capability: (id: string) => void;
}

/** What an executor hands back. Both fields optional: plenty of nodes have nothing useful to say. */
export interface NodeOutput {
  readonly output?: unknown;
  readonly usage?: Usage;
}

/**
 * The one injected thing that does real work.
 *
 * A rejection is a node failure and is reported as such. It never cancels the
 * node's siblings, and only stops the run at the point where something
 * downstream cannot honestly proceed without it.
 */
export type NodeExecutor = (context: NodeContext) => Promise<NodeOutput | void>;

export interface GateDecision {
  readonly decision: "approve" | "reject";
  readonly note?: string;
}

/**
 * Who answers a gate.
 *
 * Injected because the engine must never prompt anyone. A CLI can ask on a
 * terminal, a hosted service can hold the promise open across an HTTP round
 * trip, and a test can answer instantly, all without the engine knowing which.
 */
export type GateResolver = (node: NodeSpec, payload: unknown) => Promise<GateDecision>;

export interface ExecuteOptions {
  /** Stamped on every event. Required rather than generated: an id needs randomness, and this package has none. */
  readonly runId: string;
  /** Where events go. A file writer, an SSE stream and a test array are all the same shape. */
  readonly emit: (event: TraceEvent) => void;
  /** Epoch milliseconds. Injectable so a test can assert an exact `ts` and an exact `durationMs`. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Required if the graph has a `kind: gate` node; reaching one without it is fatal. */
  readonly gate?: GateResolver;
  /** Per node, and per instance of a fanned node. Absent means no timeout at all. */
  readonly timeoutMs?: number;
  /** The run's arguments, recorded on `run_started` and handed to every node. */
  readonly args?: Record<string, unknown>;
  /** Who is writing this trace. Defaults to `ccg-run`. */
  readonly source?: TraceSource;
  /** Identifies the exact spec text, so two runs of "the same" workflow can be told apart. */
  readonly specHash?: string;
  /**
   * Capabilities the caller verified were reachable when the run started, one
   * `capability_available` each.
   *
   * **Absent means unreported, never none.** A caller that did not look is not
   * saying the environment was empty, and this option gives it no way to say so
   * by accident: omit it and the run emits nothing at all, so a reader can still
   * tell "nobody checked" from "checked and found none".
   */
  readonly capabilities?: readonly string[];
}

/**
 * How a node ended.
 *
 * `partial` and `skipped` are the two that earn their place. `partial` is a
 * fanned node where some instances landed and some did not, and it still
 * delivers what it has, because the downstream `expects` guard is the thing that
 * decides whether that is enough. `skipped` is a node that never ran because
 * something it depends on delivered nothing, which is a different fact from the
 * node itself failing and should not be flattened into one.
 */
export type Outcome = "done" | "partial" | "failed" | "skipped" | "rejected";

export interface NodeReport {
  readonly id: string;
  readonly outcome: Outcome;
  /** What this node handed downstream. Empty for anything other than `done` or `partial`. */
  readonly results: readonly Delivery[];
  readonly error?: string;
}

export interface RunResult {
  readonly runId: string;
  /** True only when every node that ran ended `done`. A `partial` is not a success. */
  readonly ok: boolean;
  readonly durationMs: number;
  /** Nodes never reached, because the run stopped above them, are absent rather than invented. */
  readonly nodes: ReadonlyMap<string, NodeReport>;
}
