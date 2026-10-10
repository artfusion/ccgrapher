// SPDX-License-Identifier: Apache-2.0
import {
  effectivePriorities,
  expectsShortfall,
  PRIORITY_WEIGHT,
  rankGraph,
  type Graph,
  type NodeSpec,
} from "@ccgrapher/core";
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
import { readyOrder, type ReadyStep } from "./schedule.js";

/** An event minus the envelope, which is the engine's to fill in. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "v" | "runId" | "seq" | "ts"> : never;
type EventInput = WithoutEnvelope<TraceEvent>;

/** What one attempt at a node came back with. Never a rejection: `runOnce` catches its own. */
type Attempt = { ok: true; output: unknown } | { ok: false; error: string };

/** A ready step, together with what it will be handed when it gets a slot. */
interface Queued extends ReadyStep {
  readonly inputs: readonly Arrival[];
  readonly of?: number;
}

/**
 * Walk a graph and run it.
 *
 * A step starts the moment every node it has an edge from has settled and
 * delivered, not when the rest of its rank has finished. The ranks `rankGraph`
 * computes are still the truth about what *may* run together, and they order
 * the ready queue, but they are not a barrier: a step whose inputs arrived early
 * does not wait for a slow step it has no edge from. A barrier per rank would
 * spend exactly the time the linter exists to recover.
 *
 * `concurrency` bounds how many executor calls are in flight at once, and is
 * unbounded unless the caller says otherwise. When more is ready than there are
 * slots, `readyOrder` decides who goes next; it also fixes the order in which
 * steps that became ready together are started, so a run's trace is
 * reproducible. A node's `priority`, and the priority its ancestors inherit
 * from it, weigh in there and nowhere else: they reorder ready work, never
 * hold a step back from its inputs, and never interrupt a step once started.
 *
 * Everything that touches the world is injected: the executor, the gate
 * resolver, the clock, the event sink. There is no fs, no network, no process
 * and no `Date.now` of its own in here, which is what lets the same code run a
 * workflow on a laptop and inside a hosted service without a fork.
 *
 * Resolves with a `RunResult` for every ordinary outcome, including a run where
 * nodes failed. It rejects only when the run could not honestly continue: an
 * unmet `expects` guard, or a gate nobody can answer. From that point nothing
 * new starts, steps already running are allowed to finish and are reported, and
 * `run_finished` is emitted before the rejection, so a trace is never left
 * without an ending.
 */
