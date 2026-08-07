// SPDX-License-Identifier: Apache-2.0
import { rankGraph, type Graph, type NodeSpec } from "@ccgrapher/core";
import { TraceEvent } from "@ccgrapher/trace";
import {
  ExpectsError,
  messageOf,
  MissingGateResolverError,
  NodeTimeoutError,
} from "./errors.js";
import type {
  Arrival,
  Delivery,
  ExecuteOptions,
  NodeContext,
  NodeExecutor,
  NodeOutput,
  NodeReport,
  RunResult,
} from "./types.js";

/** An event minus the envelope, which is the engine's to fill in. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "v" | "runId" | "seq" | "ts"> : never;
type EventInput = WithoutEnvelope<TraceEvent>;

/** What one attempt at a node came back with. Never a rejection: `runOnce` catches its own. */
type Attempt = { ok: true; output: unknown } | { ok: false; error: string };

/**
 * Walk a graph and run it.
 *
 * The shape of the walk is not a choice this package makes. `rankGraph` already
 * decided which nodes can run together, and the whole premise of the repo is
 * that the picture and the execution are the same fact stated twice — so the
 * engine takes the ranks and runs each one as a wave. It does not consult
 * `@ccgrapher/codegen`, which computes its own stages from the same ranks; two
 * readers of one source cannot drift, but two implementations of one walk can.
 *
 * Everything that touches the world is injected: the executor, the gate
 * resolver, the clock, the event sink. There is no fs, no network, no process
 * and no `Date.now` of its own in here, which is what lets the same code run a
 * workflow on a laptop and inside a hosted service without a fork.
 *
 * Resolves with a `RunResult` for every ordinary outcome, including a run where
 * nodes failed. It rejects only when the run could not honestly continue: an
 * unmet `expects` guard, or a gate nobody can answer. In both cases
 * `run_finished` is emitted before the rejection, so a trace is never left
 * without an ending.
 */
