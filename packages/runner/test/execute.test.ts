// SPDX-License-Identifier: Apache-2.0
import { buildGraph, WorkflowSpec, type Graph, type NodeSpec } from "@ccgrapher/core";
import { emptyRunState, reduceRun, type TraceEvent } from "@ccgrapher/trace";
import { describe, expect, it } from "vitest";
import { ExpectsError, execute, MissingGateResolverError } from "../src/index.js";
import type { GateResolver, NodeContext, NodeExecutor } from "../src/index.js";

/**
 * A graph from the loosest possible shorthand. `WorkflowSpec.parse` fills the
 * `in`/`out` defaults, so a test only has to say the part it is about.
 */
function graphOf(
  nodes: ReadonlyArray<Record<string, unknown>>,
  edges: ReadonlyArray<Record<string, unknown>> = [],
): Graph {
  return buildGraph(WorkflowSpec.parse({ version: 1, name: "fixture", nodes, edges }));
}

const worker = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind: "worker",
  ...extra,
});

/** A clock that never moves. Every `ts` is identical and every duration is 0, which is
 *  exactly the case the contract says `seq` exists to disambiguate. */
const frozen = () => 1_000;
const FROZEN_TS = "1970-01-01T00:00:01.000Z";

/** One line per event, in the order the sink saw them. The stream is the product, so this
 *  is what most of these tests actually assert on. */
function lines(events: readonly TraceEvent[]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case "run_started":
        return `run_started ${event.spec.name}`;
      case "run_finished":
        return `run_finished ${event.ok ? "ok" : "not-ok"}`;
      case "node_started":
        return `node_started ${event.node}${event.of === undefined ? "" : ` ${event.instance}/${event.of}`}`;
      case "node_finished":
        return `node_finished ${event.node}${event.instance === undefined ? "" : ` ${event.instance}`}`;
      case "node_failed":
        return `node_failed ${event.node}${event.instance === undefined ? "" : ` ${event.instance}`}: ${event.error}`;
      case "node_log":
        return `node_log ${event.node}: ${event.line}`;
      case "gate_waiting":
        return `gate_waiting ${event.node}`;
      case "gate_resolved":
        return `gate_resolved ${event.node} ${event.decision}`;
    }
  });
}

/** An executor built from a table of per-node behaviours. Anything unlisted just succeeds. */
function executorOf(
  behaviours: Record<string, (context: NodeContext) => Promise<unknown>> = {},
  seen: string[] = [],
): NodeExecutor {
  return async (context) => {
    seen.push(context.node.id);
    const behaviour = behaviours[context.node.id];
    return { output: behaviour ? await behaviour(context) : `${context.node.id}-ok` };
  };
}

const collect = (): { events: TraceEvent[]; emit: (event: TraceEvent) => void } => {
  const events: TraceEvent[] = [];
  return { events, emit: (event) => events.push(event) };
};