export async function execute(
  graph: Graph,
  executor: NodeExecutor,
  options: ExecuteOptions,
): Promise<RunResult> {
  const { concurrency } = options;
  if (
    concurrency !== undefined &&
    concurrency !== Number.POSITIVE_INFINITY &&
    !(Number.isInteger(concurrency) && concurrency >= 1)
  ) {
    // Refused before `run_started`: a limit of zero would start nothing and
    // wait for ever, and that is not a run worth writing a trace for.
    throw new RangeError(`concurrency must be a whole number of at least 1, not ${concurrency}`);
  }
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
    // A raised priority is said on the start it may have moved, and only then,
    // so a run with no priority writes the trace it always did.
    const raised = priorities.get(node.id);
    emit({
      type: "node_started",
      node: node.id,
      instance,
      of,
      ...(raised && { priority: raised.priority }),
      ...(raised?.inheritedFrom !== undefined && { inheritedFrom: raised.inheritedFrom }),
      ...(raised?.setBy !== undefined && { prioritySetBy: raised.setBy }),
    });

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

  const { rank } = rankGraph(graph);
  const order = new Map([...graph.nodes.keys()].map((id, index) => [id, index]));
  const limit = options.concurrency ?? Number.POSITIVE_INFINITY;
  /** Raised priorities only; a spec without any leaves this empty and the run exactly as before. */
  const priorities = effectivePriorities(graph);

  /** For each node, how many of the distinct nodes it has an edge from have not settled yet. */
  const unsettled = new Map<string, number>();
  for (const id of graph.nodes.keys()) {
    unsettled.set(id, new Set((graph.inbound.get(id) ?? []).map((edge) => edge.from)).size);
  }

  const stepOf = (id: string, instance?: number): ReadyStep => {
    const raised = priorities.get(id);
    return {
      node: graph.nodes.get(id)!,
      rank: rank.get(id) ?? 0,
      order: order.get(id) ?? 0,
      instance,
      ...(raised && { priority: PRIORITY_WEIGHT[raised.priority] }),
    };
  };

  /** Ready and waiting for a slot. Reordered by `readyOrder` every time slots are handed out. */
  const queue: Queued[] = [];
  /** A fanned node's attempts by instance, until the last of them comes back. */
  const fanned = new Map<string, { attempts: Attempt[]; left: number }>();
  /** Executor calls in flight. This is what `concurrency` bounds. */
  let running = 0;
  /** Executor calls plus gates awaiting a decision. The run is over when this is zero and nothing is queued. */
  let open = 0;
  let fatal: Error | undefined;

  let drained!: () => void;
  const finished = new Promise<void>((resolve) => {
    drained = resolve;
  });

  /**
   * The run cannot honestly continue. Nothing new starts from here, and what is
   * queued is dropped, so it is absent from the result rather than invented.
   * What is already running is left to finish: abandoning it would leave a
   * `node_started` in the trace that nothing ever closes.
   */
  const stop = (error: unknown): void => {
    fatal ??= error instanceof Error ? error : new Error(messageOf(error));
    queue.length = 0;
  };

  /**
   * Every node this one has an edge from has settled, so decide what becomes
   * of it: stop the run on a short guard, skip it for want of an input, wait on
   * a gate, or queue it for a slot. Only the last of those takes a slot.
   */
  const admit = (node: NodeSpec): void => {
    if (fatal) return;
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
    if (node.expects !== undefined && expectsShortfall(node.expects, inputs.length)) {
      stop(new ExpectsError(node.id, node.expects, inputs.length));
      return;
    }

    if (absent.length > 0) {
      // Not run with a hole in its input. An executor handed three of five
      // inputs and no way to tell would report on partial data as though it
      // were whole, which is the failure this project is about. Reported the
      // moment it is known, not when unrelated work around it has finished.
      const error = `skipped: no result from ${absent.join(", ")}`;
      emit({ type: "node_failed", node: node.id, error });
      reports.set(node.id, { id: node.id, outcome: "skipped", results: [], error });
      settle(node.id);
      return;
    }

    if (node.kind === "gate") {
      // No slot: a human deciding is not work in progress. And only this gate's
      // own descendants wait on the answer, since nothing else has an edge from it.
      open += 1;
      void runGate(node, inputs)
        .then((report) => {
          reports.set(node.id, report);
          settle(node.id);
        })
        .catch(stop)
        .finally(() => {
          open -= 1;
          pump();
        });
      return;
    }

    if (!node.fanOut) {
      queue.push({ ...stepOf(node.id), inputs });
      return;
    }
    // `cap` is the only count the spec commits to. The item list lives inside
    // an upstream output whose shape this package deliberately knows nothing
    // about, so an uncapped fanOut runs once rather than having a count
    // guessed for it. Each instance is a step of its own and takes its own slot.
    const of = node.fanOut.cap ?? 1;
    fanned.set(node.id, { attempts: [], left: of });
    for (let instance = 0; instance < of; instance++) {
      queue.push({ ...stepOf(node.id, instance), inputs, of });
    }
  };

  /** A node has its report. Whatever was waiting only on it is admitted, in ready order. */
  const settle = (id: string): void => {
    const ready: ReadyStep[] = [];
    for (const to of new Set((graph.outbound.get(id) ?? []).map((edge) => edge.to))) {
      const left = unsettled.get(to)! - 1;
      unsettled.set(to, left);
      if (left === 0) ready.push(stepOf(to));
    }
    for (const step of ready.sort(readyOrder)) admit(step.node);
  };

  /** One executor call came back. A fanned node settles only when its last instance has. */
  const land = (step: Queued, attempt: Attempt): void => {
    const id = step.node.id;
    if (step.of === undefined) {
      reports.set(
        id,
        attempt.ok
          ? { id, outcome: "done", results: [{ output: attempt.output }] }
          : { id, outcome: "failed", results: [], error: attempt.error },
      );
      settle(id);
      return;
    }

    const fan = fanned.get(id)!;
    fan.attempts[step.instance ?? 0] = attempt;
    fan.left -= 1;
    if (fan.left > 0) return;

    const results: Delivery[] = [];
    const failures: string[] = [];
    fan.attempts.forEach((each, instance) => {
      if (each.ok) results.push({ instance, output: each.output });
      else failures.push(each.error);
    });

    // Matches the fold's `partial`: some landed, some did not, and what landed
    // still goes downstream. Whether that is enough is `expects`'s question.
    const outcome = failures.length === 0 ? "done" : results.length === 0 ? "failed" : "partial";
    reports.set(id, {
      id,
      outcome,
      results,
      error: failures.length === 0 ? undefined : failures.join("; "),
    });
    settle(id);
  };

  /**
   * Hand free slots to ready steps, best first. The only place work starts.
   *
   * `node_started` is emitted synchronously inside `runOnce`, so the order this
   * loop starts steps in is the order the trace records them.
   */
  const pump = (): void => {
    queue.sort(readyOrder);
    while (!fatal && running < limit && queue.length > 0) {
      const step = queue.shift()!;
      running += 1;
      open += 1;
      void runOnce(step.node, step.inputs, step.instance, step.of)
        .then((attempt) => land(step, attempt))
        // `runOnce` keeps the executor's failures to itself. What reaches here
        // is the engine refusing to record something, which is not survivable.
        .catch(stop)
        .finally(() => {
          running -= 1;
          open -= 1;
          pump();
        });
    }
    if (open === 0) drained();
  };

  const roots = [...graph.nodes.keys()].filter((id) => unsettled.get(id) === 0);
  for (const step of roots.map((id) => stepOf(id)).sort(readyOrder)) admit(step.node);
  pump();
  await finished;

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