export async function execute(
  graph: Graph,
  executor: NodeExecutor,
  options: ExecuteOptions,
): Promise<RunResult> {
  const now = options.now ?? Date.now;
  const args = options.args ?? {};
  const startedAt = now();
  const reports = new Map<string, NodeReport>();
  let seq = 0;

  /**
   * Stamps the envelope and hands the event on.
   *
   * Parsed rather than cast, exactly as `TraceWriter` does, so a bug in here
   * cannot hand a sink an event that readers of this same contract would
   * reject. `seq` advances only once the event is known good.
   */
  const emit = (input: EventInput): void => {
    const event = TraceEvent.parse({
      v: 1,
      runId: options.runId,
      seq,
      ts: new Date(now()).toISOString(),
      ...input,
    });
    seq += 1;
    options.emit(event);
  };

  emit({
    type: "run_started",
    spec: { name: graph.spec.name, hash: options.specHash },
    source: options.source ?? "ccg-run",
    args: options.args,
  });

  // Availability is a fact about the environment rather than about any one node,
  // so it is stated once, at the top, and only by a caller that actually looked.
  // An absent option emits nothing: silence reads as unreported, and a run that
  // volunteered "nothing was there" on nobody's authority would be the false
  // alarm the whole capability contract is built to avoid.
  for (const capability of options.capabilities ?? []) {
    emit({ type: "capability_available", capability });
  }

  /**
   * One attempt at a node, or at one instance of a fanned one.
   *
   * Swallows the executor's failure on purpose: a node that died is a fact about
   * the run, reported as `node_failed`, not an exception thrown at whoever
   * called `execute`. The decision about whether that failure matters belongs
   * further down the graph, where a node either can or cannot proceed without it.
   */
  const runOnce = async (
    node: NodeSpec,
    inputs: readonly Arrival[],
    instance?: number,
    of?: number,
  ): Promise<Attempt> => {
    const nodeStartedAt = now();
    emit({ type: "node_started", node: node.id, instance, of });

    const controller = new AbortController();
    const context: NodeContext = {
      runId: options.runId,
      node,
      inputs,
      args,
      instance,
      of,
      worktree: node.worktree === true,
      signal: controller.signal,
      log: (line) => emit({ type: "node_log", node: node.id, line }),
      capability: (id) =>
        emit({ type: "capability_invoked", capability: id, node: node.id, instance }),
    };

    let result: NodeOutput | void;
    try {
      result = await withTimeout(
        executor(context),
        options.timeoutMs,
        () => new NodeTimeoutError(node.id, options.timeoutMs ?? 0, instance),
        controller,
      );
    } catch (error) {
      const message = messageOf(error);
      emit({
        type: "node_failed",
        node: node.id,
        instance,
        durationMs: now() - nodeStartedAt,
        error: message,
      });
      return { ok: false, error: message };
    }

    // Outside the catch on purpose. A node that succeeded but whose usage figures
    // will not pass the trace contract is an executor bug, and it should surface
    // as one: caught here it would be emitted as `node_failed` on a node that
    // did its job, which is precisely the kind of mislabelling this repo exists
    // to stop.
    emit({
      type: "node_finished",
      node: node.id,
      instance,
      durationMs: now() - nodeStartedAt,
      output: result?.output,
      usage: result?.usage,
    });
    return { ok: true, output: result?.output };
  };

  /**
   * A gate emits `gate_waiting`, then whatever the human said. No `node_started`
   * and no `node_finished`: the fold treats `waiting` as explicitly not running,
   * and bracketing a gate with the ordinary node events would make a canvas draw
   * a human decision as work in progress.
   *
   * An approved gate passes its payload through unchanged. A gate is a
   * checkpoint, not a transform, so the data downstream sees is the data the
   * human looked at.
   */
  const runGate = async (node: NodeSpec, inputs: readonly Arrival[]): Promise<NodeReport> => {
    // A root gate has nothing upstream, so the arguments are all there is to show.
    const payload = inputs.length === 0 ? args : inputs.map((input) => input.output);

    // Checked before announcing the wait. A `gate_waiting` with no possible
    // `gate_resolved` would sit in a live view as "awaiting a human" forever,
    // when in truth nobody was ever going to be asked.
    if (!options.gate) throw new MissingGateResolverError(node.id);

    emit({ type: "gate_waiting", node: node.id, payload });
    const { decision, note } = await options.gate(node, payload);
    emit({ type: "gate_resolved", node: node.id, decision, note });

    if (decision === "approve") {
      return { id: node.id, outcome: "done", results: [{ output: payload }] };
    }
    // No results, so everything downstream is skipped for want of an input. That
    // is the rejection stopping the run rather than merely being recorded.
    return {
      id: node.id,
      outcome: "rejected",
      results: [],
      error: note ?? "rejected at gate",
    };
  };

  const runNode = async (node: NodeSpec): Promise<void> => {
    const inputs: Arrival[] = [];
    const absent: string[] = [];

    for (const edge of graph.inbound.get(node.id) ?? []) {
      const upstream = reports.get(edge.from);
      const delivered = upstream?.results ?? [];
      if (delivered.length === 0) {
        absent.push(edge.from);
        continue;
      }
      for (const delivery of delivered) {
        inputs.push({
          from: edge.from,
          instance: delivery.instance,
          fields: [...edge.carries],
          output: delivery.output,
        });
      }
    }

    /**
     * The guard, before anything else this node might do.
     *
     * Counted against what arrived, never against what the graph says should
     * have: a fanned upstream capped at five contributes five arrivals when all
     * five land and three when two of them died, which is precisely the case
     * `effectiveInboundCount` exists to make `expects` comparable across.
     *
     * Only a shortfall stops the run. More arrivals than declared means the
     * guard itself is miscounted, which is a defect in the spec for the linter
     * to report and not a reason to refuse to run data that is all present.
     * Both emitted guards test the same floor; `NodeSpec.expects` in
     * `@ccgrapher/core` is the statement all three answer to.
     */
    if (node.expects !== undefined && inputs.length < node.expects) {
      throw new ExpectsError(node.id, node.expects, inputs.length);
    }

    if (absent.length > 0) {
      // Not run with a hole in its input. An executor handed three of five
      // inputs and no way to tell would report on partial data as though it
      // were whole, which is the failure this project is about.
      const error = `skipped: no result from ${absent.join(", ")}`;
      emit({ type: "node_failed", node: node.id, error });
      reports.set(node.id, { id: node.id, outcome: "skipped", results: [], error });
      return;
    }

    if (node.kind === "gate") {
      reports.set(node.id, await runGate(node, inputs));
      return;
    }

    if (node.fanOut) {
      // `cap` is the only count the spec commits to. The item list lives inside
      // an upstream output whose shape this package deliberately knows nothing
      // about, so an uncapped fanOut runs once rather than having a count
      // guessed for it.
      const of = node.fanOut.cap ?? 1;
      const attempts = await Promise.all(
        Array.from({ length: of }, (_, instance) => runOnce(node, inputs, instance, of)),
      );

      const results: Delivery[] = [];
      const failures: string[] = [];
      attempts.forEach((attempt, instance) => {
        if (attempt.ok) results.push({ instance, output: attempt.output });
        else failures.push(attempt.error);
      });

      // Matches the fold's `partial`: some landed, some did not, and what landed
      // still goes downstream. Whether that is enough is `expects`'s question.
      const outcome = failures.length === 0 ? "done" : results.length === 0 ? "failed" : "partial";
      reports.set(node.id, {
        id: node.id,
        outcome,
        results,
        error: failures.length === 0 ? undefined : failures.join("; "),
      });
      return;
    }

    const attempt = await runOnce(node, inputs);
    reports.set(
      node.id,
      attempt.ok
        ? { id: node.id, outcome: "done", results: [{ output: attempt.output }] }
        : { id: node.id, outcome: "failed", results: [], error: attempt.error },
    );
  };

  let fatal: Error | undefined;

  for (const layer of rankGraph(graph).layers) {
    // `allSettled`, so one node blowing up does not cancel the siblings it has
    // no relationship with. They are on the same rank precisely because nothing
    // connects them, and killing them would invent a dependency the graph denies.
    const settled = await Promise.allSettled(
      layer.map((id) => runNode(graph.nodes.get(id)!)),
    );
    for (const outcome of settled) {
      if (outcome.status === "rejected" && fatal === undefined) {
        fatal = outcome.reason instanceof Error ? outcome.reason : new Error(messageOf(outcome.reason));
      }
    }
    if (fatal) break;
  }

  const problems = [...reports.values()].filter((report) => report.outcome !== "done");
  const ok = fatal === undefined && problems.length === 0;
  const durationMs = now() - startedAt;

  emit({
    type: "run_finished",
    ok,
    error: fatal?.message ?? summarise(problems),
    durationMs,
  });

  if (fatal) throw fatal;
  return { runId: options.runId, ok, durationMs, nodes: reports };
}

/** Names what went wrong without pretending a run with failures in it succeeded quietly. */
function summarise(problems: readonly NodeReport[]): string | undefined {
  if (problems.length === 0) return undefined;
  return `${problems.length} node(s) did not complete: ${problems
    .map((report) => `${report.id} (${report.outcome})`)
    .join(", ")}`;
}

/**
 * Race the work against a timer.
 *
 * The controller is aborted so an executor that watches `signal` can stop, but
 * the engine does not wait to find out whether it did. A node that ignores its
 * own timeout is already misbehaving, and blocking the rest of the run on it
 * would make one bad node able to hang everything.
 *
 * The timer is real rather than injected. The clock that stamps events is fake
 * in tests so an exact event stream can be asserted; a fake timer would also
 * need the executor's own waiting to be fake, and at that point the test is
 * exercising the harness instead of the race.
 */
function withTimeout<T>(
  work: Promise<T>,
  ms: number | undefined,
  error: () => Error,
  controller: AbortController,
): Promise<T> {
  if (ms === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeout = error();
      controller.abort(timeout);
      reject(timeout);
    }, ms);
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}