describe("a run that goes to plan", () => {
  const graph = graphOf(
    [worker("split", { kind: "split" }), worker("a"), worker("b"), worker("join", { kind: "reduce" })],
    [
      { from: "split", to: "a", carries: ["seed"] },
      { from: "split", to: "b", carries: ["seed"] },
      { from: "a", to: "join", carries: ["found"] },
      { from: "b", to: "join", carries: ["found"] },
    ],
  );

  it("emits one wave per rank, in rank order", async () => {
    const { events, emit } = collect();
    const result = await execute(graph, executorOf(), {
      runId: "r1",
      emit,
      now: frozen,
      specHash: "abc123",
    });

    expect(lines(events)).toEqual([
      "run_started fixture",
      "node_started split",
      "node_finished split",
      // a and b share a rank, so both start before either finishes.
      "node_started a",
      "node_started b",
      "node_finished a",
      "node_finished b",
      "node_started join",
      "node_finished join",
      "run_finished ok",
    ]);
    expect(result.ok).toBe(true);
    expect(result.nodes.get("join")?.results).toEqual([{ output: "join-ok" }]);
  });

  it("owns the envelope: seq counts from zero, ts comes from the injected clock", async () => {
    const { events, emit } = collect();
    await execute(graph, executorOf(), { runId: "r1", emit, now: frozen });

    expect(events.map((event) => event.seq)).toEqual([...events.keys()]);
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set(["r1"]));
    expect(new Set(events.map((event) => event.ts))).toEqual(new Set([FROZEN_TS]));
  });

  it("hands each node only what actually reached it", async () => {
    const arrivals: Record<string, unknown> = {};
    const executor: NodeExecutor = async (context) => {
      arrivals[context.node.id] = context.inputs.map((input) => [input.from, input.fields, input.output]);
      return { output: `${context.node.id}!` };
    };
    const { emit } = collect();
    await execute(graph, executor, { runId: "r1", emit, now: frozen, args: { seed: 7 } });

    expect(arrivals["split"]).toEqual([]);
    expect(arrivals["a"]).toEqual([["split", ["seed"], "split!"]]);
    expect(arrivals["join"]).toEqual([
      ["a", ["found"], "a!"],
      ["b", ["found"], "b!"],
    ]);
  });

  it("agrees with the trace fold about what happened", async () => {
    const { events, emit } = collect();
    await execute(graph, executorOf(), { runId: "r1", emit, now: frozen });

    const state = events.reduce(reduceRun, emptyRunState("r1"));
    expect(state.status).toBe("done");
    expect(state.spec?.name).toBe("fixture");
    expect([...state.nodes.values()].map((node) => node.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("passes a node's log lines through as node_log", async () => {
    const { events, emit } = collect();
    const chain = graphOf([worker("only")]);
    await execute(
      chain,
      async (context) => {
        context.log("halfway");
        return { output: 1, usage: { model: "haiku", inputTokens: 10 } };
      },
      { runId: "r1", emit, now: frozen },
    );

    expect(lines(events)).toEqual([
      "run_started fixture",
      "node_started only",
      "node_log only: halfway",
      "node_finished only",
      "run_finished ok",
    ]);
    const finished = events.find((event) => event.type === "node_finished");
    expect(finished?.usage).toEqual({ model: "haiku", inputTokens: 10 });
  });
});

describe("a failure inside a rank", () => {
  const graph = graphOf(
    [worker("a"), worker("b"), worker("after-a"), worker("after-b")],
    [
      { from: "a", to: "after-a", carries: ["x"] },
      { from: "b", to: "after-b", carries: ["x"] },
    ],
  );

  it("does not cancel the siblings it has no relationship with", async () => {
    const seen: string[] = [];
    const { events, emit } = collect();
    const result = await execute(
      graph,
      executorOf(
        {
          a: async () => {
            throw new Error("upstream said no");
          },
        },
        seen,
      ),
      { runId: "r1", emit, now: frozen },
    );

    expect(seen).toEqual(["a", "b", "after-b"]);
    const emitted = lines(events);
    expect(emitted.slice(0, 3)).toEqual(["run_started fixture", "node_started a", "node_started b"]);
    // Which of two unrelated nodes lands first is not something the engine promises,
    // and asserting an order here would be asserting a fact about the fake executor.
    expect(emitted.slice(3, 5).sort()).toEqual(
      ["node_failed a: upstream said no", "node_finished b"].sort(),
    );
    expect(emitted.slice(5)).toEqual([
      // `after-a` never starts. Its input never arrived, so there is nothing to run it on.
      "node_failed after-a: skipped: no result from a",
      "node_started after-b",
      "node_finished after-b",
      "run_finished not-ok",
    ]);
    expect(result.ok).toBe(false);
    expect(result.nodes.get("b")?.outcome).toBe("done");
    expect(result.nodes.get("after-b")?.outcome).toBe("done");
  });

  it("reports a skip as a skip, not as a failure of its own", async () => {
    const { emit } = collect();
    const result = await execute(
      graph,
      executorOf({
        a: async () => {
          throw new Error("upstream said no");
        },
      }),
      { runId: "r1", emit, now: frozen },
    );

    expect(result.nodes.get("a")?.outcome).toBe("failed");
    expect(result.nodes.get("after-a")).toEqual({
      id: "after-a",
      outcome: "skipped",
      results: [],
      error: "skipped: no result from a",
    });
  });

  it("names the unfinished nodes on run_finished", async () => {
    const { events, emit } = collect();
    await execute(
      graph,
      executorOf({
        a: async () => {
          throw new Error("upstream said no");
        },
      }),
      { runId: "r1", emit, now: frozen },
    );

    const finished = events.find((event) => event.type === "run_finished");
    expect(finished?.error).toBe("2 node(s) did not complete: a (failed), after-a (skipped)");
  });
});

describe("the expects guard", () => {
  const fanIn = graphOf(
    [worker("a"), worker("b"), worker("join", { kind: "reduce", expects: 2 })],
    [
      { from: "a", to: "join", carries: ["x"] },
      { from: "b", to: "join", carries: ["x"] },
    ],
  );

  it("ends the run rather than logging it", async () => {
    const seen: string[] = [];
    const { events, emit } = collect();

    const run = execute(
      fanIn,
      executorOf(
        {
          a: async () => {
            throw new Error("died");
          },
        },
        seen,
      ),
      { runId: "r1", emit, now: frozen },
    );

    // The whole point: a shortfall is not survivable. If this were a log line the
    // promise would resolve and `join` would have run on half the data.
    await expect(run).rejects.toBeInstanceOf(ExpectsError);
    await expect(run).rejects.toThrow("join: expected 2 upstream result(s), got 1");
    expect(seen).not.toContain("join");
  });

  it("carries the counts, and closes the trace before it throws", async () => {
    const { events, emit } = collect();
    const error = await execute(
      fanIn,
      executorOf({
        a: async () => {
          throw new Error("died");
        },
      }),
      { runId: "r1", emit, now: frozen },
    ).catch((thrown: unknown) => thrown as ExpectsError);

    expect(error).toMatchObject({ node: "join", expected: 2, actual: 1 });

    const last = events[events.length - 1];
    expect(last?.type).toBe("run_finished");
    expect(last).toMatchObject({ ok: false, error: "join: expected 2 upstream result(s), got 1" });
    // No `node_started join`, and no `node_failed join` dressed up as an ordinary failure.
    expect(lines(events).filter((line) => line.includes("join"))).toEqual([]);
  });

  it("counts arrivals, not edges: a partial fanOut is a shortfall", async () => {
    const graph = graphOf(
      [
        worker("split", { kind: "split" }),
        worker("fan", { fanOut: { over: "items", cap: 3 } }),
        worker("join", { kind: "reduce", expects: 3 }),
      ],
      [
        { from: "split", to: "fan", carries: ["items"] },
        { from: "fan", to: "join", carries: ["x"] },
      ],
    );
    const { emit } = collect();

    await expect(
      execute(
        graph,
        async (context) => {
          if (context.node.id === "fan" && context.instance === 1) throw new Error("instance died");
          return { output: context.node.id };
        },
        { runId: "r1", emit, now: frozen },
      ),
    ).rejects.toThrow("join: expected 3 upstream result(s), got 2");
  });

  it("lets a satisfied guard through untouched", async () => {
    const { emit } = collect();
    const result = await execute(fanIn, executorOf(), { runId: "r1", emit, now: frozen });
    expect(result.ok).toBe(true);
  });
});

describe("gates", () => {
  const graph = graphOf(
    [worker("draft"), worker("review", { kind: "gate" }), worker("ship")],
    [
      { from: "draft", to: "review", carries: ["text"] },
      { from: "review", to: "ship", carries: ["text"] },
    ],
  );

  const approve: GateResolver = async () => ({ decision: "approve" });
  const reject: GateResolver = async (_node: NodeSpec) => ({
    decision: "reject",
    note: "not good enough",
  });

  it("waits, then continues when approved", async () => {
    const seen: string[] = [];
    const { events, emit } = collect();
    const result = await execute(graph, executorOf({}, seen), {
      runId: "r1",
      emit,
      now: frozen,
      gate: approve,
    });

    expect(lines(events)).toEqual([
      "run_started fixture",
      "node_started draft",
      "node_finished draft",
      // No node_started for the gate: waiting is not work.
      "gate_waiting review",
      "gate_resolved review approve",
      "node_started ship",
      "node_finished ship",
      "run_finished ok",
    ]);
    expect(seen).toEqual(["draft", "ship"]);
    expect(result.ok).toBe(true);
  });

  it("shows the human what it is approving, and passes it through unchanged", async () => {
    const shown: unknown[] = [];
    const { emit } = collect();
    const downstream: unknown[] = [];

    await execute(
      graph,
      async (context) => {
        if (context.node.id === "ship") downstream.push(context.inputs.map((i) => i.output));
        return { output: "the draft" };
      },
      {
        runId: "r1",
        emit,
        now: frozen,
        gate: async (_node, payload) => {
          shown.push(payload);
          return { decision: "approve" };
        },
      },
    );

    expect(shown).toEqual([["the draft"]]);
    expect(downstream).toEqual([[["the draft"]]]);
  });

  it("stops the downstream when rejected", async () => {
    const seen: string[] = [];
    const { events, emit } = collect();
    const result = await execute(graph, executorOf({}, seen), {
      runId: "r1",
      emit,
      now: frozen,
      gate: reject,
    });

    expect(lines(events)).toEqual([
      "run_started fixture",
      "node_started draft",
      "node_finished draft",
      "gate_waiting review",
      "gate_resolved review reject",
      "node_failed ship: skipped: no result from review",
      "run_finished not-ok",
    ]);
    expect(seen).toEqual(["draft"]);
    expect(result.ok).toBe(false);
    expect(result.nodes.get("review")).toMatchObject({
      outcome: "rejected",
      error: "not good enough",
    });

    // The fold reads the same stream the same way.
    const state = events.reduce(reduceRun, emptyRunState("r1"));
    expect(state.nodes.get("review")?.status).toBe("failed");
    expect(state.nodes.get("review")?.error).toBe("not good enough");
  });

  it("refuses to pretend nobody answered was a rejection", async () => {
    const { events, emit } = collect();
    await expect(
      execute(graph, executorOf(), { runId: "r1", emit, now: frozen }),
    ).rejects.toBeInstanceOf(MissingGateResolverError);

    // Nothing claimed to be waiting on a human who was never going to be asked.
    expect(lines(events)).not.toContain("gate_waiting review");
    expect(events[events.length - 1]).toMatchObject({
      type: "run_finished",
      ok: false,
      error: "review: gate reached but no gate resolver was supplied",
    });
  });
});

describe("fanOut", () => {
  const graph = graphOf([worker("fan", { fanOut: { over: "items", cap: 3 } })]);

  it("runs cap instances and tells the reader how many to expect", async () => {
    const { events, emit } = collect();
    const result = await execute(
      graph,
      async (context) => {
        if (context.instance === 1) throw new Error("instance died");
        return { output: `item-${context.instance}` };
      },
      { runId: "r1", emit, now: frozen },
    );

    expect(lines(events)).toEqual([
      "run_started fixture",
      "node_started fan 0/3",
      "node_started fan 1/3",
      "node_started fan 2/3",
      "node_finished fan 0",
      "node_failed fan 1: instance died",
      "node_finished fan 2",
      "run_finished not-ok",
    ]);

    // Partial, not failed: what landed still goes downstream, and it is the
    // downstream guard's job to say whether two of three is enough.
    expect(result.nodes.get("fan")).toEqual({
      id: "fan",
      outcome: "partial",
      results: [
        { instance: 0, output: "item-0" },
        { instance: 2, output: "item-2" },
      ],
      error: "instance died",
    });
    expect(result.ok).toBe(false);
  });

  it("folds to `partial` in the trace contract too", async () => {
    const { events, emit } = collect();
    await execute(
      graph,
      async (context) => {
        if (context.instance === 1) throw new Error("instance died");
        return { output: context.instance };
      },
      { runId: "r1", emit, now: frozen },
    );

    const state = events.reduce(reduceRun, emptyRunState("r1"));
    expect(state.nodes.get("fan")?.instances).toEqual({ done: 2, failed: 1, of: 3 });
    expect(state.nodes.get("fan")?.status).toBe("failed");
  });

  it("delivers every instance downstream when they all land", async () => {
    const wide = graphOf(
      [worker("fan", { fanOut: { over: "items", cap: 3 } }), worker("join", { kind: "reduce" })],
      [{ from: "fan", to: "join", carries: ["x"] }],
    );
    const { emit } = collect();
    const arrivals: unknown[] = [];

    const result = await execute(
      wide,
      async (context) => {
        if (context.node.id === "join") arrivals.push(context.inputs.map((i) => [i.from, i.instance]));
        return { output: context.instance ?? "join" };
      },
      { runId: "r1", emit, now: frozen },
    );

    expect(arrivals).toEqual([
      [
        ["fan", 0],
        ["fan", 1],
        ["fan", 2],
      ],
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails the node outright when no instance survives", async () => {
    const { emit } = collect();
    const result = await execute(
      graph,
      async () => {
        throw new Error("all dead");
      },
      { runId: "r1", emit, now: frozen },
    );
    expect(result.nodes.get("fan")).toMatchObject({ outcome: "failed", results: [] });
  });

  it("runs an uncapped fanOut once rather than guessing a count", async () => {
    const uncapped = graphOf([worker("fan", { fanOut: { over: "items" } })]);
    const { events, emit } = collect();
    await execute(uncapped, executorOf(), { runId: "r1", emit, now: frozen });
    expect(lines(events)).toContain("node_started fan 0/1");
  });
});

describe("the per-node timeout", () => {
  /** Waits, but gives up the moment the engine gives up on it, so a stray timer cannot outlive the test. */
  const slow: NodeExecutor = async (context) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      context.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { output: "eventually" };
  };

  it("fails the node with an error that says what happened", async () => {
    const graph = graphOf([worker("slow"), worker("quick")]);
    const { events, emit } = collect();
    const result = await execute(
      graph,
      async (context) => (context.node.id === "slow" ? slow(context) : { output: "fast" }),
      { runId: "r1", emit, now: frozen, timeoutMs: 10 },
    );

    expect(lines(events)).toEqual([
      "run_started fixture",
      "node_started slow",
      "node_started quick",
      "node_finished quick",
      "node_failed slow: slow: timed out after 10ms",
      "run_finished not-ok",
    ]);
    expect(result.nodes.get("slow")?.outcome).toBe("failed");
    expect(result.nodes.get("quick")?.outcome).toBe("done");
  });

  it("aborts the node's signal so a well-behaved executor can stop", async () => {
    const graph = graphOf([worker("slow")]);
    const { emit } = collect();
    let aborted = false;
    await execute(
      graph,
      async (context) => {
        context.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return slow(context);
      },
      { runId: "r1", emit, now: frozen, timeoutMs: 10 },
    );
    expect(aborted).toBe(true);
  });

  it("leaves a node alone when no timeout was configured", async () => {
    const graph = graphOf([worker("only")]);
    const { emit } = collect();
    const result = await execute(graph, executorOf(), { runId: "r1", emit, now: frozen });
    expect(result.ok).toBe(true);
  });
});

describe("what the engine refuses to do", () => {
  it("passes worktree through without acting on it", async () => {
    const graph = graphOf([worker("isolated", { worktree: true }), worker("shared")]);
    const { emit } = collect();
    const flags: Record<string, boolean> = {};

    await execute(
      graph,
      async (context) => {
        flags[context.node.id] = context.worktree;
        return { output: null };
      },
      { runId: "r1", emit, now: frozen },
    );

    expect(flags).toEqual({ isolated: true, shared: false });
  });

  it("uses the injected clock for durations, never a clock of its own", async () => {
    let ticks = 0;
    const graph = graphOf([worker("only")]);
    const { events, emit } = collect();
    const result = await execute(graph, executorOf(), {
      runId: "r1",
      emit,
      now: () => (ticks += 100),
    });

    // 100 run start, 200 run_started ts, 300 node start, ... every reading is the fake one.
    expect(result.durationMs).toBeGreaterThan(0);
    expect(events.every((event) => event.ts.startsWith("1970-01-01T00:00:0"))).toBe(true);
  });
});
